// ---------------------------------------------------------------------------
// toolhub — Document Indexer
// ---------------------------------------------------------------------------
// Handles validation and normalization of incoming documents before they
// are passed to the search adapter. This is the ingestion boundary — all
// data entering the search index goes through here.
//
// Indexing pipeline (D1/D2):
//   1. normalize every document (caps, url sanitation, tags)
//   2. build server-overview semantic texts (no tool dumps — tools live in
//      the dedicated tool index, see tool-indexer.ts)
//   3. embed ALL texts in one batched embedMany() call (chunking, pooling,
//      retries, rate limits handled by the embedder)
//   4. documents whose embedding ultimately fails are still indexed with a
//      warning — they remain lexically searchable without a vector
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { SearchAdapter, SearchDocument } from "./adapters/types.js";
import type { EmbeddingProvider } from "./embedder.js";
import { buildToolDocuments, buildToolDocumentsForServer } from "./tool-indexer.js";

/** Allowed characters in mcp_name: lowercase alphanumeric, hyphens, underscores, dots, and slashes. */
const MCP_NAME_REGEXP = /^[a-z0-9][a-z0-9._\/-]{0,127}$/;

/** Maximum number of tags per document. */
const MAX_TAGS = 20;

/** Maximum length for text fields. */
const MAX_DISPLAY_NAME_LENGTH = 256;

export interface IndexBatchResult {
  /** Documents successfully indexed (with or without a vector). */
  indexed: number;
  /** Indexed documents whose embedding failed (lexically searchable only). */
  indexedWithoutVector: number;
  /** Invalid documents skipped during validation. */
  skipped: number;
  /** Tool documents created/updated for the upserted servers. */
  toolsIndexed: number;
}

export interface IndexerOptions {
  /** Cap for the stored/displayed/searchable description. */
  maxDescriptionChars?: number;
  /** Cap for the semantic text used for embedding (cost/latency bound). */
  maxSemanticChars?: number;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

export class Indexer {
  readonly adapter: SearchAdapter;

  constructor(
    adapter: SearchAdapter,
    private readonly embedder: EmbeddingProvider,
    private readonly logger: Pick<Console, "info" | "warn" | "error"> = console,
    private readonly options: IndexerOptions = {},
  ) {
    this.adapter = adapter;
  }

  private get maxDescriptionChars(): number {
    return this.options.maxDescriptionChars ?? envPositiveInt("TOOLHUB_MAX_DESCRIPTION_CHARS", 4096);
  }

  private get maxSemanticChars(): number {
    return this.options.maxSemanticChars ?? envPositiveInt("TOOLHUB_MAX_SEMANTIC_CHARS", 16000);
  }

  /**
   * Validate, normalize, and index a batch of documents.
   * Invalid documents are skipped with a warning. Semantic texts are built,
   * embedded in one batched call, and — when the tool index is enabled —
   * each upserted server's tool documents are rebuilt from its capabilities.
   */
  async indexBatch(rawDocuments: unknown[], rebuildTools = true): Promise<IndexBatchResult> {
    const { valid, skipped } = this.validateAll(rawDocuments);
    if (valid.length === 0) {
      this.logger.warn("[indexer] No valid documents in batch, skipping");
      return { indexed: 0, indexedWithoutVector: 0, skipped, toolsIndexed: 0 };
    }

    // Embed everything in one batched call
    const vectors = await this.embedder.embedMany(
      valid.map((doc) => doc.semantic_text ?? ""),
      "document",
    );

    let indexedWithoutVector = 0;
    for (let i = 0; i < valid.length; i++) {
      const doc = valid[i];
      doc.content_hash = computeContentHash(doc);
      const vector = vectors[i];
      if (vector) {
        doc._vectors = { default: vector };
        doc.has_vector = true;
      } else {
        indexedWithoutVector++;
        if (this.embedder.provider !== "null" && this.embedder.dimensions > 0) {
          this.logger.warn(`[indexer] No vector for "${doc.mcp_name}" — indexed lexically only`);
        }
      }
    }

    await this.adapter.index(valid);

    let toolsIndexed = 0;
    if (rebuildTools && this.adapter.toolIndexEnabled) {
      toolsIndexed = await this.rebuildToolsForServers(valid);
    }

    this.logger.info(
      `[indexer] Indexed ${valid.length} documents (${skipped} skipped, ${indexedWithoutVector} without vector, ${toolsIndexed} tools)`
    );
    return { indexed: valid.length, indexedWithoutVector, skipped, toolsIndexed };
  }

  /**
   * Index a single document. Throws if the document is invalid.
   * Automatically builds the semantic text and computes the vector.
   */
  async indexOne(raw: unknown): Promise<SearchDocument> {
    const doc = this.normalizeDocument(raw, 0);
    if (!doc) {
      throw new Error("Invalid document: failed validation");
    }

    doc.semantic_text = this.buildSemanticText(doc);
    const vector = await this.embedder.embedDocument(doc.semantic_text);
    if (vector) {
      doc._vectors = { default: vector };
      doc.has_vector = true;
    }
    doc.content_hash = computeContentHash(doc);

    await this.adapter.index([doc]);
    if (this.adapter.toolIndexEnabled) {
      await this.rebuildToolsForServers([doc]);
    }
    return doc;
  }

  /**
   * Remove a document by mcp_name (cascades to its tool documents).
   */
  async remove(mcpName: string): Promise<void> {
    const normalized = mcpName.trim().toLowerCase();
    if (!MCP_NAME_REGEXP.test(normalized)) {
      throw new Error(`Invalid mcp_name: "${mcpName}"`);
    }
    if (this.adapter.toolIndexEnabled) {
      await this.adapter.removeToolsByServer(normalized);
    }
    await this.adapter.remove(normalized);
    this.logger.info(`[indexer] Removed document: ${normalized}`);
  }

  /**
   * Full reindex: clear both indexes and re-import all provided documents.
   *
   * Unlike the incremental path (indexBatch → rebuildToolsForServers, which
   * must remove+rebuild per server because the tool index is shared), a full
   * reindex has already cleared the tool index, so all tool documents are
   * built from the fresh batch in ONE batched embed + ONE bulk add. This is
   * what makes reindexing a real catalog (hundreds of servers, thousands of
   * tools) feasible — the per-server loop would otherwise serialize hundreds
   * of MeiliSearch task round-trips and embed calls.
   */
  async reindex(rawDocuments: unknown[]): Promise<IndexBatchResult> {
    await this.adapter.clear();
    if (this.adapter.toolIndexEnabled) {
      await this.adapter.clearTools();
    }

    const { valid, skipped } = this.validateAll(rawDocuments);
    if (valid.length === 0) {
      this.logger.warn("[indexer] No valid documents in batch, skipping");
      return { indexed: 0, indexedWithoutVector: 0, skipped, toolsIndexed: 0 };
    }

    // Embed + index server documents (one batched call).
    let indexedWithoutVector = 0;
    const vectors = await this.embedder.embedMany(
      valid.map((doc) => doc.semantic_text ?? ""),
      "document",
    );
    for (let i = 0; i < valid.length; i++) {
      const doc = valid[i];
      doc.content_hash = computeContentHash(doc);
      const vector = vectors[i];
      if (vector) {
        doc._vectors = { default: vector };
        doc.has_vector = true;
      } else {
        indexedWithoutVector++;
        if (this.embedder.provider !== "null" && this.embedder.dimensions > 0) {
          this.logger.warn(`[indexer] No vector for "${doc.mcp_name}" — indexed lexically only`);
        }
      }
    }
    await this.adapter.index(valid);

    // Build + embed + bulk-add ALL tool documents in one go.
    let toolsIndexed = 0;
    if (this.adapter.toolIndexEnabled) {
      const docs = buildToolDocuments(valid, {
        maxToolsEmbedded: envPositiveInt("TOOLHUB_MAX_TOOLS_EMBEDDED", 64),
        maxToolDescChars: envPositiveInt("TOOLHUB_MAX_TOOL_DESC_CHARS", 1200),
        maxToolSchemaChars: envPositiveInt("TOOLHUB_MAX_TOOL_SCHEMA_CHARS", 1200),
        maxToolSemanticChars: envPositiveInt("TOOLHUB_MAX_TOOL_SEMANTIC_CHARS", 8000),
      });
      if (docs.length > 0) {
        const toolVectors = await this.embedder.embedMany(
          docs.map((doc) => doc.semantic_text ?? ""),
          "document",
        );
        for (let i = 0; i < docs.length; i++) {
          const vector = toolVectors[i];
          if (vector) {
            docs[i]._vectors = { default: vector };
            docs[i].has_vector = true;
          } else if (this.embedder.provider !== "null" && this.embedder.dimensions > 0) {
            this.logger.warn(`[indexer] No vector for tool "${docs[i].tool_name}" of "${docs[i].server_mcp_name}"`);
          }
        }
        await this.adapter.indexTools(docs);
        toolsIndexed = docs.length;
      }
    }

    this.logger.info(
      `[indexer] Indexed ${valid.length} documents (${skipped} skipped, ${indexedWithoutVector} without vector, ${toolsIndexed} tools)`
    );
    return { indexed: valid.length, indexedWithoutVector, skipped, toolsIndexed };
  }

  /**
   * Validate + normalize a batch and build semantic texts. Shared by the
   * incremental and full-reindex paths.
   */
  private validateAll(rawDocuments: unknown[]): { valid: SearchDocument[]; skipped: number } {
    const valid: SearchDocument[] = [];
    for (let i = 0; i < rawDocuments.length; i++) {
      const raw = rawDocuments[i];
      const doc = this.normalizeDocument(raw, i);
      if (doc) {
        doc.semantic_text = this.buildSemanticText(doc);
        valid.push(doc);
      }
    }
    return { valid, skipped: rawDocuments.length - valid.length };
  }

  /**
   * Rebuilds tool documents for the given server documents: deletes the
   * server's existing tool docs and re-creates them from capabilities,
   * embedding all tool texts in one batched call.
   */
  private async rebuildToolsForServers(servers: SearchDocument[]): Promise<number> {
    let total = 0;
    for (const server of servers) {
      const docs = buildToolDocumentsForServer(server);
      if (docs.length === 0) continue;

      await this.adapter.removeToolsByServer(server.mcp_name);

      const vectors = await this.embedder.embedMany(
        docs.map((doc) => doc.semantic_text ?? ""),
        "document",
      );
      for (let i = 0; i < docs.length; i++) {
        const vector = vectors[i];
        if (vector) {
          docs[i]._vectors = { default: vector };
          docs[i].has_vector = true;
        } else if (this.embedder.provider !== "null" && this.embedder.dimensions > 0) {
          this.logger.warn(`[indexer] No vector for tool "${docs[i].tool_name}" of "${server.mcp_name}"`);
        }
      }
      await this.adapter.indexTools(docs);
      total += docs.length;
    }
    return total;
  }

  // ---------------------------------------------------------------------------
  // Validation & Normalization
  // ---------------------------------------------------------------------------

  private normalizeDocument(raw: unknown, index: number): SearchDocument | null {
    if (!isRecord(raw)) {
      this.logger.warn(`[indexer] Document at index ${index} is not an object, skipping`);
      return null;
    }

    const mcpName = nonEmptyString(raw.mcp_name)?.toLowerCase();
    if (!mcpName || !MCP_NAME_REGEXP.test(mcpName)) {
      this.logger.warn(`[indexer] Document at index ${index} has invalid mcp_name, skipping`);
      return null;
    }

    const displayName = nonEmptyString(raw.display_name);
    if (!displayName) {
      this.logger.warn(`[indexer] Document "${mcpName}" has no display_name, skipping`);
      return null;
    }

    return {
      mcp_name: mcpName,
      display_name: truncate(displayName, MAX_DISPLAY_NAME_LENGTH) as string,
      description: truncate(nonEmptyString(raw.description), this.maxDescriptionChars),
      tags: normalizeTags(raw.tags),
      provider: nonEmptyString(raw.provider),
      docs_url: sanitizeUrl(nonEmptyString(raw.docs_url)),
      homepage_url: sanitizeUrl(nonEmptyString(raw.homepage_url)),
      base_url: sanitizeUrl(nonEmptyString(raw.base_url)),
      protocol_version: nonEmptyString(raw.protocol_version),
      capabilities: isRecord(raw.capabilities) ? raw.capabilities : undefined,
      health_status: normalizeHealthStatus(raw.health_status),
      updated_at: nonEmptyString(raw.updated_at) ?? new Date().toISOString(),
    };
  }

  /**
   * Server-overview semantic text (D7): display name + provider + description
   * + tags + top tool names. Detailed tool content lives in the tool index.
   * Bounded by TOOLHUB_MAX_SEMANTIC_CHARS (the embedder chunks beyond the
   * model budget, but the cap bounds cost for pathological descriptions).
   */
  private buildSemanticText(doc: SearchDocument): string {
    const providerStr = doc.provider ? ` by ${doc.provider}` : "";
    const tagsStr = doc.tags.length > 0 ? `. Tags: ${doc.tags.join(", ")}` : "";

    let capabilitiesStr = "";
    if (doc.capabilities) {
      const tools = (doc.capabilities as Record<string, unknown>).tools;
      const toolNames = Array.isArray(tools)
        ? tools
            .map((t: any) => (t && typeof t === "object" && typeof t.name === "string" ? t.name : ""))
            .filter(Boolean)
        : [];
      if (toolNames.length > 0) {
        capabilitiesStr = `. Tools: ${toolNames.join(", ")}`;
      }
    }

    const text = `${doc.display_name}${providerStr}. ${doc.description || ""}${tagsStr}${capabilitiesStr}`;
    if (text.length > this.maxSemanticChars) {
      this.logger.warn(
        `[indexer] Semantic text for "${doc.mcp_name}" exceeds ${this.maxSemanticChars} chars (${text.length}) — truncating`
      );
      return truncateCodePoints(text, this.maxSemanticChars);
    }
    return text;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function truncateCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join("");
}

function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const v = item.trim().toLowerCase();
    if (!v) continue;
    out.add(v);
    if (out.size >= MAX_TAGS) break;
  }
  return [...out];
}

function normalizeHealthStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  return v;
}

function sanitizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    let url = value;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "http://" + url;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Stable content hash over the normalized document fields (excluding
 * volatile/derived fields like vectors, semantic text and timestamps).
 * Used by incremental sync diagnostics.
 */
export function computeContentHash(doc: SearchDocument): string {
  const { semantic_text, _vectors, content_hash, has_vector, id, updated_at, ...rest } = doc;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(rest)))
    .digest("hex")
    .slice(0, 16);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue;
      sorted[key] = canonicalize(v);
    }
    return sorted;
  }
  return value;
}
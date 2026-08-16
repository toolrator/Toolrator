// ---------------------------------------------------------------------------
// toolhub — Document Indexer
// ---------------------------------------------------------------------------
// Handles validation and normalization of incoming documents before they
// are passed to the search adapter. This is the ingestion boundary — all
// data entering the search index goes through here.
// ---------------------------------------------------------------------------

import type { SearchAdapter, SearchDocument } from "./adapters/types.js";
import type { Embedder } from "./embedder.js";

/** Allowed characters in mcp_name: lowercase alphanumeric, hyphens, underscores, dots, and slashes. */
const MCP_NAME_REGEXP = /^[a-z0-9][a-z0-9._\/-]{0,127}$/;

/** Maximum number of tags per document. */
const MAX_TAGS = 20;

/** Maximum length for text fields. */
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4096;

export class Indexer {
  readonly adapter: SearchAdapter;

  constructor(
    adapter: SearchAdapter,
    private readonly embedder: Embedder,
    private readonly logger: Pick<Console, "info" | "warn" | "error"> = console,
  ) {
    this.adapter = adapter;
  }

  /**
   * Validate, normalize, and index a batch of documents.
   * Invalid documents are skipped with a warning.
   * Automatically builds semantic texts and computes vector embeddings.
   *
   * @returns The number of documents successfully indexed.
   */
  async indexBatch(rawDocuments: unknown[]): Promise<number> {
    const valid: SearchDocument[] = [];

    for (let i = 0; i < rawDocuments.length; i++) {
      const raw = rawDocuments[i];
      const doc = this.normalizeDocument(raw, i);
      if (doc) {
        // Build semantic text representation
        doc.semantic_text = buildSemanticText(doc);
        
        // Generate embedding vector
        try {
          const vector = await this.embedder.embedDocument(doc.semantic_text);
          doc._vectors = {
            default: vector,
          };
        } catch (err) {
          this.logger.error(`[indexer] Failed to generate embedding for ${doc.mcp_name}:`, err);
        }
        
        valid.push(doc);
      }
    }

    if (valid.length === 0) {
      this.logger.warn("[indexer] No valid documents in batch, skipping");
      return 0;
    }

    await this.adapter.index(valid);
    this.logger.info(`[indexer] Indexed ${valid.length} documents (${rawDocuments.length - valid.length} skipped)`);
    return valid.length;
  }

  /**
   * Index a single document. Throws if the document is invalid.
   * Automatically builds semantic texts and computes vector embeddings.
   */
  async indexOne(raw: unknown): Promise<SearchDocument> {
    const doc = this.normalizeDocument(raw, 0);
    if (!doc) {
      throw new Error("Invalid document: failed validation");
    }
    
    doc.semantic_text = buildSemanticText(doc);
    try {
      const vector = await this.embedder.embedDocument(doc.semantic_text);
      doc._vectors = {
        default: vector,
      };
    } catch (err) {
      this.logger.error(`[indexer] Failed to generate embedding for ${doc.mcp_name}:`, err);
    }
    
    await this.adapter.index([doc]);
    return doc;
  }

  /**
   * Remove a document by mcp_name.
   */
  async remove(mcpName: string): Promise<void> {
    const normalized = mcpName.trim().toLowerCase();
    if (!MCP_NAME_REGEXP.test(normalized)) {
      throw new Error(`Invalid mcp_name: "${mcpName}"`);
    }
    await this.adapter.remove(normalized);
    this.logger.info(`[indexer] Removed document: ${normalized}`);
  }

  /**
   * Full reindex: clear the index and re-import all provided documents.
   */
  async reindex(rawDocuments: unknown[]): Promise<number> {
    // Clear all existing documents first to remove any deleted servers,
    // then insert the entire fresh batch.
    await this.adapter.clear();
    return this.indexBatch(rawDocuments);
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
      description: truncate(nonEmptyString(raw.description), MAX_DESCRIPTION_LENGTH),
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

function buildSemanticText(doc: SearchDocument): string {
  const providerStr = doc.provider ? ` by ${doc.provider}` : "";
  const tagsStr = doc.tags.length > 0 ? `. Tags: ${doc.tags.join(", ")}` : "";
  
  let capabilitiesStr = "";
  if (doc.capabilities) {
    const tools = doc.capabilities.tools;
    const toolNames = Array.isArray(tools)
      ? tools.map((t: any) => t && typeof t === "object" && typeof t.name === "string" ? t.name : "").filter(Boolean)
      : [];
    if (toolNames.length > 0) {
      capabilitiesStr = `. Capabilities: ${toolNames.join(", ")}`;
    }
  }
  
  return `${doc.display_name}${providerStr}. ${doc.description || ""}${tagsStr}${capabilitiesStr}`;
}

// ---------------------------------------------------------------------------
// toolhub — In-Memory Search Adapter
// ---------------------------------------------------------------------------
// A lightweight adapter for development and testing. It stores documents in
// a plain Map and performs brute-force text matching over the indexed
// documents. No external dependencies required.
//
// NOT suitable for production — use the MeiliSearch adapter instead.
// ---------------------------------------------------------------------------

import type {
  EmbeddingMeta,
  IndexListEntry,
  SearchAdapter,
  SearchDocument,
  SearchHit,
  SearchOptions,
  SearchResult,
  ToolDocument,
  ToolDocumentHit,
  ToolSearchOptions,
  ToolSearchResult,
} from "./types.js";

export interface MemorySearchAdapterOptions {
  toolIndexEnabled?: boolean;
}

export class MemorySearchAdapter implements SearchAdapter {
  readonly toolIndexEnabled: boolean;
  private documents = new Map<string, SearchDocument>();
  private toolDocuments = new Map<string, ToolDocument>();
  private embeddingMeta: EmbeddingMeta | null = null;

  constructor(options: MemorySearchAdapterOptions = {}) {
    this.toolIndexEnabled = options.toolIndexEnabled ?? true;
  }

  async health(): Promise<boolean> {
    return true;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult> {
    const t0 = performance.now();
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    let items = [...this.documents.values()];

    // Apply filters
    items = applyFilters(items, options);

    // Score and rank
    const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");
    let scored: Array<{ doc: SearchDocument; score: number }>;

    if (!normalizedQuery) {
      scored = items.map((doc) => ({ doc, score: 1 }));
    } else {
      scored = items
        .map((doc) => ({ doc, score: scoreDocument(doc, normalizedQuery) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          return a.doc.mcp_name.localeCompare(b.doc.mcp_name);
        });
    }

    const total = scored.length;
    const paginated = scored.slice(offset, offset + limit);
    const hits: SearchHit[] = paginated.map((entry) => ({
      ...entry.doc,
      _score: entry.score,
      _rankingScore: Math.min(1, entry.score / 300),
    }));

    // Compute facets from the full (filtered but unpaginated) result set
    const facets = computeFacets(scored.map((s) => s.doc));

    const processingTimeMs = performance.now() - t0;

    return { hits, total, offset, limit, processingTimeMs, facets };
  }

  async getByName(mcpName: string): Promise<SearchDocument | null> {
    return this.documents.get(mcpName.toLowerCase()) ?? null;
  }

  async index(documents: SearchDocument[]): Promise<void> {
    for (const doc of documents) {
      const key = doc.mcp_name.toLowerCase();
      this.documents.set(key, { ...doc, mcp_name: key });
    }
  }

  async remove(mcpName: string): Promise<void> {
    this.documents.delete(mcpName.toLowerCase());
  }

  async getFacets(): Promise<Record<string, Record<string, number>>> {
    return computeFacets([...this.documents.values()]);
  }

  async getDocumentCount(): Promise<number> {
    return this.documents.size;
  }

  async clear(): Promise<void> {
    this.documents.clear();
  }

  async getAllDocuments(): Promise<SearchDocument[]> {
    return [...this.documents.values()];
  }

  // -------------------------------------------------------------------------
  // Tool index
  // -------------------------------------------------------------------------

  async initializeTools(): Promise<void> {
    // Nothing to initialize for the in-memory adapter.
  }

  async indexTools(documents: ToolDocument[]): Promise<void> {
    for (const doc of documents) {
      this.toolDocuments.set(doc.id, doc);
    }
  }

  async removeToolsByServer(mcpName: string): Promise<void> {
    const key = mcpName.toLowerCase();
    for (const [id, doc] of this.toolDocuments) {
      if (doc.server_mcp_name.toLowerCase() === key) {
        this.toolDocuments.delete(id);
      }
    }
  }

  async deleteTools(ids: string[]): Promise<void> {
    for (const id of ids) this.toolDocuments.delete(id);
  }

  async searchTools(query: string, options?: ToolSearchOptions): Promise<ToolSearchResult> {
    const t0 = performance.now();
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    let items = [...this.toolDocuments.values()];

    if (options?.serverMcpName) {
      const key = options.serverMcpName.toLowerCase();
      items = items.filter((doc) => doc.server_mcp_name.toLowerCase() === key);
    }
    if (options?.provider) {
      const p = options.provider!.toLowerCase();
      items = items.filter((doc) => (doc.provider ?? "").toLowerCase() === p);
    }
    if (options?.tags && options.tags.length > 0) {
      const requiredTags = options.tags.map((t) => t.toLowerCase());
      items = items.filter((doc) => requiredTags.every((tag) => doc.tags.includes(tag)));
    }

    const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");
    let scored: Array<{ doc: ToolDocument; score: number }>;
    if (!normalizedQuery) {
      scored = items.map((doc) => ({ doc, score: 1 }));
    } else {
      scored = items
        .map((doc) => ({ doc, score: scoreToolDocument(doc, normalizedQuery) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
    }

    const total = scored.length;
    const paginated = scored.slice(offset, offset + limit);
    const hits: ToolDocumentHit[] = paginated.map((entry, idx) => ({
      ...entry.doc,
      _rankingScore: Math.min(1, entry.score / 300),
      _rank: offset + idx + 1,
    }));

    return { hits, total, offset, limit, processingTimeMs: performance.now() - t0 };
  }

  async getToolDocumentCount(): Promise<number> {
    return this.toolDocuments.size;
  }

  async clearTools(): Promise<void> {
    this.toolDocuments.clear();
  }

  async getAllToolDocuments(): Promise<ToolDocument[]> {
    return [...this.toolDocuments.values()];
  }

  async getIndexList(): Promise<IndexListEntry[]> {
    return [...this.documents.values()].map((doc) => ({
      id: doc.mcp_name,
      updated_at: doc.updated_at,
      content_hash: doc.content_hash,
      has_vector: doc.has_vector ?? !!doc._vectors,
    }));
  }

  async getToolIndexList(): Promise<IndexListEntry[]> {
    return [...this.toolDocuments.values()].map((doc) => ({
      id: doc.id,
      updated_at: doc.updated_at,
      content_hash: doc.content_hash,
      has_vector: doc.has_vector ?? !!doc._vectors,
    }));
  }

  // -------------------------------------------------------------------------
  // Embedding metadata (fingerprint)
  // -------------------------------------------------------------------------

  async readEmbeddingMeta(): Promise<EmbeddingMeta | null> {
    return this.embeddingMeta;
  }

  async writeEmbeddingMeta(meta: EmbeddingMeta): Promise<void> {
    this.embeddingMeta = meta;
  }
}

function scoreToolDocument(doc: ToolDocument, query: string): number {
  const tokens = query.split(" ").filter(Boolean);
  const searchable = [
    doc.tool_name,
    doc.tool_description,
    doc.compact_schema,
    doc.server_display_name,
    doc.tags.join(" "),
    doc.provider ?? "",
  ]
    .join(" ")
    .toLowerCase();

  for (const token of tokens) {
    if (!searchable.includes(token)) return 0;
  }

  let score = 0;
  if (doc.tool_name === query) score += 500;
  if (doc.tool_name.startsWith(query)) score += 250;
  if (doc.tool_name.includes(query)) score += 120;
  if (doc.tool_description.toLowerCase().includes(query)) score += 60;
  for (const token of tokens) {
    if (doc.tool_name.includes(token)) score += 40;
    if (doc.tool_description.toLowerCase().includes(token)) score += 15;
  }
  return score > 0 ? score : 1;
}

// ---------------------------------------------------------------------------
// Scoring — weights tuned so dev/test ranking behavior closely matches the
// production search backend.
// ---------------------------------------------------------------------------

function scoreDocument(doc: SearchDocument, query: string): number {
  const tokens = query.split(" ").filter(Boolean);
  if (tokens.length === 0) return 1;

  let toolsStr = "";
  if (doc.capabilities && typeof doc.capabilities === "object") {
    const tools = (doc.capabilities as any).tools;
    if (Array.isArray(tools)) {
      toolsStr = tools
        .map((t) => (t && typeof t === "object" ? `${t.name ?? ""} ${t.description ?? ""}` : ""))
        .join(" ");
    }
  }

  // Build searchable text blob
  const searchable = [
    doc.mcp_name,
    doc.display_name,
    doc.description ?? "",
    doc.tags.join(" "),
    doc.provider ?? "",
    toolsStr,
  ]
    .join(" ")
    .toLowerCase();

  // AND matching: every token must appear somewhere
  for (const token of tokens) {
    if (!searchable.includes(token)) {
      return 0;
    }
  }

  let score = 0;

  // Exact name match
  if (doc.mcp_name === query) score += 200;
  // Prefix match
  if (doc.mcp_name.startsWith(query)) score += 120;
  // Display name contains full query
  if (doc.display_name.toLowerCase().includes(query)) score += 60;
  // Description contains full query
  if ((doc.description ?? "").toLowerCase().includes(query)) score += 28;

  // Per-token scoring
  for (const token of tokens) {
    if (doc.mcp_name.includes(token)) score += 20;
    if (doc.display_name.toLowerCase().includes(token)) score += 10;
    if ((doc.provider ?? "").toLowerCase().includes(token)) score += 8;
    if (doc.tags.join(" ").includes(token)) score += 12;
  }

  return score > 0 ? score : 1;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function applyFilters(
  items: SearchDocument[],
  options?: SearchOptions,
): SearchDocument[] {
  let result = items;


  if (options?.provider) {
    const p = options.provider.toLowerCase();
    result = result.filter(
      (doc) => (doc.provider ?? "").toLowerCase() === p,
    );
  }

  if (options?.tags && options.tags.length > 0) {
    const requiredTags = options.tags.map((t) => t.toLowerCase());
    result = result.filter((doc) => {
      const docTags = new Set(doc.tags.map((t) => t.toLowerCase()));
      return requiredTags.every((tag) => docTags.has(tag));
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Facet computation
// ---------------------------------------------------------------------------

function computeFacets(
  docs: SearchDocument[],
): Record<string, Record<string, number>> {
  const tagCounts: Record<string, number> = {};
  const providerCounts: Record<string, number> = {};

  for (const doc of docs) {
    // Tags
    for (const tag of doc.tags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
    // Provider
    if (doc.provider) {
      providerCounts[doc.provider] =
        (providerCounts[doc.provider] ?? 0) + 1;
    }
  }

  return {
    tags: tagCounts,
    provider: providerCounts,
  };
}

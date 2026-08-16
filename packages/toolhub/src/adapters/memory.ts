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
  SearchAdapter,
  SearchDocument,
  SearchHit,
  SearchOptions,
  SearchResult,
} from "./types.js";

export class MemorySearchAdapter implements SearchAdapter {
  private documents = new Map<string, SearchDocument>();

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

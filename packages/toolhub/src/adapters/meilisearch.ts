// ---------------------------------------------------------------------------
// toolhub — MeiliSearch Adapter
// ---------------------------------------------------------------------------
// Production adapter that delegates to a MeiliSearch instance. MeiliSearch
// provides typo tolerance, prefix search, faceted filtering, and sub-50ms
// query latency out of the box.
//
// Manages three indexes:
//   mcp_servers  — one document per MCP server (overview vectors)
//   mcp_tools    — one document per tool (per-tool vectors, D7 parent-child)
//   toolhub_meta — tiny metadata store for the embedding fingerprint
//
// This adapter is designed to be swappable. When a more advanced engine is
// needed, create a new adapter implementing SearchAdapter and update the
// config to select it.
// ---------------------------------------------------------------------------

import { MeiliSearch, type SearchResponse, type Index } from "meilisearch";
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

export interface MeiliSearchAdapterConfig {
  /** MeiliSearch server URL (e.g. "http://localhost:7700"). */
  url: string;

  /** API key for search queries (can be a search-only key). */
  searchKey: string;

  /** API key for admin operations (indexing, settings). Needs write access. */
  adminKey: string;

  /** Name of the MeiliSearch index to use. */
  indexName: string;

  /** Vector dimensionality of the embedding provider (default 384). */
  dimensions?: number;

  /** Whether the D7 tool index is enabled (default true). */
  toolIndexEnabled?: boolean;

  /** Name of the MeiliSearch tool index (default "mcp_tools"). */
  toolIndexName?: string;

  /** Name of the metadata index (default "toolhub_meta"). */
  metaIndexName?: string;
}

/** Attributes that users can filter on. */
const FILTERABLE_ATTRIBUTES = ["tags", "provider", "health_status"];

/** Attributes that appear in facet distributions. */
const FACET_ATTRIBUTES = ["tags", "provider", "health_status"];

/** Attributes used for text search ranking. Order matters — higher = more weight. */
const SEARCHABLE_ATTRIBUTES = [
  "mcp_name",
  "display_name",
  "description",
  "tags",
  "provider",
  "capabilities",
];

/** Attributes that can be used for sorting. */
const SORTABLE_ATTRIBUTES = ["mcp_name", "updated_at"];

/** Tool index searchable attributes. */
const TOOL_SEARCHABLE_ATTRIBUTES = [
  "tool_name",
  "tool_description",
  "compact_schema",
  "server_display_name",
  "tags",
  "provider",
];

/** Tool index filterable attributes. */
const TOOL_FILTERABLE_ATTRIBUTES = ["server_mcp_name", "tags", "provider", "health_status"];

/** Tool index sortable attributes. */
const TOOL_SORTABLE_ATTRIBUTES = ["updated_at"];

const META_INDEX_NAME = "toolhub_meta";
const META_DOC_ID = "embedding";

export class MeiliSearchAdapter implements SearchAdapter {
  readonly toolIndexEnabled: boolean;
  private searchClient: MeiliSearch;
  private adminClient: MeiliSearch;
  private indexName: string;
  private toolIndexName: string;
  private metaIndexName: string;
  private host: string;
  private adminKey: string;
  private dimensions: number;

  constructor(config: MeiliSearchAdapterConfig) {
    this.indexName = config.indexName;
    this.toolIndexName = config.toolIndexName ?? "mcp_tools";
    this.metaIndexName = config.metaIndexName ?? META_INDEX_NAME;
    this.host = config.url;
    this.adminKey = config.adminKey;
    this.dimensions = config.dimensions ?? 384;
    this.toolIndexEnabled = config.toolIndexEnabled ?? true;

    // Use separate clients for search vs admin to respect key scoping.
    // In production, the search key should be read-only.
    this.searchClient = new MeiliSearch({
      host: config.url,
      apiKey: config.searchKey || config.adminKey || undefined,
    });

    this.adminClient = new MeiliSearch({
      host: config.url,
      apiKey: config.adminKey || undefined,
    });
  }

  /**
   * Ensure the server index exists and has the correct settings.
   * Call this once at startup.
   */
  async initialize(): Promise<void> {
    // Enable experimental features (vector store) first
    try {
      const response = await fetch(`${this.host}/experimental-features`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(this.adminKey ? { Authorization: `Bearer ${this.adminKey}` } : {}),
        },
        body: JSON.stringify({ vectorStore: true }),
      });
      if (!response.ok) {
        console.warn(`[meili] Warning: Could not enable vectorStore feature. Status: ${response.status}`);
      }
    } catch (err) {
      console.warn(`[meili] Warning: Failed to contact experimental-features endpoint:`, err);
    }

    // Create the server index if it doesn't exist
    try {
      await this.adminClient.createIndex(this.indexName, {
        primaryKey: "id",
      });
    } catch (err: unknown) {
      // Index may already exist — MeiliSearch returns an error in that case.
      // We check if it's a real error or just "index already exists".
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already exists")) {
        // For task-based responses, the createIndex might return a task
        // that we need to wait for. Let's be lenient here.
        console.warn(`[meili] Index creation note: ${message}`);
      }
    }

    // Wait for the index to be available, then configure settings
    const index = this.adminClient.index(this.indexName);

    // Explicitly configure displayed attributes to prevent returning huge _vectors or internal semantic_text
    const displayedAttributes = [
      "id",
      "mcp_name",
      "display_name",
      "description",
      "tags",
      "provider",
      "docs_url",
      "homepage_url",
      "base_url",
      "protocol_version",
      "capabilities",
      "health_status",
      "updated_at",
    ];

    const settings: any = {
      filterableAttributes: FILTERABLE_ATTRIBUTES,
      searchableAttributes: SEARCHABLE_ATTRIBUTES,
      sortableAttributes: SORTABLE_ATTRIBUTES,
      displayedAttributes,
      typoTolerance: {
        enabled: true,
        minWordSizeForTypos: {
          oneTypo: 4,
          twoTypos: 8,
        },
      },
      embedders: {
        default: {
          source: "userProvided",
          dimensions: this.dimensions,
        },
      },
    };

    try {
      const task = await index.updateSettings(settings);
      const finishedTask = await this.adminClient.waitForTask(task.taskUid, {
        timeOutMs: 30_000,
        intervalMs: 100,
      });
      if (finishedTask.status === "failed") {
        throw new Error(finishedTask.error?.message || "Settings task failed");
      }
    } catch (err: any) {
      const errMsg = err.message || String(err);
      if (errMsg.includes("no vectors provided") || errMsg.includes("vector") || errMsg.includes("embedder")) {
        console.warn("[meili] Pre-existing documents lack vectors. Wiping index to apply vector settings...");
        await index.deleteAllDocuments();
        const task = await index.updateSettings(settings);
        const finishedTask = await this.adminClient.waitForTask(task.taskUid, {
          timeOutMs: 30_000,
          intervalMs: 100,
        });
        if (finishedTask.status === "failed") {
          throw new Error(finishedTask.error?.message || "Settings task failed on retry");
        }
      } else {
        throw err;
      }
    }

    await this.ensureMetaIndex();

    if (this.toolIndexEnabled) {
      await this.initializeTools();
    }

    console.log(`[meili] Index "${this.indexName}" initialized with search and vector settings`);
  }

  /**
   * Ensure the tool index exists and has the correct settings.
   */
  async initializeTools(): Promise<void> {
    try {
      await this.adminClient.createIndex(this.toolIndexName, {
        primaryKey: "id",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already exists")) {
        console.warn(`[meili] Tool index creation note: ${message}`);
      }
    }

    const index = this.adminClient.index(this.toolIndexName);
    const settings: any = {
      searchableAttributes: TOOL_SEARCHABLE_ATTRIBUTES,
      filterableAttributes: TOOL_FILTERABLE_ATTRIBUTES,
      sortableAttributes: TOOL_SORTABLE_ATTRIBUTES,
      displayedAttributes: [
        "id",
        "server_mcp_name",
        "server_display_name",
        "tool_name",
        "tool_description",
        "compact_schema",
        "provider",
        "tags",
        "health_status",
        "server_base_url",
        "server_health_last_checked",
        "updated_at",
      ],
      typoTolerance: {
        enabled: true,
        minWordSizeForTypos: {
          oneTypo: 4,
          twoTypos: 8,
        },
      },
      embedders: {
        default: {
          source: "userProvided",
          dimensions: this.dimensions,
        },
      },
    };

    try {
      const task = await index.updateSettings(settings);
      const finishedTask = await this.adminClient.waitForTask(task.taskUid, {
        timeOutMs: 30_000,
        intervalMs: 100,
      });
      if (finishedTask.status === "failed") {
        throw new Error(finishedTask.error?.message || "Tool settings task failed");
      }
    } catch (err: any) {
      const errMsg = err.message || String(err);
      if (errMsg.includes("no vectors provided") || errMsg.includes("vector") || errMsg.includes("embedder")) {
        console.warn("[meili] Pre-existing tool documents lack vectors. Wiping tool index to apply vector settings...");
        await index.deleteAllDocuments();
        const task = await index.updateSettings(settings);
        const finishedTask = await this.adminClient.waitForTask(task.taskUid, {
          timeOutMs: 30_000,
          intervalMs: 100,
        });
        if (finishedTask.status === "failed") {
          throw new Error(finishedTask.error?.message || "Tool settings task failed on retry");
        }
      } else {
        throw err;
      }
    }

    console.log(`[meili] Tool index "${this.toolIndexName}" initialized with search and vector settings`);
  }

  /** Ensure the tiny metadata index exists (fingerprint storage). */
  private async ensureMetaIndex(): Promise<void> {
    try {
      await this.adminClient.createIndex(this.metaIndexName, {
        primaryKey: "id",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already exists")) {
        console.warn(`[meili] Meta index creation note: ${message}`);
      }
    }
  }

  async health(): Promise<boolean> {
    try {
      const info = await this.searchClient.health();
      return info.status === "available";
    } catch {
      return false;
    }
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult> {
    const index = this.getSearchIndex();
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    // Build MeiliSearch filter expressions
    const filters: string[] = [];
    if (options?.provider) {
      filters.push(`provider = "${sanitizeFilterValue(options.provider)}"`);
    }
    if (options?.tags && options.tags.length > 0) {
      // MeiliSearch uses AND for multiple tag filters
      for (const tag of options.tags) {
        filters.push(`tags = "${sanitizeFilterValue(tag)}"`);
      }
    }

    const searchParams: any = {
      limit,
      offset,
      facets: FACET_ATTRIBUTES,
      attributesToRetrieve: ["*"],
      showRankingScore: true,
    };

    if (filters.length > 0) {
      searchParams.filter = filters;
    }

    if (options?.vector) {
      searchParams.vector = options.vector;

      // Determine semantic weight adaptively based on query length/words
      let semanticRatio = 0.5;
      const wordCount = query.trim().split(/\s+/).length;
      if (wordCount <= 2) {
        semanticRatio = 0.3;
      } else if (wordCount >= 5) {
        semanticRatio = 0.7;
      }

      searchParams.hybrid = {
        semanticRatio,
        embedder: "default",
      };
    }

    let response: SearchResponse<SearchDocument>;
    try {
      response = await index.search(query || null, searchParams);
    } catch (err: unknown) {
      if (searchParams.vector || searchParams.hybrid) {
        console.warn(`[meili] Vector search failed (${err instanceof Error ? err.message : String(err)}) — falling back to lexical search`);
        delete searchParams.vector;
        delete searchParams.hybrid;
        response = await index.search(query || null, searchParams);
      } else {
        throw err;
      }
    }

    const hits: SearchHit[] = response.hits.map((hit) => ({
      ...hit,
    }));

    // Transform facet distribution
    const facets: Record<string, Record<string, number>> = {};
    if (response.facetDistribution) {
      for (const [key, dist] of Object.entries(response.facetDistribution)) {
        facets[key] = dist as Record<string, number>;
      }
    }

    return {
      hits,
      total: response.estimatedTotalHits ?? response.hits.length,
      offset,
      limit,
      processingTimeMs: response.processingTimeMs ?? 0,
      facets,
    };
  }

  async getByName(mcpName: string): Promise<SearchDocument | null> {
    const index = this.getSearchIndex();
    try {
      const doc = await index.getDocument<SearchDocument>(encodeDocumentId(mcpName));
      return doc ?? null;
    } catch (err: unknown) {
      // MeiliSearch throws when document is not found
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("not found") ||
        message.includes("Document") ||
        message.includes("404")
      ) {
        return null;
      }
      throw err;
    }
  }

  async index(documents: SearchDocument[]): Promise<void> {
    if (documents.length === 0) return;

    const index = this.getAdminIndex();

    // Normalize primary keys and map to safe alphanumeric document ID
    const normalized = documents.map((doc) => ({
      ...doc,
      id: encodeDocumentId(doc.mcp_name),
      mcp_name: doc.mcp_name.toLowerCase(),
    }));

    // MeiliSearch handles batching internally, but for very large sets
    // we chunk to avoid timeout issues.
    const CHUNK_SIZE = 500;
    for (let i = 0; i < normalized.length; i += CHUNK_SIZE) {
      const chunk = normalized.slice(i, i + CHUNK_SIZE);
      const task = await index.addDocuments(chunk);
      // Wait for the indexing task to complete
      await this.adminClient.waitForTask(task.taskUid, {
        timeOutMs: 30_000,
        intervalMs: 100,
      });
    }
  }

  async remove(mcpName: string): Promise<void> {
    const index = this.getAdminIndex();
    const task = await index.deleteDocument(encodeDocumentId(mcpName));
    await this.adminClient.waitForTask(task.taskUid, {
      timeOutMs: 10_000,
      intervalMs: 100,
    });
  }

  async getFacets(): Promise<Record<string, Record<string, number>>> {
    // Perform an empty search with facets to get the full distribution
    const result = await this.search("", { limit: 0 });
    return result.facets ?? {};
  }

  async getDocumentCount(): Promise<number> {
    const index = this.getSearchIndex();
    const stats = await index.getStats();
    return stats.numberOfDocuments;
  }

  async getAllDocuments(): Promise<SearchDocument[]> {
    const index = this.getAdminIndex();
    const all: SearchDocument[] = [];
    const batchSize = 1000;
    let offset = 0;

    while (true) {
      const { results } = await index.getDocuments<SearchDocument>({
        limit: batchSize,
        offset,
      });
      if (results.length === 0) break;
      all.push(...results);
      offset += results.length;
    }

    return all;
  }

  async clear(): Promise<void> {
    const index = this.getAdminIndex();
    const task = await index.deleteAllDocuments();
    await this.adminClient.waitForTask(task.taskUid, {
      timeOutMs: 10_000,
      intervalMs: 100,
    });
  }

  // -------------------------------------------------------------------------
  // Tool index
  // -------------------------------------------------------------------------

  async indexTools(documents: ToolDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const index = this.adminClient.index(this.toolIndexName);
    const CHUNK_SIZE = 500;
    for (let i = 0; i < documents.length; i += CHUNK_SIZE) {
      const chunk = documents.slice(i, i + CHUNK_SIZE);
      const task = await index.addDocuments(chunk);
      await this.adminClient.waitForTask(task.taskUid, {
        timeOutMs: 30_000,
        intervalMs: 100,
      });
    }
  }

  async removeToolsByServer(mcpName: string): Promise<void> {
    const index = this.adminClient.index(this.toolIndexName);
    const filter = `server_mcp_name = "${sanitizeFilterValue(mcpName.toLowerCase())}"`;
    try {
      const task = await index.deleteDocuments({ filter });
      await this.adminClient.waitForTask(task.taskUid, {
        timeOutMs: 30_000,
        intervalMs: 100,
      });
    } catch (err) {
      // Older Meili versions reject delete-by-filter; fall back to listing
      // matching documents and deleting them individually.
      console.warn("[meili] delete-by-filter failed, falling back to per-id deletion:", err);
      const docs = await this.searchTools("", { serverMcpName: mcpName, limit: 10_000 });
      if (docs.hits.length > 0) {
        await this.deleteTools(docs.hits.map((h) => h.id));
      }
    }
  }

  async deleteTools(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const index = this.adminClient.index(this.toolIndexName);
    const task = await index.deleteDocuments(ids);
    await this.adminClient.waitForTask(task.taskUid, {
      timeOutMs: 30_000,
      intervalMs: 100,
    });
  }

  async searchTools(query: string, options?: ToolSearchOptions): Promise<ToolSearchResult> {
    const index = this.searchClient.index<ToolDocument>(this.toolIndexName);
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    const filters: string[] = [];
    if (options?.serverMcpName) {
      filters.push(`server_mcp_name = "${sanitizeFilterValue(options.serverMcpName)}"`);
    }
    if (options?.provider) {
      filters.push(`provider = "${sanitizeFilterValue(options.provider)}"`);
    }
    if (options?.tags && options.tags.length > 0) {
      for (const tag of options.tags) {
        filters.push(`tags = "${sanitizeFilterValue(tag)}"`);
      }
    }

    const searchParams: any = {
      limit,
      offset,
      attributesToRetrieve: ["*"],
      showRankingScore: options?.withScores ?? true,
    };

    if (filters.length > 0) {
      searchParams.filter = filters.join(" AND ");
    }

    if (options?.vector) {
      searchParams.vector = options.vector;
      searchParams.hybrid = {
        semanticRatio: 0.6,
        embedder: "default",
      };
    }

    let response: SearchResponse<ToolDocument>;
    try {
      response = await index.search(query || null, searchParams);
    } catch (err: unknown) {
      if (searchParams.vector || searchParams.hybrid) {
        console.warn(`[meili] Tool vector search failed (${err instanceof Error ? err.message : String(err)}) — falling back to lexical tool search`);
        delete searchParams.vector;
        delete searchParams.hybrid;
        response = await index.search(query || null, searchParams);
      } else {
        throw err;
      }
    }

    const hits: ToolDocumentHit[] = response.hits.map((hit, idx) => ({
      ...hit,
      _rank: offset + idx + 1,
    }));

    return {
      hits,
      total: response.estimatedTotalHits ?? response.hits.length,
      offset,
      limit,
      processingTimeMs: response.processingTimeMs ?? 0,
    };
  }

  async getToolDocumentCount(): Promise<number> {
    const index = this.searchClient.index(this.toolIndexName);
    const stats = await index.getStats();
    return stats.numberOfDocuments;
  }

  async clearTools(): Promise<void> {
    const index = this.adminClient.index(this.toolIndexName);
    const task = await index.deleteAllDocuments();
    await this.adminClient.waitForTask(task.taskUid, {
      timeOutMs: 10_000,
      intervalMs: 100,
    });
  }

  async getAllToolDocuments(): Promise<ToolDocument[]> {
    const index = this.adminClient.index(this.toolIndexName);
    const all: ToolDocument[] = [];
    const batchSize = 1000;
    let offset = 0;

    while (true) {
      const { results } = await index.getDocuments<ToolDocument>({
        limit: batchSize,
        offset,
      });
      if (results.length === 0) break;
      all.push(...results);
      offset += results.length;
    }

    return all;
  }

  async getIndexList(): Promise<IndexListEntry[]> {
    const index = this.adminClient.index(this.indexName);
    const entries: IndexListEntry[] = [];
    const batchSize = 1000;
    let offset = 0;

    while (true) {
      const { results } = await index.getDocuments<SearchDocument>({
        limit: batchSize,
        offset,
        fields: ["id", "mcp_name", "updated_at", "content_hash", "has_vector"],
      });
      if (results.length === 0) break;
      for (const doc of results) {
        entries.push({
          id: doc.mcp_name,
          updated_at: doc.updated_at,
          content_hash: doc.content_hash,
          has_vector: doc.has_vector ?? !!doc._vectors,
        });
      }
      offset += results.length;
    }

    return entries;
  }

  async getToolIndexList(): Promise<IndexListEntry[]> {
    const index = this.adminClient.index(this.toolIndexName);
    const entries: IndexListEntry[] = [];
    const batchSize = 1000;
    let offset = 0;

    while (true) {
      const { results } = await index.getDocuments<ToolDocument>({
        limit: batchSize,
        offset,
        fields: ["id", "server_mcp_name", "updated_at", "content_hash", "has_vector"],
      });
      if (results.length === 0) break;
      for (const doc of results) {
        entries.push({
          id: doc.id,
          updated_at: doc.updated_at,
          content_hash: doc.content_hash,
          has_vector: doc.has_vector ?? !!doc._vectors,
        });
      }
      offset += results.length;
    }

    return entries;
  }

  // -------------------------------------------------------------------------
  // Embedding metadata (fingerprint)
  // -------------------------------------------------------------------------

  async readEmbeddingMeta(): Promise<EmbeddingMeta | null> {
    const index = this.adminClient.index(this.metaIndexName);
    try {
      const doc = await index.getDocument<EmbeddingMeta>(META_DOC_ID);
      return doc ?? null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("not found") ||
        message.includes("Document") ||
        message.includes("404")
      ) {
        return null;
      }
      throw err;
    }
  }

  async writeEmbeddingMeta(meta: EmbeddingMeta): Promise<void> {
    const index = this.adminClient.index(this.metaIndexName);
    const task = await index.addDocuments([meta]);
    await this.adminClient.waitForTask(task.taskUid, {
      timeOutMs: 10_000,
      intervalMs: 100,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private getSearchIndex(): Index<SearchDocument> {
    return this.searchClient.index<SearchDocument>(this.indexName);
  }

  private getAdminIndex(): Index<SearchDocument> {
    return this.adminClient.index<SearchDocument>(this.indexName);
  }
}

/**
 * Sanitize a filter value to prevent MeiliSearch filter injection.
 * MeiliSearch uses double quotes in filter expressions; we strip them.
 */
function sanitizeFilterValue(value: string): string {
  return value.replace(/"/g, "").replace(/\\/g, "").trim();
}

/**
 * Encodes mcp_name containing slashes or dots into a safe MeiliSearch document ID.
 */
function encodeDocumentId(mcpName: string): string {
  return mcpName.trim().toLowerCase().replace(/\//g, "__").replace(/\./g, "_");
}
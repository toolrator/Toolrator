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
import { randomUUID } from "node:crypto";
import { encodeServerId } from "../tool-indexer.js";
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

function serverSettings(dimensions: number): Record<string, unknown> {
  return {
    filterableAttributes: FILTERABLE_ATTRIBUTES,
    searchableAttributes: SEARCHABLE_ATTRIBUTES,
    sortableAttributes: SORTABLE_ATTRIBUTES,
    displayedAttributes: [
      "id", "mcp_name", "display_name", "description", "tags", "provider",
      "docs_url", "homepage_url", "base_url", "protocol_version",
      "capabilities", "health_status", "updated_at",
    ],
    typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } },
    ...(dimensions > 0 ? { embedders: { default: { source: "userProvided", dimensions } } } : {}),
  };
}

function toolSettings(dimensions: number): Record<string, unknown> {
  return {
    searchableAttributes: TOOL_SEARCHABLE_ATTRIBUTES,
    filterableAttributes: TOOL_FILTERABLE_ATTRIBUTES,
    sortableAttributes: TOOL_SORTABLE_ATTRIBUTES,
    displayedAttributes: [
      "id", "server_mcp_name", "server_display_name", "tool_name",
      "tool_description", "compact_schema", "provider", "tags", "health_status",
      "server_base_url", "server_health_last_checked", "updated_at",
    ],
    typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } },
    ...(dimensions > 0 ? { embedders: { default: { source: "userProvided", dimensions } } } : {}),
  };
}

export class MeiliSearchAdapter implements SearchAdapter {
  readonly toolIndexEnabled: boolean;
  readonly vectorSearchEnabled: boolean;
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
    this.vectorSearchEnabled = this.dimensions > 0;
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
    if (this.vectorSearchEnabled) try {
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

    await this.ensureIndex(this.indexName);

    // Wait for the index to be available, then configure settings
    const index = this.adminClient.index(this.indexName);

    await this.ensureMetaIndex();
    const previous = await this.readEmbeddingMeta();
    const dimensionChange = previous && previous.dimensions !== this.dimensions;
    if (dimensionChange) {
      console.warn("[meili] Vector dimensions changed; keeping live settings until a staged reindex replaces the indexes");
    } else {
      await this.waitForSuccess((await index.updateSettings(serverSettings(this.dimensions))).taskUid, "server settings");
    }

    if (this.toolIndexEnabled) {
      await this.initializeTools(!!dimensionChange);
    }

    console.log(`[meili] Index "${this.indexName}" initialized with search and vector settings`);
  }

  /**
   * Ensure the tool index exists and has the correct settings.
   */
  async initializeTools(deferSettings = false): Promise<void> {
    await this.ensureIndex(this.toolIndexName);

    if (!deferSettings) {
      const index = this.adminClient.index(this.toolIndexName);
      await this.waitForSuccess((await index.updateSettings(toolSettings(this.dimensions))).taskUid, "tool settings");
    }

    console.log(`[meili] Tool index "${this.toolIndexName}" initialized with search and vector settings`);
  }

  /** Ensure the tiny metadata index exists (fingerprint storage). */
  private async ensureMetaIndex(): Promise<void> {
    await this.ensureIndex(this.metaIndexName);
  }

  private async ensureIndex(name: string): Promise<void> {
    try {
      const task = await this.adminClient.createIndex(name, { primaryKey: "id" });
      await this.waitForSuccess(task.taskUid, `create index ${name}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already exists")) throw err;
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
      await this.waitForSuccess(task.taskUid, "index servers");
    }
  }

  async remove(mcpName: string): Promise<void> {
    const index = this.getAdminIndex();
    const task = await index.deleteDocument(encodeDocumentId(mcpName));
    await this.waitForSuccess(task.taskUid, "remove server");
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
    await this.waitForSuccess(task.taskUid, "clear servers");
  }

  async replaceAll(servers: SearchDocument[], tools: ToolDocument[]): Promise<void> {
    const suffix = randomUUID().replace(/-/g, "");
    const stagedServerName = `${this.indexName}_stage_${suffix}`;
    const stagedToolName = `${this.toolIndexName}_stage_${suffix}`;
    const stagedNames = this.toolIndexEnabled
      ? [stagedServerName, stagedToolName]
      : [stagedServerName];
    let swapped = false;
    try {
      for (const name of stagedNames) {
        await this.waitForSuccess((await this.adminClient.createIndex(name, { primaryKey: "id" })).taskUid, `create ${name}`);
      }
      const stagedServer = this.adminClient.index<SearchDocument>(stagedServerName);
      await this.waitForSuccess((await stagedServer.updateSettings(serverSettings(this.dimensions))).taskUid, "stage server settings");
      for (let i = 0; i < servers.length; i += 500) {
        const documents = servers.slice(i, i + 500).map((doc) => ({ ...doc, id: encodeDocumentId(doc.mcp_name) }));
        await this.waitForSuccess((await stagedServer.addDocuments(documents)).taskUid, "stage servers");
      }

      const swaps = [{ indexes: [this.indexName, stagedServerName] }];
      if (this.toolIndexEnabled) {
        const stagedTools = this.adminClient.index<ToolDocument>(stagedToolName);
        await this.waitForSuccess((await stagedTools.updateSettings(toolSettings(this.dimensions))).taskUid, "stage tool settings");
        for (let i = 0; i < tools.length; i += 500) {
          await this.waitForSuccess((await stagedTools.addDocuments(tools.slice(i, i + 500))).taskUid, "stage tools");
        }
        swaps.push({ indexes: [this.toolIndexName, stagedToolName] });
      }
      await this.waitForSuccess((await this.adminClient.swapIndexes(swaps)).taskUid, "swap search indexes");
      swapped = true;
    } finally {
      for (const name of stagedNames) {
        try {
          await this.waitForSuccess((await this.adminClient.deleteIndex(name)).taskUid, `remove temporary index ${name}`);
        } catch (error) {
          // A failed cleanup leaves an extra index but must not hide a failed swap.
          console.warn(`[meili] Could not clean up temporary index ${name}:`, error);
        }
      }
      if (swapped) console.log("[meili] Replaced search indexes after staged indexing completed");
    }
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
      await this.waitForSuccess(task.taskUid, "index tools");
    }
  }

  async removeToolsByServer(mcpName: string): Promise<void> {
    const index = this.adminClient.index(this.toolIndexName);
    const filter = `server_mcp_name = "${sanitizeFilterValue(mcpName.toLowerCase())}"`;
    let task: { taskUid: number };
    try {
      task = await index.deleteDocuments({ filter });
    } catch (err) {
      // Older Meili versions reject delete-by-filter; fall back to listing
      // matching documents and deleting them individually.
      console.warn("[meili] delete-by-filter failed, falling back to per-id deletion:", err);
      const docs = await this.searchTools("", { serverMcpName: mcpName, limit: 10_000 });
      if (docs.hits.length > 0) {
        await this.deleteTools(docs.hits.map((h) => h.id));
      }
      return;
    }
    await this.waitForSuccess(task.taskUid, "remove server tools");
  }

  async deleteTools(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const index = this.adminClient.index(this.toolIndexName);
    const task = await index.deleteDocuments(ids);
    await this.waitForSuccess(task.taskUid, "remove tools");
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
    await this.waitForSuccess(task.taskUid, "clear tools");
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
    await this.waitForSuccess(task.taskUid, "write embedding fingerprint");
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

  private async waitForSuccess(taskUid: number, action: string): Promise<void> {
    const task = await this.adminClient.waitForTask(taskUid, { timeOutMs: 30_000, intervalMs: 100 });
    if (task.status !== "succeeded") {
      throw new Error(`[meili] Could not ${action}: ${task.error?.message ?? task.status}`);
    }
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
 * Uses the same collision-resistant server id as the tool document builder.
 */
function encodeDocumentId(mcpName: string): string {
  return encodeServerId(mcpName);
}

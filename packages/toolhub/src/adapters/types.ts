// ---------------------------------------------------------------------------
// toolhub — Adapter Interfaces
// ---------------------------------------------------------------------------
// These interfaces define the contract between the search service and the
// underlying search backend. To swap MeiliSearch for another engine (e.g.
// Elasticsearch, Vespa, Typesense, or a custom solution), implement these
// interfaces and update the config to select the new backend.
//
// Design principle: the interfaces are intentionally engine-agnostic. They
// expose capabilities (faceted search, typo tolerance, highlighting) without
// leaking engine-specific concepts like MeiliSearch "attributes" or
// Elasticsearch "analyzers".
// ---------------------------------------------------------------------------

/**
 * A document representing an MCP server in the search index.
 * This is the canonical schema that all adapters must support.
 */
export interface SearchDocument {
  /** Internal alphanumeric document ID for MeiliSearch database. */
  id?: string;

  /** Unique identifier and primary key. Lowercase, alphanumeric + hyphens. */
  mcp_name: string;

  /** Human-readable display name. */
  display_name: string;

  /** Free-text description of what the server does. */
  description?: string;

  /** Categorization tags (e.g. ["code", "github", "devtools"]). */
  tags: string[];

  /** Organization or individual that provides the server. */
  provider?: string;

  /** URL to documentation. */
  docs_url?: string;

  /** URL to homepage or landing page. */
  homepage_url?: string;

  /** Direct connection URL of the MCP server (clients connect here directly). */
  base_url?: string;

  /** MCP protocol version supported. */
  protocol_version?: string;

  /** Server capabilities (tools, resources, prompts, etc.). */
  capabilities?: Record<string, unknown>;

  /** Clean text summary used to generate semantic vector embeddings. */
  semantic_text?: string;

  /** Pre-computed vector embeddings for hybrid/vector search. */
  _vectors?: Record<string, number[]>;

  /** Stable content hash for incremental sync diagnostics. */
  content_hash?: string;

  /** Whether this document currently carries a vector. */
  has_vector?: boolean;

  /** Health status from the last health check. */
  health_status?: string;

  /** ISO 8601 timestamp of the last update. */
  updated_at?: string;
}

/**
 * A single tool of an MCP server, indexed in the dedicated tool index
 * (`mcp_tools`). One document per tool, linked to its parent server via
 * server_mcp_name. This is the parent-child indexing model: the server doc
 * holds the overview vector, tool docs hold per-tool vectors.
 */
export interface ToolDocument {
  /** Internal document ID: "{encoded_server}__{encoded_tool}". */
  id: string;

  /** Parent MCP server identifier (mcp_name). */
  server_mcp_name: string;

  /** Parent server display name (denormalized for display). */
  server_display_name: string;

  /** Tool name as exposed by tools/list. */
  tool_name: string;

  /** Tool description as exposed by tools/list. */
  tool_description: string;

  /** Compact, capped representation of the tool's input schema. */
  compact_schema: string;

  /** Parent server provider (denormalized, filterable). */
  provider?: string;

  /** Parent server tags (denormalized, filterable). */
  tags: string[];

  /** Parent server health status (denormalized, filterable). */
  health_status?: string;

  /** Parent server base URL (denormalized for display). */
  server_base_url?: string;

  /** Parent server display metadata needed to render tool cards. */
  server_provider?: string;
  server_health_last_checked?: string;

  /** ISO 8601 timestamp of the last update. */
  updated_at?: string;

  /** Clean text used to generate the tool's semantic vector. */
  semantic_text?: string;

  /** Pre-computed vector embedding for the tool. */
  _vectors?: Record<string, number[]>;

  /** Stable content hash for incremental sync diagnostics. */
  content_hash?: string;

  /** Whether this document currently carries a vector. */
  has_vector?: boolean;
}

/**
 * Raw tool data extracted from a server document's capabilities.
 * This is the input to the tool document builder (caps, ids, semantic text).
 */
export interface RawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Options for a search query.
 */
export interface SearchOptions {
  /** Maximum number of results to return. */
  limit?: number;

  /** Offset for pagination. */
  offset?: number;

  /** Filter by tags (AND logic: server must have ALL specified tags). */
  tags?: string[];

  /** Filter by provider name (exact match). */
  provider?: string;

  /** Query embedding vector for hybrid/vector search. */
  vector?: number[];

  /** If true, bypass vector generation and perform standard lexical search. */
  lexicalOnly?: boolean;

  /** Maximum number of tool hits to extract and return. */
  maxTools?: number;
}

/**
 * A single search hit, extending the base document with search metadata.
 */
export interface SearchHit extends SearchDocument {
  /**
   * Relevance score assigned by the search backend.
   * Higher is more relevant. Scale is backend-dependent — do not compare
   * scores across different adapter implementations.
   */
  _score?: number;
}

export interface ToolHit {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  compactSchema?: string;
  annotations?: Record<string, unknown>;
  server_mcp_name: string;
  server_display_name: string;
  server_base_url?: string;
  server_provider?: string;
  server_tags?: string[];
  server_health_status?: string;
  server_health_last_checked?: string;
}

/**
 * The result of a search query.
 */
export interface SearchResult {
  /** The matching documents, ordered by relevance. */
  hits: SearchHit[];

  /** The matching individual tools extracted from hits. */
  toolHits?: ToolHit[];

  /** Total number of matches (for pagination). */
  total: number;

  /** Offset applied to this result set. */
  offset: number;

  /** Limit applied to this result set. */
  limit: number;

  /** Time taken by the search backend to process the query (ms). */
  processingTimeMs: number;

  /**
   * Facet distribution counts for filterable attributes.
   * Each key is a field name, value is a map of field_value → count.
   * Example: { tags: { "code": 42, "ai": 15 }, provider: { "acme": 7 } }
   */
  facets?: Record<string, Record<string, number>>;

  /** Which presentation should be prominent: server grid or tool cards. */
  intent?: "server" | "tool";

  /** Confidence of the intent classification (0..1, best-effort). */
  intentConfidence?: number;

  /** Diagnostic info for observability and eval tooling. */
  diagnostics?: {
    serverHits: number;
    toolHits: number;
    usedToolIndex: boolean;
    fallbackReason?: string;
  };
}

/**
 * Options for a tool-index search.
 */
export interface ToolSearchOptions {
  /** Maximum number of tool results. */
  limit?: number;

  /** Offset for pagination. */
  offset?: number;

  /** Filter by parent server (exact match on server_mcp_name). */
  serverMcpName?: string;

  /** Filter by tags (AND logic). */
  tags?: string[];

  /** Filter by provider (exact match). */
  provider?: string;

  /** Query embedding vector for hybrid search. */
  vector?: number[];

  /** Include per-hit ranking scores (showRankingScore). */
  withScores?: boolean;
}

/**
 * A single tool hit from the tool index, with ranking metadata.
 */
export interface ToolDocumentHit extends ToolDocument {
  /** Relevance score (0..1) when withScores is used. */
  _rankingScore?: number;
  _semanticScore?: number;
  /** 1-based rank of this hit in the tool search. */
  _rank?: number;
}

/**
 * The result of a tool-index search.
 */
export interface ToolSearchResult {
  hits: ToolDocumentHit[];
  total: number;
  offset: number;
  limit: number;
  processingTimeMs: number;
}

/**
 * Minimal metadata about an indexed document, used for incremental sync diffs.
 */
export interface IndexListEntry {
  id: string;
  updated_at?: string;
  content_hash?: string;
  has_vector?: boolean;
}

/**
 * A normalized, embeddable document produced by the indexer.
 */
export interface IndexedDocument {
  doc: SearchDocument;
  vector: number[] | null;
}

/**
 * The pluggable search adapter interface.
 *
 * Implementations must be stateless with respect to query handling — all
 * state lives in the external search backend. The adapter is a thin
 * translation layer between the search service and the backend's native API.
 */
export interface SearchAdapter {
  /**
   * Check backend connectivity. Throws or returns false on failure.
   */
  health(): Promise<boolean>;

  /**
   * Execute a full-text search query.
   *
   * @param query - The user's search string (may be empty for browse-all).
   * @param options - Filtering and pagination options.
   * @returns Ranked search results with optional facet counts.
   */
  search(query: string, options?: SearchOptions): Promise<SearchResult>;

  /**
   * Retrieve a single document by its primary key (mcp_name).
   *
   * @param mcpName - The unique server identifier.
   * @returns The document, or null if not found.
   */
  getByName(mcpName: string): Promise<SearchDocument | null>;

  /**
   * Index (add or update) one or more documents.
   * This is an upsert operation — existing documents with the same
   * mcp_name are replaced.
   *
   * @param documents - The documents to index.
   */
  index(documents: SearchDocument[]): Promise<void>;

  /**
   * Remove a document from the index by its primary key.
   *
   * @param mcpName - The unique server identifier to remove.
   */
  remove(mcpName: string): Promise<void>;

  /**
   * Get the current facet distribution across all indexed documents.
   * Useful for populating filter dropdowns in the UI.
   *
   * @returns A map of field_name → { value → count }.
   */
  getFacets(): Promise<Record<string, Record<string, number>>>;

  /**
   * Get the total number of documents in the index.
   */
  getDocumentCount(): Promise<number>;

  /**
   * Clear all documents from the index.
   */
  clear(): Promise<void>;

  /**
   * Retrieve all indexed documents. Used for full data export (search dump).
   * Implementations should paginate the underlying backend to avoid truncation.
   */
  getAllDocuments(): Promise<SearchDocument[]>;

  // -------------------------------------------------------------------------
  // Tool index (D7 parent-child model) — optional capabilities
  // -------------------------------------------------------------------------

  /** Whether the tool index is configured/enabled for this adapter. */
  readonly toolIndexEnabled: boolean;

  /** Ensure the tool index exists with the right settings. */
  initializeTools(): Promise<void>;

  /** Index (upsert) tool documents. */
  indexTools(documents: ToolDocument[]): Promise<void>;

  /** Remove all tool documents belonging to a server. */
  removeToolsByServer(mcpName: string): Promise<void>;

  /** Remove tool documents by their document ids. */
  deleteTools(ids: string[]): Promise<void>;

  /** Execute a search against the tool index. */
  searchTools(query: string, options?: ToolSearchOptions): Promise<ToolSearchResult>;

  /** Number of documents in the tool index. */
  getToolDocumentCount(): Promise<number>;

  /** Clear all tool documents. */
  clearTools(): Promise<void>;

  /** Retrieve all tool documents (used for the dump). */
  getAllToolDocuments(): Promise<ToolDocument[]>;

  /** Minimal metadata of all server docs (incremental sync diffing). */
  getIndexList(): Promise<IndexListEntry[]>;

  /** Minimal metadata of all tool docs (incremental sync diffing). */
  getToolIndexList(): Promise<IndexListEntry[]>;

  // -------------------------------------------------------------------------
  // Embedding metadata (fingerprint)
  // -------------------------------------------------------------------------

  /** Read the persisted embedding fingerprint document (null when absent). */
  readEmbeddingMeta(): Promise<EmbeddingMeta | null>;

  /** Persist the embedding fingerprint document. */
  writeEmbeddingMeta(meta: EmbeddingMeta): Promise<void>;
}

/**
 * Persisted embedding configuration fingerprint (stored in a tiny meta index).
 * `current` describes what the running config wants; `active` describes what
 * the indexes were actually built with. A mismatch means a reindex is needed.
 */
export interface EmbeddingMeta {
  id: "embedding";
  current_fingerprint: string;
  active_fingerprint: string;
  provider: string;
  model: string;
  dimensions: number;
  updated_at: string;
}

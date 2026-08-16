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

  /** Health status from the last health check. */
  health_status?: string;

  /** ISO 8601 timestamp of the last update. */
  updated_at?: string;
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
}

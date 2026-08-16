// ---------------------------------------------------------------------------
// toolhub — Search Service
// ---------------------------------------------------------------------------
// Business logic layer that sits between the HTTP API and the search adapter.
// Validates user input, enforces limits, and provides a clean interface for
// the server to call.
// ---------------------------------------------------------------------------

import type { SearchEngineConfig } from "./config.js";
import type {
  SearchAdapter,
  SearchDocument,
  SearchHit,
  SearchOptions,
  SearchResult,
  ToolHit,
} from "./adapters/types.js";
import { Indexer } from "./indexer.js";
import { LRUCache } from "lru-cache";
import { Embedder } from "./embedder.js";

export class SearchService {
  readonly indexer: Indexer;
  private readonly embedder: Embedder;
  private activeEmbeddingJobs = 0;
  private readonly maxEmbeddingJobs = 5;

  private readonly resultCache = new LRUCache<string, SearchResult>({
    max: 1000,
    ttl: 60 * 1000, // 60 seconds
  });

  private readonly embeddingCache = new LRUCache<string, number[]>({
    max: 2000,
    ttl: 60 * 60 * 1000, // 1 hour
  });

  constructor(
    private readonly adapter: SearchAdapter,
    private readonly config: SearchEngineConfig,
    private readonly logger: Pick<Console, "info" | "warn" | "error"> = console,
  ) {
    this.embedder = new Embedder(logger);
    this.indexer = new Indexer(adapter, this.embedder, logger);
  }

  /**
   * Health check — verifies the search backend is reachable.
   */
  async health(): Promise<{
    status: string;
    service: string;
    backend: string;
    documentCount: number;
  }> {
    const backendOk = await this.adapter.health();
    let documentCount = 0;
    try {
      documentCount = await this.adapter.getDocumentCount();
    } catch {
      // Non-critical — just report 0
    }

    return {
      status: backendOk ? "ok" : "degraded",
      service: "toolhub",
      backend: this.config.searchBackend,
      documentCount,
    };
  }

  /**
   * Determine if the query warrants semantic vector search.
   */
  private shouldRunSemanticSearch(query: string): boolean {
    if (!query) return false;
    const trimmed = query.trim();
    if (trimmed.length < 3) return false;
    // Single short word is likely keyword lookup
    if (!trimmed.includes(" ") && trimmed.length < 15) return false;
    return true;
  }

  /**
   * Execute a search query with input validation, limit enforcement,
   * LRU caching, and semantic search.
   */
  async search(queryRaw: string, options?: SearchOptions): Promise<SearchResult> {
    const query = normalizeQuery(queryRaw);
    const limit = normalizeLimit(
      options?.limit,
      this.config.defaultResultsLimit,
      this.config.maxResultsLimit,
    );
    const offset = normalizeOffset(options?.offset);

    const sanitizedOptions: SearchOptions = {
      limit,
      offset,
      tags: options?.tags?.map((t) => t.trim().toLowerCase()).filter(Boolean),
      provider: options?.provider?.trim() || undefined,
      lexicalOnly: options?.lexicalOnly,
      maxTools: options?.maxTools !== undefined ? Number(options.maxTools) : 10,
    };

    // Construct cache key based on query and filters
    const cacheKey = JSON.stringify({ query, sanitizedOptions });
    const cachedResult = this.resultCache.get(cacheKey);
    if (cachedResult) {
      return {
        ...cachedResult,
        processingTimeMs: 0,
      };
    }

    // Calculate query vector if query warrants it
    let vector: number[] | undefined = undefined;
    if (!sanitizedOptions.lexicalOnly && this.shouldRunSemanticSearch(query)) {
      const cachedVector = this.embeddingCache.get(query);
      if (cachedVector) {
        vector = cachedVector;
      } else if (this.activeEmbeddingJobs >= this.maxEmbeddingJobs) {
        this.logger.warn(`[search] Embedding capacity busy (${this.activeEmbeddingJobs} jobs). Falling back to lexical search for: "${query}"`);
      } else {
        this.activeEmbeddingJobs++;
        try {
          vector = await this.embedder.embedQuery(query);
          this.embeddingCache.set(query, vector);
        } catch (err) {
          this.logger.error(`[search] Failed to generate query embedding:`, err);
        } finally {
          this.activeEmbeddingJobs--;
        }
      }
    }

    if (vector) {
      sanitizedOptions.vector = vector;
    }

    const result = await this.adapter.search(query, sanitizedOptions);
    
    // Extract tool hits
    if (query) {
      result.toolHits = this.extractToolHits(query, result.hits, sanitizedOptions.maxTools);
    } else {
      result.toolHits = [];
    }

    this.resultCache.set(cacheKey, result);
    return result;
  }

  private extractToolHits(query: string, hits: SearchHit[], maxTools: number = 10): ToolHit[] {
    if (!query) return [];
    const normalizedQuery = query.toLowerCase().trim();
    const toolHits: ToolHit[] = [];

    for (const hit of hits) {
      if (hit.capabilities && typeof hit.capabilities === "object") {
        const tools = (hit.capabilities as any).tools;
        if (Array.isArray(tools)) {
          for (const tool of tools) {
            if (!tool || typeof tool !== "object") continue;
            const name = typeof tool.name === "string" ? tool.name : "";
            const description = typeof tool.description === "string" ? tool.description : "";

            const serverMatched = 
              hit.mcp_name?.toLowerCase().includes(normalizedQuery) ||
              hit.display_name?.toLowerCase().includes(normalizedQuery) ||
              hit.description?.toLowerCase().includes(normalizedQuery) ||
              hit.tags?.some(tag => tag.toLowerCase().includes(normalizedQuery));

            if (
              serverMatched ||
              name.toLowerCase().includes(normalizedQuery) ||
              description.toLowerCase().includes(normalizedQuery)
            ) {
              toolHits.push({
                name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                compactSchema: generateCompactSchema(tool.inputSchema),
                annotations: tool.annotations,
                server_mcp_name: hit.mcp_name,
                server_display_name: hit.display_name,
                server_base_url: hit.base_url,
                server_provider: hit.provider,
                server_tags: hit.tags,
                server_health_status: hit.health_status,
                server_health_last_checked: hit.updated_at,
              });

              if (toolHits.length >= maxTools) {
                return toolHits;
              }
            }
          }
        }
      }
    }

    return toolHits;
  }

  /**
   * Get a single MCP server by name.
   */
  async getByName(mcpNameRaw: string): Promise<SearchDocument | null> {
    const mcpName = mcpNameRaw.trim().toLowerCase();
    if (!mcpName) return null;
    return this.adapter.getByName(mcpName);
  }

  /**
   * Get facet distributions for building filter UIs.
   */
  async getFacets(): Promise<Record<string, Record<string, number>>> {
    return this.adapter.getFacets();
  }

  /**
   * Evict entries from the result cache (e.g. after database changes).
   */
  clearCache(): void {
    this.resultCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, 500);
}

function normalizeLimit(
  raw: number | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (!Number.isFinite(raw) || raw === undefined) return defaultLimit;
  const parsed = Math.trunc(raw);
  if (parsed <= 0) return defaultLimit;
  return Math.min(parsed, maxLimit);
}

function normalizeOffset(raw: number | undefined): number {
  if (!Number.isFinite(raw) || raw === undefined) return 0;
  const parsed = Math.trunc(raw);
  return parsed >= 0 ? parsed : 0;
}

function generateCompactSchema(inputSchema: any): string {
  if (!inputSchema || typeof inputSchema !== "object") {
    return "—";
  }
  if (inputSchema.oneOf || inputSchema.anyOf || inputSchema.allOf) {
    return "(complex schema — see the server's full input schema)";
  }
  if (inputSchema.$ref) {
    return "(referenced schema — see the server's full input schema)";
  }

  const properties = inputSchema.properties;
  if (!properties || typeof properties !== "object") {
    if (inputSchema.type === "object" || inputSchema.additionalProperties) {
      return "— (freeform object)";
    }
    return "—";
  }

  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  const parts: string[] = [];

  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== "object") continue;
    const isReq = required.includes(key);
    let typeStr = (prop as any).type || "any";

    if (typeof (prop as any).format === "string") {
      typeStr += `:${(prop as any).format}`;
    }

    if (Array.isArray((prop as any).enum)) {
      const enumValues = (prop as any).enum;
      const enumStr = enumValues.slice(0, 5).join("|");
      const hasMore = enumValues.length > 5 ? "..." : "";
      typeStr = `${typeStr}: ${enumStr}${hasMore}`;
    }

    if (typeStr === "array" && (prop as any).items && typeof (prop as any).items === "object") {
      const itemType = (prop as any).items.type || "any";
      typeStr = `array<${itemType}>`;
    }

    let defaultStr = "";
    if ((prop as any).default !== undefined) {
      defaultStr = `=${(prop as any).default}`;
    }

    parts.push(`${key}${isReq ? "*" : ""} (${typeStr}${defaultStr})`);
  }

  if (parts.length === 0) {
    return "—";
  }

  parts.sort((a, b) => {
    const aReq = a.includes("*");
    const bReq = b.includes("*");
    if (aReq && !bReq) return -1;
    if (!aReq && bReq) return 1;
    return a.localeCompare(b);
  });

  const joined = parts.join(", ");
  if (joined.length > 200) {
    return joined.slice(0, 200) + "…";
  }
  return joined;
}

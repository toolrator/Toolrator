// ---------------------------------------------------------------------------
// toolhub — Search Service
// ---------------------------------------------------------------------------
// Business logic layer that sits between the HTTP API and the search adapter.
// Validates user input, enforces limits, and provides a clean interface for
// the server to call.
//
// D7 query flow:
//   1. embed the query ONCE
//   2. search both indexes in parallel (server index + tool index)
//   3. merge server hits via RRF with a per-server tool rollup term
//   4. roll up tool hits (capped per server, decayed)
//   5. classify intent (server-first heuristic, see classifyIntent)
// ---------------------------------------------------------------------------

import type { SearchEngineConfig } from "./config.js";
import { computeEmbeddingFingerprint } from "./fingerprint.js";
import type {
  EmbeddingMeta,
  SearchAdapter,
  SearchDocument,
  SearchHit,
  SearchOptions,
  SearchResult,
  ToolDocumentHit,
  ToolHit,
  ToolSearchResult,
} from "./adapters/types.js";
import { Indexer } from "./indexer.js";
import { LRUCache } from "lru-cache";
import { createEmbedder, type EmbeddingProvider } from "./embedder.js";

export class SearchService {
  readonly indexer: Indexer;
  private readonly embedder: EmbeddingProvider;
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
    embedder?: EmbeddingProvider,
  ) {
    this.embedder = embedder ?? createEmbedder(logger);
    this.indexer = new Indexer(adapter, this.embedder, logger);
  }

  /**
   * Health check — verifies the search backend is reachable and reports
   * index counts plus the embedding fingerprint (current vs active).
   */
  async health(): Promise<{
    status: string;
    service: string;
    backend: string;
    documentCount: number;
    toolDocumentCount: number;
    embedding: {
      provider: string;
      model: string;
      dimensions: number;
      maxInputChars: number;
      currentFingerprint: string;
      activeFingerprint: string | null;
      needsReindex: boolean;
    };
  }> {
    const backendOk = await this.adapter.health();
    let documentCount = 0;
    let toolDocumentCount = 0;
    try {
      documentCount = await this.adapter.getDocumentCount();
      if (this.adapter.toolIndexEnabled) {
        toolDocumentCount = await this.adapter.getToolDocumentCount();
      }
    } catch {
      // Non-critical — just report 0
    }

    const currentFingerprint = computeEmbeddingFingerprint(this.config);
    let activeFingerprint: string | null = null;
    try {
      const meta = await this.adapter.readEmbeddingMeta();
      activeFingerprint = meta?.active_fingerprint ?? null;
    } catch {
      // Non-critical
    }

    return {
      status: backendOk ? "ok" : "degraded",
      service: "toolhub",
      backend: this.config.searchBackend,
      documentCount,
      toolDocumentCount,
      embedding: {
        provider: this.embedder.provider,
        model: this.embedder.model,
        dimensions: this.embedder.dimensions,
        maxInputChars: this.embedder.maxInputChars,
        currentFingerprint,
        activeFingerprint,
        needsReindex: activeFingerprint !== null && activeFingerprint !== currentFingerprint,
      },
    };
  }

  /**
   * Persist the current embedding fingerprint as "active" — called after a
   * full reindex so health checks stop reporting needsReindex.
   *
   * The previous implementation preserved the *old* active fingerprint from
   * the stored meta, so after any provider/model/dimension change /health
   * kept reporting needsReindex forever and an orchestrator polling health
   * would reindex on every cooldown cycle. After a full reindex the index IS
   * built with the current config, so active must equal current.
   */
  async recordEmbeddingFingerprint(): Promise<void> {
    const currentFingerprint = computeEmbeddingFingerprint(this.config);
    const meta: EmbeddingMeta = {
      id: "embedding",
      current_fingerprint: currentFingerprint,
      active_fingerprint: currentFingerprint,
      provider: this.embedder.provider,
      model: this.embedder.model,
      dimensions: this.embedder.dimensions,
      updated_at: new Date().toISOString(),
    };
    await this.adapter.writeEmbeddingMeta(meta);
  }

  /**
   * Determine if the query warrants semantic vector search.
   */
  private shouldRunSemanticSearch(query: string): boolean {
    if (this.embedder.provider === "null" || this.embedder.dimensions <= 0) return false;
    if (!query) return false;
    const trimmed = query.trim();
    if (trimmed.length < 3) return false;
    // Single short word is likely keyword lookup
    if (!trimmed.includes(" ") && trimmed.length < 15) return false;
    return true;
  }

  /**
   * Execute a search query with input validation, limit enforcement,
   * LRU caching, and the D7 dual-index hybrid flow.
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
      maxTools: options?.maxTools !== undefined ? Number(options.maxTools) : this.config.maxToolHitsReturned,
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

    // Calculate query vector if query warrants it (embedded ONCE for both indexes)
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

    // 1. Server index search (top-K for RRF; offset applied after the merge)
    const serverResult = await this.adapter.search(query, {
      ...sanitizedOptions,
      vector,
      offset: 0,
      limit: this.config.searchServerTopK,
    });

    // 2. Tool index search — skipped for /suggest (lexicalOnly) and browse-all
    const useToolIndex =
      !!query &&
      this.adapter.toolIndexEnabled &&
      !sanitizedOptions.lexicalOnly;
    let toolResult: ToolSearchResult | null = null;
    let toolSearchError: string | undefined;
    if (useToolIndex) {
      try {
        toolResult = await this.adapter.searchTools(query, {
          vector,
          limit: this.config.searchToolTopK,
          tags: sanitizedOptions.tags,
          provider: sanitizedOptions.provider,
          withScores: true,
        });
      } catch (err) {
        toolSearchError = err instanceof Error ? err.message : String(err);
        this.logger.error(`[search] Tool index search failed (${toolSearchError}) — using legacy extraction`);
      }
    }

    // 3. Intent classification (server-first heuristic, D7)
    const intent = this.classifyIntent({
      query,
      serverHits: serverResult.hits,
      toolResult,
      toolSearchError,
    });

    // 4. RRF merge of server hits with per-server tool rollup
    const merged = rrfMerge(serverResult.hits, toolResult?.hits ?? [], this.config);
    const page = merged.slice(offset, offset + limit);

    // 5. Tool hit rollup (capped per server; more when intent is tool-first)
    const maxPerServer = intent.intent === "tool" ? 5 : 3;
    const toolHits = toolResult
      ? buildToolHits(toolResult.hits, maxPerServer, sanitizedOptions.maxTools, this.config.maxToolHitsReturned)
      : query
        ? this.extractToolHits(query, serverResult.hits, this.config.maxToolHitsReturned)
        : [];

    const result: SearchResult = {
      hits: page,
      toolHits,
      total: serverResult.total,
      offset,
      limit,
      processingTimeMs: serverResult.processingTimeMs + (toolResult?.processingTimeMs ?? 0),
      facets: serverResult.facets,
      intent: intent.intent,
      intentConfidence: intent.confidence,
      diagnostics: {
        serverHits: page.length,
        toolHits: toolHits.length,
        usedToolIndex: toolResult !== null,
        fallbackReason: toolSearchError ?? (useToolIndex && !toolResult ? "tool_index_unavailable" : undefined),
      },
    };

    this.resultCache.set(cacheKey, result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Intent classification (D7)
  // -------------------------------------------------------------------------

  private classifyIntent(params: {
    query: string;
    serverHits: SearchHit[];
    toolResult: ToolSearchResult | null;
    toolSearchError?: string;
  }): { intent: "server" | "tool"; confidence: number } {
    if (!this.config.intentEnabled) {
      return { intent: this.config.intentFallback, confidence: 0.5 };
    }
    const { query, serverHits, toolResult } = params;
    if (!query) {
      return { intent: "server", confidence: 1 };
    }
    if (!toolResult) {
      return { intent: this.config.intentFallback, confidence: 0.5 };
    }

    const q = query.toLowerCase().trim();
    const { hits } = toolResult;

    // Rule 1: exact server match → server
    for (const hit of serverHits) {
      if (
        hit.mcp_name === q ||
        hit.mcp_name === q.replace(/\s+/g, "") ||
        hit.display_name?.toLowerCase() === q
      ) {
        return { intent: "server", confidence: 0.95 };
      }
    }

    // Rule 2: exact tool match → tool
    for (const hit of hits) {
      if (hit.tool_name.toLowerCase() === q) {
        return { intent: "tool", confidence: 0.95 };
      }
    }

    // Rule 3: specific tool — strong top tool beats the competing servers by a
    // margin AND shows a cue (action verb or tool-name overlap). Evaluated
    // before the multi-tool rule: a targeted tool with a cue outranks sibling
    // clustering (e.g. "turn on the living room lights" → control_device).
    // A tool always embeds close to its own server, so when the top server
    // IS the tool's home server the margin is measured against the best
    // *other* server with a stricter threshold.
    const topTool = hits[0];
    const topServer = serverHits[0];
    if (topTool) {
      const toolScore = scoreOf(topTool);
      const home = topTool.server_mcp_name;
      const homeDominates = topServer?.mcp_name === home;
      const competitor = serverHits.find((h) => h.mcp_name !== home) ?? topServer;
      const comparisonScore = homeDominates ? scoreOf(competitor) : scoreOf(topServer);
      const requiredMargin = homeDominates
        ? this.config.intentToolMargin + 0.05
        : this.config.intentToolMargin;
      const toolName = topTool.tool_name.toLowerCase();
      const cue =
        ACTION_CUES.some((verb) => q.includes(verb)) ||
        q.split(/\s+/).some((token) => toolName.includes(token) || token.includes(toolName));
      if (
        toolScore >= this.config.intentToolMinScore &&
        toolScore - comparisonScore >= requiredMargin &&
        cue
      ) {
        return { intent: "tool", confidence: Math.min(0.9, toolScore) };
      }
    }

    // Rule 4: strong multi-tool signal from one server → server
    // ("give me all your <domain> tools" — user's aggregation idea)
    const topN = hits.slice(0, this.config.intentMultiToolTopN);
    const strongByServer = new Map<string, number>();
    for (const hit of topN) {
      if (scoreOf(hit) >= this.config.intentMultiToolMinScore) {
        strongByServer.set(hit.server_mcp_name, (strongByServer.get(hit.server_mcp_name) ?? 0) + 1);
      }
    }
    const winner = [...strongByServer.entries()].sort((a, b) => b[1] - a[1])[0];
    if (winner && winner[1] >= this.config.intentMultiToolCount) {
      return { intent: "server", confidence: 0.8 };
    }

    // Fallback
    return { intent: this.config.intentFallback, confidence: 0.5 };
  }

  /**
   * Legacy tool extraction from server hits (fallback when the tool index
   * is unavailable — deprecated in favor of the D7 tool index).
   */
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
              hit.tags?.some((tag) => tag.toLowerCase().includes(normalizedQuery));

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
   * Minimal metadata of all indexed documents (incremental sync diffing).
   */
  async getIndexList(): Promise<{ servers: Array<{ id: string; updated_at?: string; content_hash?: string; has_vector?: boolean }>; tools: Array<{ id: string; updated_at?: string; content_hash?: string; has_vector?: boolean }> }> {
    const [servers, tools] = await Promise.all([
      this.adapter.getIndexList(),
      this.adapter.toolIndexEnabled ? this.adapter.getToolIndexList() : Promise.resolve([]),
    ]);
    return { servers, tools };
  }

  /**
   * Evict entries from the result cache (e.g. after database changes).
   */
  clearCache(): void {
    this.resultCache.clear();
  }
}

// ---------------------------------------------------------------------------
// RRF merge & tool rollup
// ---------------------------------------------------------------------------

/**
 * Reciprocal-Rank-Fusion merge of direct server hits and tool-index hits.
 * Each server's score = wDirect × RRF(direct rank) + wTool × rollup, where
 * the rollup is the decayed sum of its tool hits' RRF contributions, capped
 * at the rank-1 equivalent so tool evidence refines the direct ranking
 * without overwhelming it (a server must not outrank the #1 direct hit
 * purely from having many weak tool matches).
 */
function rrfMerge(
  serverHits: SearchHit[],
  toolHits: ToolDocumentHit[],
  config: SearchEngineConfig,
): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; score: number }>();

  serverHits.forEach((hit, i) => {
    const rank = i + 1;
    scores.set(hit.mcp_name, {
      hit,
      score: config.directServerWeight * (1 / (config.rrfK + rank)),
    });
  });

  const byServer = new Map<string, ToolDocumentHit[]>();
  for (const tool of toolHits) {
    const list = byServer.get(tool.server_mcp_name);
    if (list) list.push(tool);
    else byServer.set(tool.server_mcp_name, [tool]);
  }

  // Cap the rollup at the RRF contribution of a rank-1 hit: tool evidence
  // can at most match the best direct hit, never exceed it.
  const maxRollup = 1 / (config.rrfK + 1);

  for (const [serverName, tools] of byServer) {
    const top = tools.slice(0, TOOL_ROLLUP_TOP_N);
    let rollup = 0;
    top.forEach((tool, i) => {
      const rank = tool._rank ?? i + 1;
      rollup += (TOOL_ROLLUP_DECAY[i] ?? TOOL_ROLLUP_DECAY[TOOL_ROLLUP_DECAY.length - 1]) * (1 / (config.rrfK + rank));
    });
    rollup = Math.min(rollup, maxRollup);

    const existing = scores.get(serverName);
    if (existing) {
      existing.score += config.toolRollupWeight * rollup;
    } else if (top.length > 0) {
      // Tool-only match: fabricate a minimal server card from the best tool doc
      const best = top[0];
      scores.set(serverName, {
        hit: {
          mcp_name: serverName,
          display_name: best.server_display_name,
          description: `Provides the "${best.tool_name}" tool${best.tool_description ? ` — ${best.tool_description}` : ""}`.slice(0, 500),
          tags: best.tags,
          provider: best.provider,
          base_url: best.server_base_url,
          health_status: best.health_status,
          updated_at: best.updated_at,
          capabilities: { tools: [] },
        },
        score: config.toolRollupWeight * rollup,
      });
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.hit);
}

const TOOL_ROLLUP_TOP_N = 5;
const TOOL_ROLLUP_DECAY = [1, 0.75, 0.55, 0.4, 0.3];

/**
 * Converts tool-index hits into public ToolHit cards, capped per server
 * (3 default, 5 on strong tool intent) and by the global max.
 */
function buildToolHits(
  docs: ToolDocumentHit[],
  maxPerServer: number,
  maxTools: number | undefined,
  globalMax: number,
): ToolHit[] {
  const perServer = new Map<string, number>();
  const out: ToolHit[] = [];
  const cap = Math.min(maxTools ?? globalMax, globalMax);

  for (const doc of docs) {
    const count = perServer.get(doc.server_mcp_name) ?? 0;
    if (count >= maxPerServer) continue;
    perServer.set(doc.server_mcp_name, count + 1);
    out.push({
      name: doc.tool_name,
      description: doc.tool_description,
      compactSchema: doc.compact_schema,
      server_mcp_name: doc.server_mcp_name,
      server_display_name: doc.server_display_name,
      server_base_url: doc.server_base_url,
      server_provider: doc.server_provider ?? doc.provider,
      server_tags: doc.tags,
      server_health_status: doc.health_status,
      server_health_last_checked: doc.server_health_last_checked,
    });
    if (out.length >= cap) break;
  }
  return out;
}

/** Best available relevance score of a hit (hybrid ranking score). */
function scoreOf(hit: ToolDocumentHit | SearchHit): number {
  const s = (hit as any)._rankingScore ?? (hit as any)._score;
  return typeof s === "number" && Number.isFinite(s) ? s : 0;
}

const ACTION_CUES = [
  "send", "create", "generate", "get", "fetch", "list", "search", "update",
  "delete", "post", "call", "run", "convert", "translate", "summarize",
  "execute", "add", "remove", "start", "stop", "write", "read", "set", "make",
  "build", "find", "query", "lookup", "retrieve", "check", "sync", "upload",
  "download", "copy", "move", "analyze", "calculate", "compute",
  "turn", "track", "log", "count", "scan", "shorten", "open", "close",
  "lock", "play", "schedule", "book", "order", "buy", "sell", "compare",
  "ask", "tell", "predict", "monitor", "watch", "share", "invite", "approve",
];

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
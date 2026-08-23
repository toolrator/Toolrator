import fs from "node:fs";
import path from "node:path";

// Auto-load .env from package root if present and not already loaded via --env-file
function ensureEnvLoaded() {
  if (process.env.TOOLHUB_EMBEDDING_PROVIDER) return;
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (key && !(key in process.env)) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch {}
}
ensureEnvLoaded();

export interface SearchEngineConfig {
  /** Host/interface the HTTP server binds to (127.0.0.1 by default). */
  host: string;

  /** Port the HTTP server listens on. */
  port: number;

  /** Bearer token required for admin endpoints (index, reindex, delete). */
  adminToken: string;

  /** Which search adapter backend to use. */
  searchBackend: "meilisearch" | "memory";

  /** MeiliSearch server URL (when searchBackend = "meilisearch"). */
  meiliUrl: string;

  /** MeiliSearch API key for search queries (read-only). */
  meiliSearchKey: string;

  /** MeiliSearch API key for admin/indexing operations (read-write). */
  meiliAdminKey: string;

  /** MeiliSearch index name for MCP server documents. */
  meiliIndexName: string;

  /** Whether the D7 tool index is enabled. */
  toolIndexEnabled: boolean;

  /** MeiliSearch index name for tool documents. */
  toolIndexName: string;

  /** Max number of search results returned per query. */
  maxResultsLimit: number;

  /** Default number of search results when limit is not specified. */
  defaultResultsLimit: number;

  /** Log level for the search engine. */
  logLevel: "debug" | "info" | "warn" | "error";

  /** Server top-K fetched for RRF merging (server index). */
  searchServerTopK: number;

  /** Tool top-K fetched for RRF merging (tool index). */
  searchToolTopK: number;

  /** Maximum number of tool hits returned in a search response. */
  maxToolHitsReturned: number;

  /** RRF k constant. */
  rrfK: number;

  /** Weight of the direct server score in the RRF merge. */
  directServerWeight: number;

  /** Weight of the tool rollup score in the RRF merge. */
  toolRollupWeight: number;

  /** Whether the hybrid intent classifier is enabled. */
  intentEnabled: boolean;

  /** Intent fallback when the classifier is uncertain. */
  intentFallback: "server" | "tool";

  /** Minimum tool score (0..1) for a strong tool signal. */
  intentToolMinScore: number;

  /** Margin by which the top tool must beat the top server. */
  intentToolMargin: number;

  /** Number of strong tool hits from one server to trigger server intent. */
  intentMultiToolCount: number;

  /** Top-N tool results considered for the multi-tool aggregation. */
  intentMultiToolTopN: number;

  /** Minimum score for a tool hit to count in the aggregation. */
  intentMultiToolMinScore: number;

  /** Maximum number of tools embedded per server (tool index). */
  maxToolsEmbedded: number;

  /** Maximum tool description chars embedded per tool. */
  maxToolDescChars: number;

  /** Maximum compact schema chars embedded per tool. */
  maxToolSchemaChars: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SearchEngineConfig {
  const searchBackend = readString(env, "SEARCH_BACKEND", "meilisearch");
  if (searchBackend !== "meilisearch" && searchBackend !== "memory") {
    throw new Error(`Invalid SEARCH_BACKEND: "${searchBackend}". Must be "meilisearch" or "memory".`);
  }

  return {
    host: readString(env, "HOST", "127.0.0.1"),
    port: readInt(env, "PORT", 7600),
    adminToken: readString(env, "SEARCH_ADMIN_TOKEN", "dev-admin-token"),
    searchBackend,
    meiliUrl: readString(env, "MEILI_URL", "http://localhost:7700"),
    meiliSearchKey: readString(env, "MEILI_SEARCH_KEY", ""),
    meiliAdminKey: readString(env, "MEILI_ADMIN_KEY", ""),
    meiliIndexName: readString(env, "MEILI_INDEX_NAME", "mcp_servers"),
    toolIndexEnabled: readBool(env, "TOOLHUB_TOOL_INDEX_ENABLED", true),
    toolIndexName: readString(env, "TOOLHUB_TOOL_INDEX_NAME", "mcp_tools"),
    maxResultsLimit: readInt(env, "SEARCH_MAX_LIMIT", 100),
    defaultResultsLimit: readInt(env, "SEARCH_DEFAULT_LIMIT", 20),
    logLevel: readLogLevel(env, "LOG_LEVEL", "info"),
    searchServerTopK: readInt(env, "TOOLHUB_SEARCH_SERVER_TOP_K", 20),
    searchToolTopK: readInt(env, "TOOLHUB_SEARCH_TOOL_TOP_K", 50),
    maxToolHitsReturned: readInt(env, "TOOLHUB_MAX_TOOL_HITS_RETURNED", 10),
    rrfK: readInt(env, "TOOLHUB_RRF_K", 60),
    directServerWeight: readFloat(env, "TOOLHUB_DIRECT_SERVER_WEIGHT", 0.55),
    toolRollupWeight: readFloat(env, "TOOLHUB_TOOL_ROLLUP_WEIGHT", 0.45),
    intentEnabled: readBool(env, "TOOLHUB_INTENT_ENABLED", true),
    intentFallback: readString(env, "TOOLHUB_INTENT_FALLBACK", "server") === "tool" ? "tool" : "server",
    intentToolMinScore: readFloat(env, "TOOLHUB_INTENT_TOOL_MIN_SCORE", 0.35),
    intentToolMargin: readFloat(env, "TOOLHUB_INTENT_TOOL_MARGIN", 0.05),
    intentMultiToolCount: readInt(env, "TOOLHUB_INTENT_MULTI_TOOL_COUNT", 3),
    intentMultiToolTopN: readInt(env, "TOOLHUB_INTENT_MULTI_TOOL_TOP_N", 10),
    intentMultiToolMinScore: readFloat(env, "TOOLHUB_INTENT_MULTI_TOOL_MIN_SCORE", 0.3),
    maxToolsEmbedded: readInt(env, "TOOLHUB_MAX_TOOLS_EMBEDDED", 64),
    maxToolDescChars: readInt(env, "TOOLHUB_MAX_TOOL_DESC_CHARS", 1200),
    maxToolSchemaChars: readInt(env, "TOOLHUB_MAX_TOOL_SCHEMA_CHARS", 1200),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readString(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const value = env[key];
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return fallback;
}

function readInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function readFloat(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function readBool(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const v = raw.trim().toLowerCase();
  return v !== "false" && v !== "0";
}

function readLogLevel(
  env: Record<string, string | undefined>,
  key: string,
  fallback: "debug" | "info" | "warn" | "error",
): "debug" | "info" | "warn" | "error" {
  const raw = readString(env, key, fallback).toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return fallback;
}

// ── CI DEMO: intentional type error — this PR must FAIL, do not merge ──
const CI_DEMO_BUG: number = "this string is definitely not a number";


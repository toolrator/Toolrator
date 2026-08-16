// ---------------------------------------------------------------------------
// toolhub — Configuration
// ---------------------------------------------------------------------------
// All settings are loaded from environment variables with sensible defaults
// for local development. Production deployments override via .env or Docker.
// ---------------------------------------------------------------------------

export interface SearchEngineConfig {
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

  /** Maximum number of search results returned per query. */
  maxResultsLimit: number;

  /** Default number of search results when limit is not specified. */
  defaultResultsLimit: number;

  /** Log level for the search engine. */
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SearchEngineConfig {
  const searchBackend = readString(env, "SEARCH_BACKEND", "meilisearch");
  if (searchBackend !== "meilisearch" && searchBackend !== "memory") {
    throw new Error(`Invalid SEARCH_BACKEND: "${searchBackend}". Must be "meilisearch" or "memory".`);
  }

  return {
    port: readInt(env, "PORT", 7600),
    adminToken: readString(env, "SEARCH_ADMIN_TOKEN", "dev-admin-token"),
    searchBackend,
    meiliUrl: readString(env, "MEILI_URL", "http://localhost:7700"),
    meiliSearchKey: readString(env, "MEILI_SEARCH_KEY", ""),
    meiliAdminKey: readString(env, "MEILI_ADMIN_KEY", ""),
    meiliIndexName: readString(env, "MEILI_INDEX_NAME", "mcp_servers"),
    maxResultsLimit: readInt(env, "SEARCH_MAX_LIMIT", 100),
    defaultResultsLimit: readInt(env, "SEARCH_DEFAULT_LIMIT", 20),
    logLevel: readLogLevel(env, "LOG_LEVEL", "info"),
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

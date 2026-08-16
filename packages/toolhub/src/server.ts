// ---------------------------------------------------------------------------
// toolhub — HTTP Server
// ---------------------------------------------------------------------------
// Hono-based HTTP API that exposes public search endpoints and admin
// ingestion endpoints. This is the entry point for the package.
// ---------------------------------------------------------------------------

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";

import { loadConfig, type SearchEngineConfig } from "./config.js";
import { SearchService } from "./search-service.js";
import { MemorySearchAdapter } from "./adapters/memory.js";
import { MeiliSearchAdapter } from "./adapters/meilisearch.js";
import type { SearchAdapter, SearchOptions } from "./adapters/types.js";

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

async function createAdapter(config: SearchEngineConfig): Promise<SearchAdapter> {
  if (config.searchBackend === "meilisearch") {
    const adapter = new MeiliSearchAdapter({
      url: config.meiliUrl,
      searchKey: config.meiliSearchKey,
      adminKey: config.meiliAdminKey,
      indexName: config.meiliIndexName,
    });
    await adapter.initialize();
    return adapter;
  }

  // Default: in-memory adapter for development
  console.log("[search] Using in-memory search adapter (dev mode)");
  return new MemorySearchAdapter();
}

// ---------------------------------------------------------------------------
// Auth middleware for admin endpoints
// ---------------------------------------------------------------------------

function adminAuth(config: SearchEngineConfig) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const authHeader = c.req.header("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!token || token !== config.adminToken) {
      return c.json({ error: "unauthorized" }, 401);
    }

    await next();
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApp(
  service: SearchService,
  config: SearchEngineConfig,
): Hono {
  const app = new Hono();

  app.use("*", cors());
  app.use("*", logger());

  // Request timing header
  app.use("*", async (c, next) => {
    const t0 = performance.now();
    await next();
    const duration = performance.now() - t0;
    c.res.headers.append("Server-Timing", `search;dur=${duration.toFixed(3)}`);
  });

  // ── Public Endpoints ─────────────────────────────────────────────

  /**
   * GET /health
   * Health check — includes backend connectivity and document count.
   */
  app.get("/health", async (c) => {
    const health = await service.health();
    const status = health.status === "ok" ? 200 : 503;
    return c.json(health, status);
  });

  /**
   * GET /search?q=...&tags=...&provider=...&limit=...&offset=...
   * Full-text search with optional filters and pagination.
   */
  app.get("/search", async (c) => {
    const url = new URL(c.req.url);
    const query = url.searchParams.get("q") ?? "";
    const options = parseSearchParams(url.searchParams);

    const result = await service.search(query, options);
    return c.json(result);
  });

  /**
   * GET /suggest?q=...
   * Suggest endpoint. Always uses fast lexical-only search and is heavily cached.
   */
  app.get("/suggest", async (c) => {
    const url = new URL(c.req.url);
    const query = url.searchParams.get("q") ?? "";
    const options = parseSearchParams(url.searchParams);
    
    // Force lexical only for suggestions
    options.lexicalOnly = true;
    
    // Set a lower default limit for quick autocomplete list
    if (options.limit === undefined) {
      options.limit = 5;
    }

    const result = await service.search(query, options);
    return c.json(result);
  });

  /**
   * POST /search
   * Same as GET /search but accepts a JSON body for complex queries.
   */
  app.post("/search", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const query = typeof body.query === "string" ? body.query : (typeof body.q === "string" ? body.q : "");
    const options: SearchOptions = {
      limit: typeof body.limit === "number" ? body.limit : undefined,
      offset: typeof body.offset === "number" ? body.offset : undefined,
      tags: Array.isArray(body.tags) ? body.tags.filter((t: unknown) => typeof t === "string") : undefined,
      provider: typeof body.provider === "string" ? body.provider : undefined,
      maxTools: typeof body.maxTools === "number" ? body.maxTools : undefined,
    };

    const result = await service.search(query, options);
    return c.json(result);
  });

  /**
   * GET /mcp/:name
   * Get a single MCP server by name.
   */
  app.get("/mcp/:name", async (c) => {
    const name = c.req.param("name");
    const doc = await service.getByName(name);
    if (!doc) {
      return c.json({ error: "mcp server not found" }, 404);
    }
    return c.json({ mcp_server: doc });
  });

  /**
   * GET /facets
   * Get available filter facets (tags, providers with counts).
   */
  app.get("/facets", async (c) => {
    const facets = await service.getFacets();
    return c.json({ facets });
  });

  // ── Admin Endpoints (protected) ──────────────────────────────────

  const admin = new Hono();
  admin.use("*", adminAuth(config));

  /**
   * POST /admin/index
   * Index one or more MCP server documents.
   * Body: { documents: [...] } or a single document object.
   */
  admin.post("/index", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const docs = extractDocuments(body);
    if (docs.length === 0) {
      return c.json({ error: "no documents provided" }, 400);
    }

    const count = await service.indexer.indexBatch(docs);
    service.clearCache();
    return c.json({
      success: true,
      indexed: count,
      skipped: docs.length - count,
    });
  });

  /**
   * DELETE /admin/index/:name
   * Remove a document from the index by mcp_name.
   */
  admin.delete("/index/:name", async (c) => {
    const name = c.req.param("name");
    try {
      await service.indexer.remove(name);
      service.clearCache();
      return c.json({ success: true, removed: name });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  /**
   * POST /admin/reindex
   * Full reindex from a provided payload.
   * Body: { documents: [...] }
   */
  admin.post("/reindex", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const docs = extractDocuments(body);
    if (docs.length === 0) {
      return c.json({ error: "no documents provided" }, 400);
    }

    const count = await service.indexer.reindex(docs);
    service.clearCache();
    return c.json({
      success: true,
      indexed: count,
      skipped: docs.length - count,
    });
  });

  /**
   * GET /admin/dump
   * Export all indexed documents. Used by the hourly cron to generate
   * the search index dump ZIP. Returns all documents without pagination.
   */
  admin.get("/dump", async (c) => {
    try {
      const servers = await service.indexer.adapter.getAllDocuments();
      return c.json({
        servers,
        generated_at: new Date().toISOString(),
        count: servers.length,
      });
    } catch (err) {
      console.error("[admin/dump] Failed to export documents:", err);
      return c.json({ error: "dump_failed" }, 500);
    }
  });

  app.route("/admin", admin);

  // ── Error handling ───────────────────────────────────────────────

  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.onError((error, c) => {
    console.error("[search] Unhandled error:", error);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[search] Initializing Toolhub (backend: ${config.searchBackend})...`);

  const adapter = await createAdapter(config);
  const service = new SearchService(adapter, config);
  const app = createApp(service, config);

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`\n✅ Toolhub is ready on http://localhost:${info.port}`);
    console.log(`   Search:  GET http://localhost:${info.port}/search?q=...`);
    console.log(`   Health:  GET http://localhost:${info.port}/health`);
    console.log(`   Admin:   POST http://localhost:${info.port}/admin/index`);
    console.log();
  });
}

main().catch((err) => {
  console.error("[search] Fatal startup error:", err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSearchParams(params: URLSearchParams): SearchOptions {
  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");
  const tagsRaw = params.get("tags");
  const provider = params.get("provider") ?? undefined;
  const maxToolsRaw = params.get("maxTools");

  return {
    limit: limitRaw ? Number(limitRaw) : undefined,
    offset: offsetRaw ? Number(offsetRaw) : undefined,
    tags: tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    provider,
    maxTools: maxToolsRaw ? Number(maxToolsRaw) : undefined,
  };
}

function extractDocuments(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];

  // Array of documents
  if (Array.isArray(body)) return body;

  const record = body as Record<string, unknown>;

  // Wrapped in { documents: [...] }
  if (Array.isArray(record.documents)) return record.documents;

  // Single document object
  if ("mcp_name" in record) return [record];

  return [];
}

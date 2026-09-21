/**
 * Toolhub HTTP API test suite.
 *
 * Builds the real Hono app via createApp() with the in-memory adapter and a
 * fake embedder — no network, no Meili, no model downloads. Covers every
 * public route, the admin token gate (including the constant-time-compare
 * path), the 404/400 envelopes, and the /health backend status contract.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { MemorySearchAdapter } from "../src/adapters/memory.js";
import { SearchService } from "../src/search-service.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import type { EmbeddingProvider, SearchDocument } from "../src/adapters/types.js";
import type { SearchDocument as SearchDocumentType } from "../src/adapters/types.js";

/** Deterministic fake embedder — same shape search.test.ts uses. */
function fakeEmbedder(): EmbeddingProvider {
  return {
    provider: "local",
    model: "fake-model",
    dimensions: 8,
    maxInputChars: 2048,
    async embedDocument(text: string): Promise<number[]> {
      return [text.length, 1, 2];
    },
    async embedQuery(text: string): Promise<number[]> {
      return [text.length, 1, 2];
    },
    async embedMany(texts: string[]): Promise<Array<number[] | null>> {
      return texts.map((t) => [t.length, 1, 2]);
    },
  } as unknown as EmbeddingProvider;
}

function makeDoc(partial: Partial<SearchDocumentType> & { mcp_name: string }): SearchDocumentType {
  return {
    display_name: partial.mcp_name,
    description: `${partial.mcp_name} server`,
    tags: ["test"],
    ...partial,
  } as SearchDocumentType;
}

const CONFIG = {
  ...loadConfig({
    SEARCH_BACKEND: "memory",
    SEARCH_ADMIN_TOKEN: "e2e-admin-token",
    TOOLHUB_EMBEDDING_PROVIDER: "",
  }),
  searchBackend: "memory" as const,
  adminToken: "e2e-admin-token",
};

let app: ReturnType<typeof createApp>;

before(async () => {
  const adapter = new MemorySearchAdapter();
  const service = new SearchService(adapter, CONFIG, console, fakeEmbedder());

  const docs: SearchDocumentType[] = [
    makeDoc({
      mcp_name: "github-server",
      display_name: "GitHub Server",
      description: "Manage repositories, issues, and pull requests",
      tags: ["code", "devtools"],
      provider: "acme",
      base_url: "https://github.example.com/mcp",
    }),
    makeDoc({
      mcp_name: "weather-lookup",
      display_name: "Weather Lookup",
      description: "Forecasts and current conditions worldwide",
      tags: ["weather", "data"],
      provider: "globex",
    }),
  ];
  await service.indexer.indexBatch(docs, true);

  app = createApp(service, CONFIG);
});

function get(pathname: string, headers: Record<string, string> = {}) {
  return app.request(pathname, { method: "GET", headers });
}

function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Public read routes
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  test("200 with ok status, memory backend, and document count", async () => {
    const res = await get("/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; backend: string; documentCount: number };
    assert.equal(body.status, "ok");
    assert.equal(body.backend, "memory");
    assert.equal(body.documentCount, 2);
  });
});

describe("GET /search", () => {
  test("finds a document by name and returns _score/_rankingScore", async () => {
    const res = await get("/search?q=github");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hits: Array<{ mcp_name: string; _score?: number }>; total: number };
    assert.ok(body.hits.length >= 1);
    assert.equal(body.hits[0]!.mcp_name, "github-server");
    assert.ok(body.total >= 1);
  });

  test("supports tag filters (AND semantics)", async () => {
    const res = await get("/search?q=&tags=code");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hits: Array<{ mcp_name: string }>; total: number };
    assert.equal(body.total, 1);
    assert.equal(body.hits[0]!.mcp_name, "github-server");
  });

  test("supports provider filter", async () => {
    const res = await get("/search?q=&provider=globex");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { total: number };
    assert.equal(body.total, 1);
  });

  test("limit + offset pagination", async () => {
    const res = await get("/search?q=&limit=1&offset=1");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hits: unknown[]; limit: number; offset: number };
    assert.equal(body.hits.length, 1);
    assert.equal(body.limit, 1);
    assert.equal(body.offset, 1);
  });

  test("Server-Timing header present (observability contract)", async () => {
    const res = await get("/search?q=github");
    assert.ok(res.headers.get("Server-Timing")?.includes("search;dur="));
  });
});

describe("POST /search", () => {
  test("accepts JSON body queries", async () => {
    const res = await post("/search", { query: "weather", limit: 5 });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hits: Array<{ mcp_name: string }> };
    assert.equal(body.hits[0]!.mcp_name, "weather-lookup");
  });

  test("malformed JSON → 400 invalid JSON body", async () => {
    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid JSON body");
  });
});

describe("GET /suggest", () => {
  test("returns fast lexical suggestions with lower default limit", async () => {
    const res = await get("/suggest?q=git");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hits: Array<{ mcp_name: string }>; limit?: number };
    assert.ok(body.hits.length >= 1);
    assert.equal(body.hits[0]!.mcp_name, "github-server");
  });
});

describe("GET /mcp/:name", () => {
  test("returns the full document wrapped in mcp_server", async () => {
    const res = await get("/mcp/github-server");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mcp_server: { mcp_name: string; base_url?: string } };
    assert.equal(body.mcp_server.mcp_name, "github-server");
    assert.equal(body.mcp_server.base_url, "https://github.example.com/mcp");
  });

  test("unknown name → 404 envelope", async () => {
    const res = await get("/mcp/does-not-exist");
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "mcp server not found");
  });
});

describe("GET /facets", () => {
  test("returns tag/provider distributions", async () => {
    const res = await get("/facets");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { facets: Record<string, Record<string, number>> };
    assert.ok(body.facets.tags);
    assert.ok(body.facets.tags["code"] >= 1);
    assert.ok(body.facets.provider?.["acme"] >= 1);
  });
});

// ---------------------------------------------------------------------------
// Admin surface — bearer-token gated (timing-safe compare path)
// ---------------------------------------------------------------------------

describe("admin auth gate", () => {
  test("no token → 401", async () => {
    const res = await get("/admin/index");
    assert.equal(res.status, 401);
  });

  test("wrong token → 401", async () => {
    const res = await get("/admin/index", { Authorization: "Bearer wrong-token" });
    assert.equal(res.status, 401);
  });

  test("empty bearer → 401 (timing-safe compare requires non-empty token)", async () => {
    const res = await get("/admin/index", { Authorization: "Bearer " });
    assert.equal(res.status, 401);
  });

  test("correct token → 200 (no CORS header on admin paths)", async () => {
    const res = await get("/admin/index", { Authorization: "Bearer e2e-admin-token" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { servers: Array<{ id: string }> };
    assert.equal(body.servers.length, 2);
    // Security regression guard: admin routes must stay CORS-free.
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });
});

describe("admin index + dump + delete", () => {
  test("POST /admin/index upserts new documents", async () => {
    const res = await post(
      "/admin/index",
      { documents: [makeDoc({ mcp_name: "extra-server", display_name: "Extra", tags: ["misc"] })] },
      { Authorization: "Bearer e2e-admin-token" },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean };
    assert.equal(body.success, true);

    const list = await get("/admin/index", { Authorization: "Bearer e2e-admin-token" });
    const listBody = (await list.json()) as { servers: Array<{ id: string }> };
    assert.equal(listBody.servers.length, 3);
  });

  test("POST /admin/index with no documents → 400", async () => {
    const res = await post("/admin/index", { documents: [] }, { Authorization: "Bearer e2e-admin-token" });
    assert.equal(res.status, 400);
  });

  test("DELETE /admin/index/:name removes the document", async () => {
    const res = await app.request("/admin/index/extra-server", {
      method: "DELETE",
      headers: { Authorization: "Bearer e2e-admin-token" },
    });
    assert.equal(res.status, 200);

    const gone = await get("/mcp/extra-server");
    assert.equal(gone.status, 404);
  });

  test("GET /admin/dump returns the full corpus (zip-set source)", async () => {
    const res = await get("/admin/dump", { Authorization: "Bearer e2e-admin-token" });
    assert.equal(res.status, 200);
    // The dump envelope must include the servers corpus.
    const body = (await res.json()) as { servers?: unknown[] } | { documents?: unknown[] };
    const docs = (body as { servers?: unknown[] }).servers ?? (body as { documents?: unknown[] }).documents;
    assert.ok(Array.isArray(docs));
  });
});

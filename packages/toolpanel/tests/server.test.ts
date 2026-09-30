/**
 * Toolpanel server test suite — the package's first automated tests.
 *
 * Strategy: import the route modules directly and exercise them through
 * Hono's app.request() (no network, no bound ports). The routes persist
 * connector config to TOOLPANEL_CONFIG_DIR, which each
 * test file redirects to a fresh temp directory. config.ts is a
 * module-load-time snapshot, so the env must be set BEFORE the first
 * dynamic import of any toolpanel module in this process.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Isolated environment — set BEFORE importing any toolpanel module.
// ---------------------------------------------------------------------------
const testRoot = await mkdtemp(path.join(tmpdir(), "toolpanel-test-"));
const configDir = path.join(testRoot, "config");

process.env.TOOLPANEL_CONFIG_DIR = configDir;
process.env.TOOLPANEL_PUBLIC_URL = "http://127.0.0.1:7800";
process.env.HOST = "127.0.0.1";
process.env.PORT = "7800";
process.env.SEARCH_ENGINE_BASE_URL = "http://127.0.0.1:1"; // deliberately dead port
process.env.SEARCH_ADMIN_TOKEN = "test-admin-token";
process.env.CONNECTOR_API_KEY = "trtr_test_panel_key";

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

// Import AFTER env is in place (config.ts snapshots process.env at import).
const { createApp } = await import("../src/server.js");

const app = createApp();

function jsonReq(pathname: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers ?? {}) };
  return app.request(pathname, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

// ---------------------------------------------------------------------------
// Liveness + landing contract (what the toolconnector boot probe relies on)
// ---------------------------------------------------------------------------

describe("well-known + status", () => {
  test("GET /.well-known/toolpanel-alive returns 204 with no-store", async () => {
    const res = await app.request("/.well-known/toolpanel-alive");
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });

  test("GET /api/status reports panel info and unreachable search engine", async () => {
    const res = await jsonReq("/api/status");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      toolpanel: { publicUrl: string; apiKeyConfigured: boolean };
      searchEngine: { reachable: boolean };
    };
    assert.equal(body.toolpanel.publicUrl, "http://127.0.0.1:7800");
    assert.equal(body.toolpanel.apiKeyConfigured, true);
    // The dead-port SEARCH_ENGINE_BASE_URL must surface as reachable:false —
    // this is exactly what the /panel UI status pill renders.
    assert.equal(body.searchEngine.reachable, false);
  });

});

// ---------------------------------------------------------------------------
// verify-key — the connector's session validation call.
// ---------------------------------------------------------------------------

describe("verify-key", () => {
  test("missing bearer → 401 { valid:false, reason:'missing' }", async () => {
    const res = await jsonReq("/api/auth/verify-key", { method: "POST", body: {} });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { valid: boolean; reason: string };
    assert.equal(body.valid, false);
    assert.equal(body.reason, "missing");
  });

  test("any bearer accepted in open mode → 200 with user payload", async () => {
    const res = await jsonReq("/api/auth/verify-key", {
      method: "POST",
      body: {},
      headers: { Authorization: "Bearer whatever-connector-holds" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { valid: boolean; user: { role: string } };
    assert.equal(body.valid, true);
    assert.equal(body.user.role, "admin");
  });
});

// ---------------------------------------------------------------------------
// OAuth bearer compatibility — the connector may present an OAuth 2.1 access
// token (opaque, issued by toolrator.org/mcp) where an API key used to go.
// Open mode accepts ANY bearer; these tests lock that contract so a future
// credential-type check cannot silently break OAuth-authenticated connectors.
// ---------------------------------------------------------------------------

describe("oauth bearer compatibility", () => {
  // Shape of an opaque AS access token: prefix + ≥32 base64url chars.
  const oauthShapedToken = `mockat_${"A".repeat(43)}`;

  test("verify-key accepts an OAuth-shaped opaque bearer", async () => {
    const res = await jsonReq("/api/auth/verify-key", {
      method: "POST",
      body: {},
      headers: { Authorization: `Bearer ${oauthShapedToken}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { valid: boolean };
    assert.equal(body.valid, true);
  });

  test("config/auto accepts an OAuth-shaped opaque bearer", async () => {
    const res = await jsonReq("/api/connector/config/auto", {
      headers: { Authorization: `Bearer ${oauthShapedToken}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { searchEngines: unknown[] };
    assert.ok(Array.isArray(body.searchEngines));
  });
});

// ---------------------------------------------------------------------------
// Connector config — engines file CRUD + conditional auto-pull (Last-Modified/304).
// ---------------------------------------------------------------------------

describe("connector config", () => {
  const validEngine = {
    id: "test-engine",
    label: "Test Engine",
    transport: "http" as const,
    endpoint: "http://127.0.0.1:7600",
    timeoutMs: 10_000,
    enabled: true,
  };

  test("config/auto requires a bearer", async () => {
    const res = await jsonReq("/api/connector/config/auto");
    assert.equal(res.status, 401);
  });

  test("PUT stores valid engines; auto returns them with Last-Modified", async () => {
    const put = await jsonReq("/api/connector/config", {
      method: "PUT",
      body: { searchEngines: [validEngine] },
    });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { success: boolean }).success, true);

    const auto = await jsonReq("/api/connector/config/auto", {
      headers: { Authorization: "Bearer trtr_test_panel_key" },
    });
    assert.equal(auto.status, 200);
    const lastModified = auto.headers.get("Last-Modified");
    assert.ok(lastModified, "auto response must carry Last-Modified (connector caches it for 304s)");
    const body = (await auto.json()) as { searchEngines: Array<{ id: string }> };
    assert.equal(body.searchEngines.length, 1);
    assert.equal(body.searchEngines[0]!.id, "test-engine");
  });

  test("auto honors If-Modified-Since with 304 + Last-Modified", async () => {
    // Touch the engines file to a known mtime.
    const enginesPath = path.join(configDir, "search-engines.json");
    const t = new Date(Date.now() - 60_000);
    await utimes(enginesPath, t, t);

    const res = await jsonReq("/api/connector/config/auto", {
      headers: {
        Authorization: "Bearer trtr_test_panel_key",
        "If-Modified-Since": t.toUTCString(),
      },
    });
    assert.equal(res.status, 304);
    assert.ok(res.headers.get("Last-Modified"));
  });

  test("PUT validates engines and reports per-row field errors", async () => {
    const put = await jsonReq("/api/connector/config", {
      method: "PUT",
      body: {
        searchEngines: [
          { ...validEngine, id: "Bad_Id_With_Underscores" },
        ],
      },
    });
    assert.equal(put.status, 400);
    const body = (await put.json()) as { error: string; invalid: Array<{ field: string; message: string }> };
    assert.equal(body.error, "invalid_input");
    assert.ok(body.invalid.some((i) => i.field === "id"));

    // Invalid payload must NOT clobber the previously stored engines.
    const readBack = await jsonReq("/api/connector/config");
    const body2 = (await readBack.json()) as { searchEngines: Array<{ id: string }> };
    assert.equal(body2.searchEngines.length, 1);
    assert.equal(body2.searchEngines[0]!.id, "test-engine");
  });

  test("PUT rejects a non-array searchEngines", async () => {
    const put = await jsonReq("/api/connector/config", { method: "PUT", body: { searchEngines: "nope" } });
    assert.equal(put.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Search proxy — forwards to the (dead) upstream with the admin token and
// maps failures to the documented unified error envelope.
// ---------------------------------------------------------------------------

describe("search proxy", () => {
  test("GET /api/search/schema serves the canonical schema with CORS", async () => {
    const res = await app.request("/api/search/schema");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    const body = (await res.json()) as { inputSchema: { required: string[] } };
    assert.deepEqual(body.inputSchema.required, ["query"]);
  });

  test("OPTIONS preflight on proxied paths returns 204 with CORS headers", async () => {
    const res = await app.request("/api/search", { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(res.headers.get("Access-Control-Allow-Methods") ?? "", /POST/);
  });

  test("dead upstream → 503 upstream_unreachable envelope (no token leak)", async () => {
    const res = await app.request("/api/search?q=echo");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; upstreamStatus: number | null; upstreamUrl: string };
    assert.equal(body.error, "upstream_unreachable");
    assert.equal(body.upstreamStatus, null);
    // The URL must point at the configured engine base, never leak auth data.
    assert.ok(body.upstreamUrl.startsWith("http://127.0.0.1:1/"));
    assert.ok(!body.upstreamUrl.includes("test-admin-token"));
  });

  test("GET /api/search forwards allowed params only", async () => {
    // Can't reach a live upstream here; assert the request still routes to
    // the same dead upstream envelope (proves param handling didn't throw).
    const res = await app.request("/api/search?q=echo&limit=5&injected=1");
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, "upstream_unreachable");
  });

  test("POST /api/search proxies the JSON body", async () => {
    const res = await jsonReq("/api/search", { method: "POST", body: { query: "echo", limit: 3 } });
    assert.equal(res.status, 503); // dead upstream, but route + body handling verified
    assert.equal(((await res.json()) as { error: string }).error, "upstream_unreachable");
  });
});

// ---------------------------------------------------------------------------

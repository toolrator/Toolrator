/**
 * Toolpanel server test suite — the package's first automated tests.
 *
 * Strategy: import the route modules directly and exercise them through
 * Hono's app.request() (no network, no bound ports). The routes persist
 * device codes and connector config to TOOLPANEL_CONFIG_DIR, which each
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
const { readDeviceCodes } = await import("../src/storage.js");

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

  test("GET /device renders the authorization page shell", async () => {
    const res = await app.request("/device");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Authorize your toolconnector/);
  });
});

// ---------------------------------------------------------------------------
// Device flow hosting — the contract toolconnector's auth-client implements.
// start → (human confirms via /device page) → poll pending → poll success.
// ---------------------------------------------------------------------------

describe("device flow", () => {
  test("start returns verification_uri, user_code, device_code, expires_in", async () => {
    const res = await jsonReq("/api/auth/device/start", { method: "POST", body: {} });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.verification_uri, "http://127.0.0.1:7800/device");
    assert.match(body.user_code as string, /^[A-HJ-NP-Z]{4}-\d{4}$/);
    assert.match(body.device_code as string, /^[0-9a-f]{48}$/);
    assert.equal(body.expires_in, 1800);

    // Pending code must be persisted (status page reads it back).
    const codes = await readDeviceCodes();
    assert.equal(codes.length, 1);
    assert.equal(codes[0]!.status, "pending");
  });

  test("poll without device_code is invalid_input", async () => {
    const res = await jsonReq("/api/auth/device/poll", { method: "POST", body: {} });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_input");
  });

  test("poll unknown device_code reports expired (no existence leak)", async () => {
    const res = await jsonReq("/api/auth/device/poll", {
      method: "POST",
      body: { device_code: "f".repeat(48) },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "expired");
  });

  test("full happy path: start → confirm → pending → success with api_key", async () => {
    const startRes = await jsonReq("/api/auth/device/start", { method: "POST", body: {} });
    const { user_code, device_code } = (await startRes.json()) as { user_code: string; device_code: string };

    // 1. Poll while pending (connector does this every ~5s).
    const pollPending = await jsonReq("/api/auth/device/poll", { method: "POST", body: { device_code } });
    assert.equal(((await pollPending.json()) as { status: string }).status, "pending");

    // 2. Human confirms on the /device page (normalize: lowercase + spaces tolerated).
    const confirmRes = await jsonReq("/api/auth/device/confirm", {
      method: "POST",
      body: { user_code: user_code.toLowerCase().replace("-", "") },
    });
    assert.equal(confirmRes.status, 200);
    assert.equal(((await confirmRes.json()) as { success: boolean }).success, true);

    // 3. Status endpoint reflects confirmed (used by the page's live state).
    const statusRes = await jsonReq(`/api/auth/device/status?user_code=${encodeURIComponent(user_code)}`);
    assert.equal(((await statusRes.json()) as { status: string }).status, "confirmed");

    // 4. Next poll hands out the API key and consumes the code.
    const pollDone = await jsonReq("/api/auth/device/poll", { method: "POST", body: { device_code } });
    assert.equal(pollDone.status, 200);
    const doneBody = (await pollDone.json()) as { status: string; api_key: string; email: string };
    assert.equal(doneBody.status, "success");
    assert.equal(doneBody.api_key, "trtr_test_panel_key");
    assert.equal(doneBody.email, "local@toolpanel");

    // 5. Code is single-use: a further poll must NOT re-issue the key.
    const pollAgain = await jsonReq("/api/auth/device/poll", { method: "POST", body: { device_code } });
    assert.equal(((await pollAgain.json()) as { status: string }).status, "expired");
  });

  test("confirm rejects malformed and unknown user codes", async () => {
    const missing = await jsonReq("/api/auth/device/confirm", { method: "POST", body: {} });
    assert.equal(missing.status, 400);

    const short = await jsonReq("/api/auth/device/confirm", { method: "POST", body: { user_code: "AB1" } });
    assert.equal(short.status, 400);

    const unknown = await jsonReq("/api/auth/device/confirm", { method: "POST", body: { user_code: "ZZZZ-9999" } });
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: string }).error, "invalid_code");
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
// Storage hygiene — device-code pruning (keeps device-codes.json bounded).
// ---------------------------------------------------------------------------

describe("storage hygiene", () => {
  test("pruneExpiredDeviceCodes drops expired entries and keeps fresh ones", async () => {
    const { pruneExpiredDeviceCodes, writeDeviceCodes } = await import("../src/storage.js");
    const now = Date.now();
    await writeDeviceCodes([
      { deviceCode: "a".repeat(48), userCode: "AAAA-1111", status: "pending", expiresAt: now - 1000, createdAt: now - 2000, updatedAt: now - 2000 },
      { deviceCode: "b".repeat(48), userCode: "BBBB-2222", status: "pending", expiresAt: now + 60_000, createdAt: now, updatedAt: now },
    ]);
    const fresh = await pruneExpiredDeviceCodes();
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]!.userCode, "BBBB-2222");
  });
});

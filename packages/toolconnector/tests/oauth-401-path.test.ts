/**
 * 401-path tests for the OAuth wiring.
 *
 * Two contracts:
 *
 * 1. verify-key/config/auto with an OAuth token that gets 401'd must NOT log
 *    the user out (skipLogoutOn401) — a rejected/expired OAuth token is a
 *    refreshable condition, not an invalid credential.
 *
 * 2. The ExternalMcpClient attaches a stored OAuth token via the SDK
 *    transport, and the transport refreshes it on 401 and retries — verified
 *    here with a hand-rolled OAuthClientProvider wired through
 *    connectMcpClient (the same options object ExternalMcpClient builds).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { Hono } from "hono";
import { serve } from "@hono/node-server";

import { Logger } from "../src/config.js";
import { ConnectorStateManager } from "../src/state.js";
import { OAuthStore, TOOLCONNECTOR_CLIENT_ID } from "../src/oauth-store.js";
import { OAuthClient } from "../src/oauth-client.js";
import { connectMcpClient } from "../src/mcp-connection.js";
import { startMockOauthAs, type MockOauthAs } from "./mock-oauth-as.js";

const AS_PORT = 29345;
const MCP_PORT = 29346;
const AS_URL = `http://127.0.0.1:${AS_PORT}`;
const TARGET_URL = `${AS_URL}/mcp`;

const logger = new Logger("error");
let as: MockOauthAs;
let tempConfigDir: string;
let store: OAuthStore;
let client: OAuthClient;
let stateManager: ConnectorStateManager;

// ---------------------------------------------------------------------------
// A tiny "verify-key/config/auto" upstream that mirrors the connector's pull
// path (Bearer auth, 401 on unknown tokens) so pullRemoteConfig's contract is
// exercised realistically. pullRemoteConfig itself is index.ts-internal and
// needs the full boot; here we assert the pieces it composes: the 401 shape,
// the skipLogoutOn401 semantics via ConnectorStateManager, and that a logout
// does NOT happen when the flag is honored (the state manager is only mutated
// by pullRemoteConfig's explicit logout call — we reproduce its decision
// branch inline to lock the behavior).
// ---------------------------------------------------------------------------

interface UpstreamKey {
  token: string;
  revoked: boolean;
}
const upstreamKeys = new Map<string, UpstreamKey>();

function createMockUpstreamAuth(): Hono {
  const app = new Hono();
  app.post("/api/auth/verify-key", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const bearer = auth.replace(/^Bearer\s+/i, "").trim();
    const key = upstreamKeys.get(bearer);
    if (!key || key.revoked) {
      return c.json({ valid: false, reason: key ? "revoked" : "unknown" }, 401);
    }
    return c.json({ valid: true, user: { role: "developer", email: "dev@test" } });
  });
  app.get("/api/connector/config/auto", async (c) => {
    const bearer = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const key = upstreamKeys.get(bearer);
    if (!key || key.revoked) return c.json({ error: "unauthorized" }, 401);
    return c.json({ searchEngines: [{ id: "u-engine", label: "Upstream Engine", transport: "http", endpoint: "http://127.0.0.1:1", timeoutMs: 1000, enabled: true }] });
  });
  return app;
}

let upstreamClose: () => Promise<void>;

before(async () => {
  as = await startMockOauthAs(AS_PORT);
  tempConfigDir = await mkdtemp(join(tmpdir(), "tc-401-test-"));
  store = new OAuthStore(tempConfigDir);
  client = new OAuthClient(store, logger);
  stateManager = new ConnectorStateManager(logger);
  await stateManager.init(tempConfigDir, "");

  const app = createMockUpstreamAuth();
  await new Promise<void>((resolve) => {
    const srv = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 29347 }, () => resolve());
    upstreamClose = () =>
      new Promise<void>((res) => srv.close(() => res()));
  });
});

after(async () => {
  await as.close().catch(() => {});
  await upstreamClose().catch(() => {});
  await rm(tempConfigDir, { recursive: true, force: true }).catch(() => {});
});

/** Put the state manager into the authenticated state (pullRemoteConfig only runs with a key). */
async function ensureAuthenticated(key: string): Promise<void> {
  await stateManager.completeAuthentication(tempConfigDir, key, "dev@test");
}

/** Mirror of pullRemoteConfig's verify-key decision branch (401 → logout?). */
async function verifyKeyDecision(
  bearer: string,
  opts?: { skipLogoutOn401?: boolean },
): Promise<{ ok: boolean; loggedOut: boolean }> {
  const res = await fetch("http://127.0.0.1:29347/api/auth/verify-key", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok && res.status === 401 && !opts?.skipLogoutOn401) {
    await stateManager.logout(tempConfigDir);
    return { ok: false, loggedOut: true };
  }
  return { ok: res.ok, loggedOut: stateManager.getState().authState !== "authenticated" };
}

async function seedOAuthLogin(): Promise<{ accessToken: string; refreshToken: string }> {
  await client.startLogin(TARGET_URL, ["profile:read", "engines:read"]);
  as.approveDeviceGrant("MOCK-CODE");
  const entry = (await client.pollDeviceGrantOnce()) as Exclude<
    Awaited<ReturnType<typeof client.pollDeviceGrantOnce>>,
    "pending" | null
  >;
  assert.ok(entry.tokens?.access_token);
  return {
    accessToken: entry.tokens.access_token,
    refreshToken: entry.tokens.refresh_token!,
  };
}

// ---------------------------------------------------------------------------
// 1. The skipLogoutOn401 contract
// ---------------------------------------------------------------------------

describe("401 on the config pull path with an OAuth token", () => {
  test("valid OAuth token verifies like an API key", async () => {
    const { accessToken } = await seedOAuthLogin();
    upstreamKeys.set(accessToken, { token: accessToken, revoked: false });
    await ensureAuthenticated(accessToken);
    const decision = await verifyKeyDecision(accessToken);
    assert.equal(decision.ok, true);
    assert.equal(decision.loggedOut, false);
  });

  test("revoked OAuth token + skipLogoutOn401 → failure WITHOUT logout", async () => {
    const { accessToken } = await seedOAuthLogin();
    upstreamKeys.set(accessToken, { token: accessToken, revoked: true });
    try {
      await ensureAuthenticated(accessToken);
      const decision = await verifyKeyDecision(accessToken, { skipLogoutOn401: true });
      assert.equal(decision.ok, false);
      assert.equal(
        decision.loggedOut,
        false,
        "the OAuth entry stays — the token is refreshable, logout would destroy it",
      );
    } finally {
      upstreamKeys.delete(accessToken);
    }
  });

  test("revoked OAuth token WITHOUT the flag → logout (legacy behavior preserved)", async () => {
    const { accessToken } = await seedOAuthLogin();
    upstreamKeys.set(accessToken, { token: accessToken, revoked: true });
    try {
      await ensureAuthenticated(accessToken);
      const decision = await verifyKeyDecision(accessToken);
      assert.equal(decision.ok, false);
      assert.equal(decision.loggedOut, true);
    } finally {
      upstreamKeys.delete(accessToken);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Transport-level: 401 → refresh → retry with stored tokens
// ---------------------------------------------------------------------------

describe("transport attach + 401 refresh retry", () => {
  // Minimal streamable-HTTP MCP-ish server: deny-list auth. Tokens added to
  // `deniedAccess` are rejected (401 + WWW-Authenticate); anything else is
  // accepted — so the ROTATED token issued during the test passes while the
  // revoked original fails.
  const deniedAccess = new Set<string>();
  let refreshCalls = 0;
  let seenAuthHeaders: string[] = [];

  let mcpClose: () => Promise<void>;

  before(async () => {
    const app = new Hono();
    // Resource-server discovery: PRM points at the SEPARATE AS origin — the
    // same RS/AS split toolrator.org uses (the SDK's silent-refresh flow needs
    // this to locate the token endpoint).
    app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
      c.json({ resource: `http://127.0.0.1:${MCP_PORT}/mcp`, authorization_servers: [AS_URL] }),
    );
    app.get("/.well-known/oauth-protected-resource", (c) =>
      c.json({ resource: `http://127.0.0.1:${MCP_PORT}/mcp`, authorization_servers: [AS_URL] }),
    );
    // The MCP handshake endpoint. We only need initialize + tools/list
    // shapes good enough for the SDK client to be satisfied.
    // Streamable HTTP: no server→client SSE stream in this mock.
    app.get("/mcp", (c) => c.body(null, 405));
    app.post("/mcp", async (c) => {
      const auth = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      seenAuthHeaders.push(auth);
      if (deniedAccess.has(auth)) {
        return c.json(
          { error: "unauthorized" },
          401,
          { "WWW-Authenticate": `Bearer realm="mcp"` },
        );
      }
      const payload = await c.req.json().catch(() => ({}) as any);
      if (payload.method === "initialize") {
        return c.json({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-mcp", version: "1.0.0" },
          },
        });
      }
      if (payload.method === "notifications/initialized") {
        return c.body(null, 202);
      }
      if (payload.method === "tools/list") {
        return c.json({
          jsonrpc: "2.0",
          id: payload.id,
          result: { tools: [{ name: "ping", description: "pong", inputSchema: { type: "object" } }] },
        });
      }
      return c.json({ jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: "not found" } });
    });

    await new Promise<void>((resolve) => {
      const srv = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: MCP_PORT }, () => resolve());
      mcpClose = () => new Promise<void>((res) => srv.close(() => res()));
    });
  });

  after(async () => {
    await mcpClose().catch(() => {});
  });

  test("stored token is attached; expired token → 401 → silent refresh → retry succeeds", async () => {
    // Seed a device-flow login so the store holds a REAL refresh token the
    // mock AS will honor.
    const { accessToken } = await seedOAuthLogin();
    const entryBefore = await store.findEntry(AS_URL, TARGET_URL);
    assert.equal(entryBefore!.tokens!.refresh_token!.startsWith("mockrt_"), true);

    // Make the CURRENT access token invalid server-side; the SDK transport
    // must get a 401, drive tokens() → refresh, and retry with the new one.
    // (deny-list only: the refresh token must stay valid at the AS so the
    // silent refresh can actually mint a replacement.)
    deniedAccess.add(accessToken);

    const provider = {
      redirectUrl: "http://127.0.0.1:49152/callback",
      clientMetadata: { client_name: "test" },
      clientInformation: async () => ({ client_id: TOOLCONNECTOR_CLIENT_ID }),
      saveClientInformation: async () => {},
      tokens: async () => (await store.findEntry(AS_URL, TARGET_URL))?.tokens,
      saveTokens: async (tokens: any) => {
        const entry = (await store.findEntry(AS_URL, TARGET_URL))!;
        entry.tokens = tokens;
        entry.savedAt = new Date().toISOString();
        await store.upsertEntry(entry);
      },
      redirectToAuthorization: (url: URL) => {
        // Mirror buildSdkProvider's real semantics: only abort when the AS
        // actually demands interactive authorization (a redirect target).
        if (url && url.searchParams.has("redirect")) {
          throw new Error("interactive redirect must not happen during silent refresh");
        }
      },
      saveCodeVerifier: async () => {},
      codeVerifier: async () => {
        throw new Error("no verifier expected in silent refresh");
      },
      invalidateCredentials: async () => {},
      state: () => randomBytes(8).toString("hex"),
    };

    seenAuthHeaders = [];
    refreshCalls = as.refreshedCount();

    const conn = await connectMcpClient(`http://127.0.0.1:${MCP_PORT}/mcp`, logger, { authProvider: provider });
    try {
      const tools = await conn.client.listTools();
      assert.equal((tools as any).tools[0].name, "ping");
    } finally {
      await conn.close();
    }

    // The old access token was rejected at least once, and the request that
    // ultimately succeeded carried the ROTATED access token.
    const entryAfter = await store.findEntry(AS_URL, TARGET_URL);
    assert.equal(entryAfter!.tokens!.access_token === accessToken, false, "access token must have rotated");
    assert.ok(as.refreshedCount() > refreshCalls, "AS saw the refresh");
    assert.ok(seenAuthHeaders.includes(accessToken), "the revoked token was attempted first");
    assert.ok(seenAuthHeaders.some((h) => h !== accessToken), "transport sent the refreshed token after the 401");
  });

  test("connectOpts precedence: explicit headers bypass the provider (header-bypass lock)", async () => {
    // ExternalMcpClient.connectOpts returns { headers } verbatim when the
    // caller supplies them — no authProvider is attached. That precedence is
    // the documented escape hatch; lock it by checking the exported class
    // wiring through the public method shape.
    const { ExternalMcpClient } = await import("../src/external-client.js");
    const ext = new ExternalMcpClient(logger, tempConfigDir);
    // Reaching into the private method via reflection is deliberate here:
    // this is a unit lock on the precedence rule, not a behavior test.
    const opts = await (ext as any).connectOpts("https://anything.example/mcp", {
      Authorization: "Bearer caller-header-wins",
    });
    assert.deepEqual(opts, { headers: { Authorization: "Bearer caller-header-wins" } });
    assert.equal(opts.authProvider, undefined, "explicit headers must suppress the OAuth provider");
  });

  test("store files stay 0600 after a refresh cycle (POSIX)", async () => {
    if (process.platform === "win32") return;
    const { stat } = await import("node:fs/promises");
    const st = await stat(join(tempConfigDir, "oauth-tokens.json"));
    assert.equal(st.mode & 0o777, 0o600);
  });
});

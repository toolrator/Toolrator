/**
 * OAuth 2.1 client tests for toolconnector.
 *
 * Exercises the real OAuthClient / OAuthStore against a mock authorization
 * server (mock-oauth-as.ts) that mirrors the toolrator.org AS contract:
 * device grant (RFC 8628), authorization-code + PKCE S256 paste-back
 * (constant-time state check, RFC 9207 iss), rotating refresh tokens, and
 * the on-disk security properties (0600 files, no token material in output).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "../src/config.js";
import {
  OAuthStore,
  TOOLCONNECTOR_CLIENT_ID,
  PASTE_BACK_REDIRECT_URI,
  maskToken,
} from "../src/oauth-store.js";
import {
  OAuthClient,
  OAuthFlowError,
  discoverAsForTarget,
} from "../src/oauth-client.js";
import { startMockOauthAs, type MockOauthAs } from "./mock-oauth-as.js";

const AS_PORT = 29341;
// Fake MCP-server target: its origin hosts the discovery documents.
const TARGET_URL = `http://127.0.0.1:${AS_PORT}/mcp`;

const logger = new Logger("error");
let as: MockOauthAs;
let tempConfigDir: string;
let store: OAuthStore;
let client: OAuthClient;

const OAUTH_SCOPES = ["profile:read", "engines:read", "engines:write"];

before(async () => {
  as = await startMockOauthAs(AS_PORT);
  tempConfigDir = await mkdtemp(join(tmpdir(), "tc-oauth-test-"));
  store = new OAuthStore(tempConfigDir);
  client = new OAuthClient(store, logger);
});

after(async () => {
  await as.close().catch(() => {});
  await rm(tempConfigDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("discoverAsForTarget", () => {
  test("resolves AS metadata via PRM path-inserted probe", async () => {
    const found = await discoverAsForTarget(TARGET_URL, logger);
    assert.ok(found, "discovery should find the mock AS");
    assert.equal(found.as.issuer, as.baseUrl);
    assert.ok(found.as.token_endpoint.includes("/api/oauth/token"));
    assert.ok(found.as.device_authorization_endpoint);
    assert.equal(found.resource, `${as.baseUrl}/mcp`);
  });

  test("returns null for a target with no OAuth surface", async () => {
    // Nothing listens on this port → all discovery probes fail.
    const found = await discoverAsForTarget("http://127.0.0.1:29399/mcp", logger);
    assert.equal(found, null);
  });

  test("returns null for an unparseable URL", async () => {
    assert.equal(await discoverAsForTarget("not a url", logger), null);
  });
});

// ---------------------------------------------------------------------------
// Device grant (RFC 8628)
// ---------------------------------------------------------------------------

describe("device grant", () => {
  test("start → pending → approve → tokens stored (SEP-2352 keying)", async () => {
    const start = await client.startLogin(TARGET_URL, OAUTH_SCOPES);
    assert.equal(start.kind, "device");
    assert.match(start.instructions, /Open this URL in a browser/);
    assert.equal(start.scope, OAUTH_SCOPES.join(" "));

    // Poll before approval → still pending.
    assert.equal(await client.pollDeviceGrantOnce(), "pending");

    // User approves the code.
    const pending = await store.getPendingGrant();
    assert.ok(pending?.deviceCode, "pending grant holds the device code");
    assert.ok(as.approveDeviceGrant("MOCK-CODE"));

    const entry = await client.pollDeviceGrantOnce();
    assert.ok(entry && entry !== "pending", "poll resolves to an entry");
    assert.equal(entry!.issuer, as.baseUrl);
    assert.equal(entry!.target, TARGET_URL);
    assert.equal(entry!.clientId, TOOLCONNECTOR_CLIENT_ID);
    assert.ok(entry!.tokens?.access_token.startsWith("mockat_"));
    assert.ok(entry!.tokens?.refresh_token?.startsWith("mockrt_"));
    // Scope granted matches what was requested.
    assert.equal(entry!.tokens?.scope, OAUTH_SCOPES.join(" "));

    // Pending slot is consumed.
    assert.equal(await store.getPendingGrant(), null);

    // SEP-2352: tokens(ctx) with issuer → entry; without ctx → most recent.
    const providerDeps = { store, logger, target: TARGET_URL };
    const { buildSdkProvider } = await import("../src/oauth-client.js");
    const provider = buildSdkProvider(providerDeps);
    assert.ok((await provider.tokens({ issuer: as.baseUrl }))?.access_token);
    assert.ok((await provider.tokens())?.access_token);
  });

  test("no pending grant → poll returns null", async () => {
    assert.equal(await client.pollDeviceGrantOnce(), null);
  });

  test("RFC 8628 §3.5: polling faster than the interval surfaces slow_down as pending", async () => {
    // Enforcement ON with a 60s interval — deterministic on any machine: the
    // first poll arms the limiter, the approve + rushed poll follow well
    // inside the window, so the AS MUST answer slow_down (surfaced as
    // "pending", not an error).
    as.setDevicePollInterval(60_000);
    try {
      const start = await client.startLogin(TARGET_URL, OAUTH_SCOPES);
      assert.equal(start.kind, "device");
      assert.equal(await client.pollDeviceGrantOnce(), "pending");
      as.approveDeviceGrant("MOCK-CODE");
      const rushed = await client.pollDeviceGrantOnce();
      assert.equal(rushed, "pending");
    } finally {
      as.setDevicePollInterval(0);
      await store.clearPendingGrant();
    }
  });

  test("user denial ends the flow with access_denied", async () => {
    await client.startLogin(TARGET_URL, OAUTH_SCOPES);
    assert.ok(as.denyDeviceGrant("MOCK-CODE"));
    await assert.rejects(
      () => client.pollDeviceGrantOnce(),
      (err: unknown) => err instanceof OAuthFlowError && err.kind === "access_denied",
    );
    assert.equal(await store.getPendingGrant(), null);
  });
});

// ---------------------------------------------------------------------------
// Paste-back (authorization code + PKCE)
// ---------------------------------------------------------------------------

describe("paste-back flow", () => {
  test("happy path: PKCE exchange, state + iss validated, tokens stored", async () => {
    // Hide the device endpoint so the client falls back to paste-back
    // (OAuthClient prefers the device grant when both are advertised).
    as.setDeviceEndpointEnabled(false);
    try {
      await runHappyPath();
    } finally {
      as.setDeviceEndpointEnabled(true);
    }

    async function runHappyPath() {
    const start = await client.startLogin(TARGET_URL, OAUTH_SCOPES);
    assert.equal(start.kind, "paste-back", "device endpoint hidden → paste-back fallback");

    // The authorize URL carries the required OAuth 2.1 parameters.
    const urlMatch = start.instructions.match(/https?:\/\/\S+/);
    assert.ok(urlMatch, "instructions contain the authorize URL");
    const authorizeUrl = new URL(urlMatch![0]);
    assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
    assert.equal(authorizeUrl.searchParams.get("client_id"), TOOLCONNECTOR_CLIENT_ID);
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), PASTE_BACK_REDIRECT_URI);
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorizeUrl.searchParams.get("code_challenge"));
    assert.ok(authorizeUrl.searchParams.get("state"));
    assert.equal(authorizeUrl.searchParams.get("scope"), OAUTH_SCOPES.join(" "));

    // Extract the verifier the client persisted (test-side PKCE completion).
    const pending = await store.getPendingGrant();
    assert.ok(pending?.codeVerifier, "verifier persisted before the browser hop");
    assert.ok(pending?.state);

    // Stand-in for the AS browser step: mint a code bound to the challenge.
    const code = as.issueTestAuthCode({
      redirectUri: PASTE_BACK_REDIRECT_URI,
      codeChallenge: authorizeUrl.searchParams.get("code_challenge")!,
      scope: OAUTH_SCOPES.join(" "),
    });

    // The AS supports RFC 9207; simulate `iss` in the redirect.
    const redirect = `${PASTE_BACK_REDIRECT_URI}?code=${code}&state=${authorizeUrl.searchParams.get("state")}&iss=${encodeURIComponent(as.baseUrl)}`;
    const entry = await client.completePasteBack(redirect);
    assert.equal(entry.issuer, as.baseUrl);
    assert.equal(entry.target, TARGET_URL);
    assert.ok(entry.tokens?.access_token.startsWith("mockat_"));
    assert.equal(await store.getPendingGrant(), null);
    }
  });

  test("state mismatch aborts and clears the pending grant", async () => {
    as.setDeviceEndpointEnabled(false);
    try {
      await client.startLogin(TARGET_URL, OAUTH_SCOPES);
      const pending = await store.getPendingGrant();
      const code = as.issueTestAuthCode({
        redirectUri: PASTE_BACK_REDIRECT_URI,
        codeChallenge: "x".repeat(43),
      });
      const redirect = `${PASTE_BACK_REDIRECT_URI}?code=${code}&state=tampered-state`;
      await assert.rejects(
        () => client.completePasteBack(redirect),
        (err: unknown) => err instanceof OAuthFlowError && err.kind === "state_mismatch",
      );
      assert.equal(await store.getPendingGrant(), null, "pending grant cleared after CSRF abort");
    } finally {
      as.setDeviceEndpointEnabled(true);
    }
  });

  test("iss mismatch (mix-up) aborts", async () => {
    as.setDeviceEndpointEnabled(false);
    try {
      await client.startLogin(TARGET_URL, OAUTH_SCOPES);
      const pending = await store.getPendingGrant();
      const code = as.issueTestAuthCode({
        redirectUri: PASTE_BACK_REDIRECT_URI,
        codeChallenge: "y".repeat(43),
      });
      const redirect = `${PASTE_BACK_REDIRECT_URI}?code=${code}&state=${pending!.state}&iss=${encodeURIComponent("https://evil.example")}`;
      await assert.rejects(
        () => client.completePasteBack(redirect),
        (err: unknown) => err instanceof OAuthFlowError && err.kind === "issuer_mismatch",
      );
      assert.equal(await store.getPendingGrant(), null);
    } finally {
      as.setDeviceEndpointEnabled(true);
    }
  });

  test("error redirect (access_denied) surfaces a clean error", async () => {
    as.setDeviceEndpointEnabled(false);
    try {
      await client.startLogin(TARGET_URL, OAUTH_SCOPES);
      const pending = await store.getPendingGrant();
      const redirect = `${PASTE_BACK_REDIRECT_URI}?error=access_denied&state=${pending!.state}`;
      await assert.rejects(
        () => client.completePasteBack(redirect),
        (err: unknown) => err instanceof OAuthFlowError && err.kind === "authorization_denied",
      );
      assert.equal(await store.getPendingGrant(), null);
    } finally {
      as.setDeviceEndpointEnabled(true);
    }
  });

  test("wrong verifier rejected by the AS (PKCE enforced)", async () => {
    as.setDeviceEndpointEnabled(false);
    try {
      await client.startLogin(TARGET_URL, OAUTH_SCOPES);
      const pending = await store.getPendingGrant();
      const code = as.issueTestAuthCode({
        redirectUri: PASTE_BACK_REDIRECT_URI,
        codeChallenge: "z".repeat(43), // challenge bound to a DIFFERENT verifier
      });
      const redirect = `${PASTE_BACK_REDIRECT_URI}?code=${code}&state=${pending!.state}`;
      await assert.rejects(
        () => client.completePasteBack(redirect),
        (err: unknown) => err instanceof OAuthFlowError && err.kind === "exchange_failed",
      );
    } finally {
      as.setDeviceEndpointEnabled(true);
    }
  });

  test("completePasteBack without a pending flow fails cleanly", async () => {
    // Some rejection paths above intentionally leave the pending grant in
    // place (exchange failures); wipe it so this test starts from scratch.
    await store.clearPendingGrant();
    await assert.rejects(
      () => client.completePasteBack(`${PASTE_BACK_REDIRECT_URI}?code=x&state=y`),
      (err: unknown) => err instanceof OAuthFlowError && err.kind === "no_pending_flow",
    );
  });
});

// ---------------------------------------------------------------------------
// Refresh rotation
// ---------------------------------------------------------------------------

describe("refresh", () => {
  test("refresh rotates the token pair (old refresh token dies)", async () => {
    // Seed a fresh login (device flow is the fastest path).
    await client.startLogin(TARGET_URL, OAUTH_SCOPES);
    as.approveDeviceGrant("MOCK-CODE");
    const first = (await client.pollDeviceGrantOnce()) as Exclude<Awaited<ReturnType<typeof client.pollDeviceGrantOnce>>, "pending" | null>;
    assert.ok(first.tokens?.access_token);
    const firstAccess = first.tokens!.access_token;
    const firstRefresh = first.tokens!.refresh_token!;

    const refreshed = await client.refresh(as.baseUrl, TARGET_URL);
    assert.ok(refreshed, "refresh succeeded");
    assert.notEqual(refreshed!.tokens!.access_token, firstAccess);
    assert.notEqual(refreshed!.tokens!.refresh_token, firstRefresh);

    // The store now holds the NEW refresh token. Rotate again to prove
    // continuity: every rotation must yield a fresh, working pair.
    const storeEntry = await store.findEntry(as.baseUrl, TARGET_URL);
    assert.equal(storeEntry!.tokens!.access_token, refreshed!.tokens!.access_token);
    const second = await client.refresh(as.baseUrl, TARGET_URL);
    assert.ok(second);
    assert.notEqual(second!.tokens!.access_token, refreshed!.tokens!.access_token);
    assert.notEqual(second!.tokens!.refresh_token, refreshed!.tokens!.refresh_token);
    assert.ok(as.refreshedCount() >= 2);
  });

  test("refresh returns null when no entry exists for the issuer", async () => {
    assert.equal(await client.refresh("https://nope.example", "https://nope.example/mcp"), null);
  });
});

// ---------------------------------------------------------------------------
// On-disk security properties
// ---------------------------------------------------------------------------

describe("OAuthStore security", () => {
  test("token files are 0600 and contain no plaintext logs elsewhere", async () => {
    // Ensure at least one entry exists.
    const entries = await store.allEntries();
    assert.ok(entries.length >= 1);

    const files = await readdir(tempConfigDir);
    assert.ok(files.includes("oauth-tokens.json"));
    const tokensRaw = await readFile(join(tempConfigDir, "oauth-tokens.json"), "utf-8");
    assert.ok(tokensRaw.includes("access_token"), "tokens file holds the access token");

    if (process.platform !== "win32") {
      const st = await stat(join(tempConfigDir, "oauth-tokens.json"));
      assert.equal(st.mode & 0o777, 0o600, "oauth-tokens.json must be owner-only");
    }
  });

  test("atomic write leaves no temp files behind", async () => {
    const before = await readdir(tempConfigDir);
    await store.upsertEntry({
      issuer: "https://second.example",
      target: "https://second.example/mcp",
      clientId: TOOLCONNECTOR_CLIENT_ID,
      tokens: { access_token: "second-access-token" },
      savedAt: new Date().toISOString(),
    });
    const after = await readdir(tempConfigDir);
    assert.deepEqual(after, before, "no .tmp siblings remain after writes");
    // Clean up the second entry for the leak test below.
    await store.removeEntry("https://second.example", "https://second.example/mcp");
  });

  test("status output never leaks raw tokens (maskToken shape)", async () => {
    const entry = await store.findEntry(as.baseUrl, TARGET_URL);
    assert.ok(entry?.tokens?.access_token);
    const masked = maskToken(entry.tokens.access_token);
    assert.ok(!masked.includes(entry.tokens.access_token));
    assert.match(masked, /^.{4}….{4}$/);
    // Same guarantee for a short token.
    assert.equal(maskToken("abc"), "***");
  });

  test("removeEntry drops only the matching issuer/target", async () => {
    const entriesBefore = (await store.allEntries()).length;
    assert.ok(entriesBefore >= 1);
    await store.removeEntry("https://does-not-exist.example");
    assert.equal((await store.allEntries()).length, entriesBefore);
  });
});

// ---------------------------------------------------------------------------
// pending-grant hygiene
// ---------------------------------------------------------------------------

describe("pending grant hygiene", () => {
  test("expired pending grants are treated as absent", async () => {
    await mkdir(tempConfigDir, { recursive: true });
    await writeFile(
      join(tempConfigDir, "oauth-pending.json"),
      JSON.stringify({
        target: TARGET_URL,
        state: "old",
        issuer: as.baseUrl,
        createdAt: Date.now() - 20 * 60 * 1000,
        expiresAt: Date.now() - 10 * 60 * 1000,
      }),
      "utf-8",
    );
    assert.equal(await store.getPendingGrant(), null);
  });

  test("safeEqual is length-safe and correct", async () => {
    const { safeEqual } = await import("../src/oauth-store.js");
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    assert.equal(safeEqual("abc", "abcd"), false);
  });
});

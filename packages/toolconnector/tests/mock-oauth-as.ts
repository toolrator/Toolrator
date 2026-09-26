/**
 * Mock OAuth 2.1 Authorization Server
 *
 * Hono HTTP server simulating the authorization-server surface the
 * toolrator.org MCP endpoint exposes (same routes/semantics as
 * next-app-deploy/src/app/api/oauth/* + .well-known/*):
 *
 *   GET  /.well-known/oauth-protected-resource(/mcp)  — PRM (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server      — AS metadata (RFC 8414)
 *   POST /api/oauth/device/authorize                  — RFC 8628 §3.1
 *   POST /api/oauth/token                             — device_code /
 *                                                       authorization_code (PKCE S256) /
 *                                                       refresh_token (rotating)
 *
 * Test hooks (issueTestAuthCode / approveDeviceGrant / …) stand in for the
 * browser side of the flows. Everything is loopback HTTP — the connector's
 * discovery only requires an `issuer` + endpoints, and the production AS's
 * SSRF guard does not apply client-side.
 */

import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { TOOLCONNECTOR_CLIENT_ID } from "../src/oauth-store.js";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

interface AuthCodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  used: boolean;
}

interface DeviceGrant {
  userCode: string;
  scope: string;
  status: "pending" | "approved" | "denied";
  expiresAt: number;
  lastPollAt: number;
  intervalMs: number;
}

interface TokenFamily {
  userId: string;
  scope: string;
  refreshToken: string;
}

const authCodes = new Map<string, AuthCodeEntry>();
const deviceGrants = new Map<string, DeviceGrant>();
const accessTokens = new Map<string, TokenFamily>();
const refreshTokens = new Map<string, string>(); // refresh_token → access_token
let issuedCount = 0;
let refreshedCount = 0;

// Set by startMockOauthAs; c.req.url.origin is not reliably absolute on
// @hono/node-server, so the issuer is injected from the known listen address.
let issuer = "http://127.0.0.1:0";

const DEVICE_TTL_MS = 15 * 60 * 1000;
// Test-tunable knobs (see MockOauthAs setters). Enforcement defaults OFF so
// the rapid back-to-back polls in tests don't trip RFC 8628 §3.5 slow_down;
// a dedicated test flips it on. `deviceEndpointEnabled` hides the device
// endpoint from AS metadata so tests can exercise the paste-back fallback.
let defaultPollIntervalMs = 0;
let deviceEndpointEnabled = true;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function issueTokenPair(scope: string): {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
} {
  const accessToken = `mockat_${randomBytes(24).toString("base64url")}`;
  const refreshToken = `mockrt_${randomBytes(24).toString("base64url")}`;
  accessTokens.set(accessToken, { userId: "mock-user", scope, refreshToken });
  refreshTokens.set(refreshToken, accessToken);
  issuedCount++;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope,
  };
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function tokenError(c: any, error: string, status = 400, extra: Record<string, unknown> = {}) {
  return c.json({ error, ...extra }, status);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function createMockOauthAsApp(): Hono {
  const app = new Hono();

  // PRM — path-inserted (the connector probes /mcp first) and origin root.
  const prm = (issuer: string) =>
    ({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: [
        "profile:read",
        "engines:read",
        "engines:write",
        "servers:read",
        "servers:write",
        "searchconfigs:write",
      ],
      bearer_methods_supported: ["header"],
    });
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(prm(issuer)));
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(prm(issuer)));

  // AS metadata (RFC 8414)
  app.get("/.well-known/oauth-authorization-server", (c) => {
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/api/oauth/authorize`,
      token_endpoint: `${issuer}/api/oauth/token`,
      scopes_supported: ["profile:read", "engines:read", "engines:write", "servers:read", "servers:write", "searchconfigs:write"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
      ...(deviceEndpointEnabled ? { device_authorization_endpoint: `${issuer}/api/oauth/device/authorize` } : {}),
    });
  });

  // RFC 8628 §3.1 device authorization
  app.post("/api/oauth/device/authorize", async (c) => {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, string>);
    const clientId = String((body as any).client_id ?? "");
    if (clientId !== TOOLCONNECTOR_CLIENT_ID) {
      return tokenError(c, "invalid_client");
    }
    const deviceCode = `devc_${randomBytes(16).toString("base64url")}`;
    const userCode = `MOCK-CODE`;
    deviceGrants.set(deviceCode, {
      userCode,
      scope: String((body as any).scope ?? ""),
      status: "pending",
      expiresAt: Date.now() + DEVICE_TTL_MS,
      lastPollAt: 0,
      intervalMs: defaultPollIntervalMs,
    });
    return c.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${issuer}/device`,
      verification_uri_complete: `${issuer}/device?code=${userCode}`,
      expires_in: Math.floor(DEVICE_TTL_MS / 1000),
      interval: Math.floor(defaultPollIntervalMs / 1000),
    });
  });

  // Token endpoint — device_code / authorization_code / refresh_token
  app.post("/api/oauth/token", async (c) => {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, string>);
    const grantType = String((body as any).grant_type ?? "");

    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      const deviceCode = String((body as any).device_code ?? "");
      const clientId = String((body as any).client_id ?? "");
      const grant = deviceGrants.get(deviceCode);
      if (!grant) return tokenError(c, "expired_token");
      if (Date.now() > grant.expiresAt) {
        deviceGrants.delete(deviceCode);
        return tokenError(c, "expired_token");
      }
      // RFC 8628 §3.5 poll-interval enforcement → slow_down.
      const now = Date.now();
      if (now - grant.lastPollAt < grant.intervalMs) {
        grant.lastPollAt = now;
        grant.intervalMs = Math.min(grant.intervalMs * 2, 60_000);
        return tokenError(c, "slow_down", 429, { interval: Math.ceil(grant.intervalMs / 1000) + 5 });
      }
      grant.lastPollAt = now;
      if (grant.status === "pending") return tokenError(c, "authorization_pending");
      if (grant.status === "denied") {
        deviceGrants.delete(deviceCode);
        return tokenError(c, "access_denied");
      }
      if (clientId !== TOOLCONNECTOR_CLIENT_ID) return tokenError(c, "invalid_grant");
      deviceGrants.delete(deviceCode);
      return c.json(issueTokenPair(grant.scope));
    }

    if (grantType === "authorization_code") {
      const code = String((body as any).code ?? "");
      const clientId = String((body as any).client_id ?? "");
      const redirectUri = String((body as any).redirect_uri ?? "");
      const verifier = String((body as any).code_verifier ?? "");
      const entry = authCodes.get(code);
      if (!entry || entry.used) {
        authCodes.delete(code);
        return tokenError(c, "invalid_grant");
      }
      if (entry.clientId !== clientId) return tokenError(c, "invalid_grant");
      if (entry.redirectUri !== redirectUri) return tokenError(c, "invalid_grant");
      if (!verifier || pkceS256(verifier) !== entry.codeChallenge) {
        return tokenError(c, "invalid_grant");
      }
      entry.used = true;
      authCodes.delete(code);
      return c.json(issueTokenPair(entry.scope));
    }

    if (grantType === "refresh_token") {
      const refreshToken = String((body as any).refresh_token ?? "");
      const clientId = String((body as any).client_id ?? "");
      const prevAccess = refreshTokens.get(refreshToken);
      if (!prevAccess || clientId !== TOOLCONNECTOR_CLIENT_ID) {
        return tokenError(c, "invalid_grant");
      }
      // Reuse of an already-rotated refresh token → revoke (401).
      const family = accessTokens.get(prevAccess);
      if (!family) return tokenError(c, "invalid_grant", 401, { error_description: "revoked" });
      accessTokens.delete(prevAccess);
      refreshTokens.delete(refreshToken);
      refreshedCount++;
      return c.json(issueTokenPair(family.scope));
    }

    return tokenError(c, "unsupported_grant_type");
  });

  return app;
}

// ---------------------------------------------------------------------------
// Test-side "browser" actions + server lifecycle
// ---------------------------------------------------------------------------

export interface MockOauthAs {
  baseUrl: string;
  close: () => Promise<void>;
  /** Stand-in for the browser authorization step of the paste-back flow. */
  issueTestAuthCode(opts: { redirectUri: string; codeChallenge: string; scope?: string }): string;
  /** Approve the pending device grant (user entered the code). */
  approveDeviceGrant(userCode: string): boolean;
  /** Simulate the user rejecting the device grant. */
  denyDeviceGrant(userCode: string): boolean;
  /** Mint a token family directly (refresh + header-bypass tests). */
  issueTestTokens(scope?: string): { accessToken: string; refreshToken: string };
  /** Invalidate an access token server-side (revocation simulation). */
  revokeAccessToken(accessToken: string): void;
  /** Toggle the device endpoint in AS metadata (paste-back fallback tests). */
  setDeviceEndpointEnabled(enabled: boolean): void;
  /** Set the RFC 8628 §3.5 poll interval for NEW grants (0 = no enforcement). */
  setDevicePollInterval(ms: number): void;
  issuedTokenCount(): number;
  refreshedCount(): number;
  reset(): void;
}

export async function startMockOauthAs(port: number): Promise<MockOauthAs> {
  issuer = `http://127.0.0.1:${port}`;
  const app = createMockOauthAsApp();
  return new Promise((resolve) => {
    const serverInstance = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
      const baseUrl = `http://127.0.0.1:${port}`;
      const as: MockOauthAs = {
        baseUrl,
        close: () =>
          new Promise<void>((res, rej) => {
            serverInstance.close((err?: Error) => (err ? rej(err) : res()));
          }),
        issueTestAuthCode: (opts) => {
          const code = `mockcode_${randomBytes(16).toString("base64url")}`;
          authCodes.set(code, {
            clientId: TOOLCONNECTOR_CLIENT_ID,
            redirectUri: opts.redirectUri,
            codeChallenge: opts.codeChallenge,
            scope: opts.scope ?? "",
            used: false,
          });
          return code;
        },
        approveDeviceGrant: (userCode) => {
          // Target the LATEST still-pending grant with this user code —
          // earlier tests may leave consumed grants in the map.
          let hit: DeviceGrant | undefined;
          for (const grant of deviceGrants.values()) {
            if (grant.userCode === userCode && grant.status === "pending") hit = grant;
          }
          if (!hit) return false;
          hit.status = "approved";
          return true;
        },
        denyDeviceGrant: (userCode) => {
          let hit: DeviceGrant | undefined;
          for (const grant of deviceGrants.values()) {
            if (grant.userCode === userCode && grant.status === "pending") hit = grant;
          }
          if (!hit) return false;
          hit.status = "denied";
          return true;
        },
        issueTestTokens: (scope = "profile:read engines:read") => {
          const t = issueTokenPair(scope);
          return { accessToken: t.access_token, refreshToken: t.refresh_token };
        },
        revokeAccessToken: (accessToken) => {
          const family = accessTokens.get(accessToken);
          if (family) refreshTokens.delete(family.refreshToken);
          accessTokens.delete(accessToken);
        },
        setDeviceEndpointEnabled: (enabled) => {
          deviceEndpointEnabled = enabled;
        },
        setDevicePollInterval: (ms) => {
          defaultPollIntervalMs = ms;
        },
        issuedTokenCount: () => issuedCount,
        refreshedCount: () => refreshedCount,
        reset: () => {
          authCodes.clear();
          deviceGrants.clear();
          accessTokens.clear();
          refreshTokens.clear();
        },
      };
      resolve(as);
    });
  });
}

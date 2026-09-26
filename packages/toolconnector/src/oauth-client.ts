import { randomBytes, createHash } from "node:crypto";
import type { Logger } from "./config.js";
import {
  OAuthStore,
  TOOLCONNECTOR_CLIENT_ID,
  PASTE_BACK_REDIRECT_URI,
  safeEqual,
  type OAuthEntry,
  type PendingGrant,
  type StoredTokens,
} from "./oauth-store.js";

// ---------------------------------------------------------------------------
// OAuth 2.1 client (toolconnector)
// ---------------------------------------------------------------------------
//
// Two interactive flows against a discovered authorization server:
//
//  1. RFC 8628 device grant — used when the AS advertises
//     `device_authorization_endpoint` (toolrator.org does). The user opens a
//     URL, enters a short code, approves; the connector polls the token
//     endpoint in the background and completes without any paste-back.
//
//  2. Authorization-code + PKCE with paste-back — the portable fallback for
//     ASs without a device grant. The connector prints the authorization URL;
//     the browser lands on a dead loopback page; the user copies the full
//     redirect URL and gives it back to the agent; completePasteBack()
//     validates `state` (constant-time), validates `iss` (RFC 9207), and
//     exchanges the code with the stored PKCE verifier.
//
// PKCE is the security anchor of flow 2: an intercepted code is useless
// without the verifier, which never leaves the config dir. That parity (with
// the loopback-listener UX) is why no listener is bound.

const DISCOVERY_TIMEOUT_MS = 8000;
const DEVICE_POLL_INTERVAL_MS = 5000;
const DEVICE_MAX_WAIT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// AS metadata discovery
// ---------------------------------------------------------------------------

export interface AsMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  scopes_supported?: string[];
  [key: string]: unknown;
}

export interface PrmMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  [key: string]: unknown;
}

/**
 * Discover the AS for an MCP server URL: try the Protected Resource Metadata
 * first (RFC 9728), fall back to the AS metadata on the same origin, then to
 * `/.well-known/oauth-authorization-server` on the origin root. Returns null
 * when the target shows no OAuth surface at all (caller falls back to legacy).
 */
export async function discoverAsForTarget(
  targetUrl: string,
  logger: Logger,
): Promise<{ as: AsMetadata; resource?: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return null;
  }

  // Candidate PRM locations (RFC 9728 §3.1): path-inserted first, then origin.
  const prmUrls = [
    `${parsed.origin}/.well-known/oauth-protected-resource${parsed.pathname}`,
    `${parsed.origin}/.well-known/oauth-protected-resource`,
  ];

  let issuerOrigin: string | null = null;
  let resource: string | undefined;

  for (const prmUrl of prmUrls) {
    try {
      const res = await fetchWithTimeout(prmUrl, { method: "GET" }, DISCOVERY_TIMEOUT_MS);
      if (res.ok) {
        const prm = (await res.json()) as PrmMetadata;
        const candidate = prm.authorization_servers?.[0];
        if (candidate) {
          issuerOrigin = candidate;
          resource = prm.resource;
          break;
        }
      }
    } catch (err) {
      logger.debug(`PRM probe failed at ${prmUrl}: ${String(err)}`);
    }
  }

  // No PRM → try the AS metadata on the target's own origin (self-hosted ASs).
  if (!issuerOrigin) {
    const direct = `${parsed.origin}/.well-known/oauth-authorization-server`;
    try {
      const res = await fetchWithTimeout(direct, { method: "GET" }, DISCOVERY_TIMEOUT_MS);
      if (res.ok) {
        const as = (await res.json()) as AsMetadata;
        if (as.issuer && as.token_endpoint) return { as };
      }
    } catch (err) {
      logger.debug(`AS metadata probe failed at ${direct}: ${String(err)}`);
    }
    return null;
  }

  // PRM gave us an AS: fetch its metadata (RFC 8414 path-inserted, then root).
  let asUrl: URL;
  try {
    asUrl = new URL(issuerOrigin);
  } catch {
    return null;
  }
  const asCandidates = issuerOrigin.endsWith("/")
    ? []
    : [`${issuerOrigin}/.well-known/oauth-authorization-server`];
  asCandidates.push(
    `${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname}`,
    `${asUrl.origin}/.well-known/oauth-authorization-server`,
  );

  for (const candidate of asCandidates) {
    try {
      const res = await fetchWithTimeout(candidate, { method: "GET" }, DISCOVERY_TIMEOUT_MS);
      if (res.ok) {
        const as = (await res.json()) as AsMetadata;
        if (as.issuer && as.token_endpoint) return { as, resource };
      }
    } catch (err) {
      logger.debug(`AS metadata fetch failed at ${candidate}: ${String(err)}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

export interface DeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface StartResult {
  kind: "device" | "paste-back";
  /** Device: what the agent relays to the user. Paste-back: the authorize URL. */
  instructions: string;
  /** Populated when the AS metadata advertises the scopes we requested. */
  scope: string;
  /** Device only: RFC 8628 §3.2 minimum poll interval in seconds. */
  interval?: number;
}

export class OAuthFlowError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url").slice(0, 64);
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

export class OAuthClient {
  private readonly logger: Logger;
  private readonly store: OAuthStore;

  constructor(store: OAuthStore, logger: Logger) {
    this.store = store;
    this.logger = logger;
  }

  /**
   * Begin an interactive login for `target`. Prefers the device grant when
   * the AS advertises one; otherwise prepares the paste-back flow. Both write
   * a pending grant which complete*() consumes.
   */
  async startLogin(target: string, scopes: string[]): Promise<StartResult> {
    const discovered = await discoverAsForTarget(target, this.logger);
    if (!discovered) {
      throw new OAuthFlowError(
        "no_oauth",
        `No OAuth authorization server discovered for ${target} (no PRM, no AS metadata).`,
      );
    }
    const { as, resource } = discovered;
    const scope = scopes.join(" ");

    if (as.device_authorization_endpoint) {
      const res = await fetchWithTimeout(
        as.device_authorization_endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: TOOLCONNECTOR_CLIENT_ID,
            ...(scope ? { scope } : {}),
            ...(resource ? { resource } : {}),
          }).toString(),
        },
        DISCOVERY_TIMEOUT_MS,
      );
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new OAuthFlowError(
          "device_start_failed",
          `Device authorization failed (${res.status}): ${JSON.stringify(body)}`,
        );
      }
      const flow = body as unknown as DeviceFlowStart;
      const pending: PendingGrant = {
        target,
        state: "",
        issuer: as.issuer,
        deviceCode: flow.device_code,
        // Remembered so status output / tests can surface what the user
        // must type at the verification URL.
        userCode: flow.user_code,
        createdAt: Date.now(),
        expiresAt: Date.now() + (flow.expires_in ?? 900) * 1000,
      };
      await this.store.setPendingGrant(pending);
      const lines = [
        `Open this URL in a browser and approve the sign-in:`,
        `  ${flow.verification_uri_complete || flow.verification_uri}`,
        flow.verification_uri_complete ? "" : `  Code: ${flow.user_code}`,
        ``,
        `The connector polls in the background and finishes automatically.`,
      ];
      return {
        kind: "device",
        instructions: lines.filter((l) => l !== undefined).join("\n"),
        scope,
        interval: flow.interval,
      };
    }

    // Paste-back flow (authorization code + PKCE).
    if (!as.authorization_endpoint) {
      throw new OAuthFlowError(
        "no_authorization_endpoint",
        `AS at ${as.issuer} advertises neither device_authorization_endpoint nor authorization_endpoint.`,
      );
    }
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("base64url");
    const authorizeUrl = new URL(as.authorization_endpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", TOOLCONNECTOR_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", PASTE_BACK_REDIRECT_URI);
    if (scope) authorizeUrl.searchParams.set("scope", scope);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    if (resource) authorizeUrl.searchParams.set("resource", resource);

    const pending: PendingGrant = {
      target,
      state,
      issuer: as.issuer,
      codeVerifier: verifier,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    await this.store.setPendingGrant(pending);

    const instructions = [
      `Open this URL in a browser and approve the sign-in:`,
      `  ${authorizeUrl.toString()}`,
      ``,
      `After approving, the browser lands on a page that will not load`,
      `(a local address). Copy the FULL URL from the address bar and give`,
      `it back to complete the sign-in (manage_auth action "complete_oauth").`,
    ].join("\n");
    return { kind: "paste-back", instructions, scope };
  }

  /**
   * Complete a paste-back flow: validate state (constant-time), validate iss
   * (RFC 9207), exchange the code with the stored PKCE verifier, persist.
   */
  async completePasteBack(redirectUrl: string): Promise<OAuthEntry> {
    const pending = await this.store.getPendingGrant();
    if (!pending || !pending.codeVerifier) {
      throw new OAuthFlowError(
        "no_pending_flow",
        `No authorization flow is waiting to be completed. Run manage_auth action "start_oauth" first.`,
      );
    }

    let url: URL;
    try {
      url = new URL(redirectUrl);
    } catch {
      throw new OAuthFlowError("bad_redirect", `The pasted value is not a valid URL.`);
    }
    const error = url.searchParams.get("error");
    if (error) {
      const desc = url.searchParams.get("error_description") || "";
      await this.store.clearPendingGrant();
      throw new OAuthFlowError("authorization_denied", `Authorization failed: ${error} ${desc}`.trim());
    }
    const code = url.searchParams.get("code");
    if (!code) {
      throw new OAuthFlowError("bad_redirect", `The pasted URL carries no authorization code.`);
    }
    // CSRF guard: state must match what we generated, constant-time.
    const returnedState = url.searchParams.get("state") ?? "";
    if (!pending.state || !safeEqual(returnedState, pending.state)) {
      await this.store.clearPendingGrant();
      throw new OAuthFlowError("state_mismatch", `state mismatch — aborting (possible CSRF). Start over.`);
    }
    // RFC 9207: when the AS supplies iss it must match the discovered issuer.
    const iss = url.searchParams.get("iss");
    if (iss && !safeEqual(iss, pending.issuer)) {
      await this.store.clearPendingGrant();
      throw new OAuthFlowError("issuer_mismatch", `iss mismatch — aborting (possible mix-up attack). Start over.`);
    }

    const discovered = await discoverAsForTarget(pending.target, this.logger);
    const tokenEndpoint = discovered?.as.token_endpoint;
    if (!tokenEndpoint) {
      throw new OAuthFlowError("discovery_lost", `Authorization server metadata is no longer reachable.`);
    }

    const tokens = await exchangeCode(tokenEndpoint, code, {
      clientId: TOOLCONNECTOR_CLIENT_ID,
      redirectUri: PASTE_BACK_REDIRECT_URI,
      codeVerifier: pending.codeVerifier,
    });
    const entry = await this.store.consumePendingGrant(tokens, pending.issuer);
    if (!entry) {
      throw new OAuthFlowError("no_pending_flow", `Pending flow vanished while completing.`);
    }
    return entry;
  }

  /**
   * Poll a pending device grant once. Returns the entry on success, null
   * while still pending, and throws on expiry/slow-down exhaustion.
   */
  async pollDeviceGrantOnce(): Promise<OAuthEntry | "pending" | null> {
    const pending = await this.store.getPendingGrant();
    if (!pending?.deviceCode) return null;
    const discovered = await discoverAsForTarget(pending.target, this.logger);
    const tokenEndpoint = discovered?.as.token_endpoint;
    if (!tokenEndpoint) throw new OAuthFlowError("discovery_lost", `Authorization server unreachable.`);

    const res = await fetchWithTimeout(
      tokenEndpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: pending.deviceCode,
          client_id: TOOLCONNECTOR_CLIENT_ID,
        }).toString(),
      },
      DISCOVERY_TIMEOUT_MS,
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (res.ok) {
      const tokens = body as unknown as StoredTokens;
      const entry = await this.store.consumePendingGrant(tokens, pending.issuer);
      return entry;
    }
    const errCode = String(body.error ?? "");
    if (errCode === "authorization_pending") return "pending";
    if (errCode === "slow_down") return "pending";
    if (errCode === "expired_token" || errCode === "access_denied") {
      await this.store.clearPendingGrant();
      throw new OAuthFlowError(errCode, `Device flow ended: ${errCode}`);
    }
    throw new OAuthFlowError("token_error", `Token endpoint error: ${errCode || res.status}`);
  }

  /**
   * Refresh the stored tokens for an issuer. Returns the refreshed entry or
   * null when there is no refresh token / the AS rejected it (caller should
   * then drop the entry and require a fresh login).
   */
  async refresh(issuer: string, target: string): Promise<OAuthEntry | null> {
    const entry = await this.store.findEntry(issuer, target);
    if (!entry?.tokens?.refresh_token) return null;
    const discovered = await discoverAsForTarget(target, this.logger);
    const tokenEndpoint = discovered?.as.token_endpoint;
    if (!tokenEndpoint) return null;

    try {
      const res = await fetchWithTimeout(
        tokenEndpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: entry.tokens.refresh_token,
            client_id: TOOLCONNECTOR_CLIENT_ID,
          }).toString(),
        },
        DISCOVERY_TIMEOUT_MS,
      );
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      if (!body.access_token) return null;
      const tokens: StoredTokens = {
        ...entry.tokens,
        ...(body as unknown as StoredTokens),
      };
      const refreshed: OAuthEntry = {
        ...entry,
        tokens,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
        savedAt: new Date().toISOString(),
      };
      await this.store.upsertEntry(refreshed);
      return refreshed;
    } catch (err) {
      this.logger.debug(`OAuth refresh failed for ${issuer}: ${String(err)}`);
      return null;
    }
  }

  /** Drop stored credentials for an issuer (RFC 7009 revocation is best-effort and not required). */
  async revoke(issuer: string, target?: string): Promise<boolean> {
    return this.store.removeEntry(issuer, target);
  }
}

// ---------------------------------------------------------------------------
// HTTP + exchange helpers
// ---------------------------------------------------------------------------

async function exchangeCode(
  tokenEndpoint: string,
  code: string,
  opts: { clientId: string; redirectUri: string; codeVerifier: string },
): Promise<StoredTokens> {
  const res = await fetchWithTimeout(
    tokenEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        code_verifier: opts.codeVerifier,
      }).toString(),
    },
    DISCOVERY_TIMEOUT_MS,
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !body.access_token) {
    throw new OAuthFlowError(
      "exchange_failed",
      `Token exchange failed (${res.status}): ${JSON.stringify(body)}`,
    );
  }
  return body as unknown as StoredTokens;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// SDK adapter (OAuthClientProvider shape) — used by mcp-connection.ts
// ---------------------------------------------------------------------------

export interface ProviderDeps {
  store: OAuthStore;
  logger: Logger;
  target: string;
}

/**
 * Build an object satisfying the MCP SDK's OAuthClientProvider interface for
 * one target. Persisted through the store; tokens(ctx) follows SEP-2352:
 * with ctx → matching issuer, without ctx → most-recent entry for the target.
 */
export function buildSdkProvider(deps: ProviderDeps): {
  redirectUrl: string;
  clientMetadata: Record<string, unknown>;
  clientInformation: () => Promise<{ client_id: string } | undefined>;
  saveClientInformation: (info: { client_id: string }) => Promise<void>;
  tokens: (ctx?: { issuer: string }) => Promise<StoredTokens | undefined>;
  saveTokens: (tokens: StoredTokens, ctx?: { issuer: string }) => Promise<void>;
  redirectToAuthorization: (authorizationUrl: URL) => void;
  saveCodeVerifier: (verifier: string) => Promise<void>;
  codeVerifier: () => Promise<string>;
  invalidateCredentials: (scope: "all" | "client" | "tokens" | "verifier" | "discovery") => Promise<void>;
  state: () => string;
} {
  const { store, logger, target } = deps;
  return {
    redirectUrl: PASTE_BACK_REDIRECT_URI,
    clientMetadata: {
      client_name: "toolconnector (Toolrator CLI)",
      client_uri: "https://toolrator.org",
      redirect_uris: [PASTE_BACK_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    clientInformation: async () => {
      const entry = await store.findEntry(undefined, target);
      return entry?.clientInformation as { client_id: string } | undefined;
    },
    saveClientInformation: async (info) => {
      const entry = (await store.findEntry(undefined, target)) ?? {
        issuer: "",
        target,
        clientId: info.client_id,
        savedAt: new Date().toISOString(),
      };
      entry.clientInformation = info;
      await store.upsertEntry(entry);
    },
    tokens: async (ctx?: { issuer: string }) => {
      const entry = await store.findEntry(ctx?.issuer, target);
      return entry?.tokens;
    },
    saveTokens: async (tokens, ctx?: { issuer: string }) => {
      const entry = (await store.findEntry(ctx?.issuer, target)) ?? {
        issuer: ctx?.issuer ?? "",
        target,
        clientId: TOOLCONNECTOR_CLIENT_ID,
        savedAt: new Date().toISOString(),
      };
      entry.tokens = tokens;
      entry.expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
      entry.savedAt = new Date().toISOString();
      await store.upsertEntry(entry);
    },
    // The connector never opens a browser from inside a tool call. Interactive
    // authorization happens through manage_auth; onUnauthorized-driven
    // redirects therefore abort (the transport surfaces UnauthorizedError and
    // the tool layer reports it).
    redirectToAuthorization: (authorizationUrl: URL) => {
      logger.debug(`OAuth redirect requested (suppressed, stdio): ${authorizationUrl.origin}${authorizationUrl.pathname}`);
      throw new OAuthFlowError(
        "interactive_required",
        `Server requires interactive authorization. Run manage_auth with action "start_oauth" for ${target}.`,
      );
    },
    saveCodeVerifier: async (verifier) => {
      const pending = await store.getPendingGrant();
      await store.setPendingGrant({
        target,
        state: pending?.state ?? "",
        issuer: pending?.issuer ?? "",
        codeVerifier: verifier,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
    },
    codeVerifier: async () => {
      const pending = await store.getPendingGrant();
      if (!pending?.codeVerifier) throw new OAuthFlowError("no_verifier", `No PKCE verifier stored.`);
      return pending.codeVerifier;
    },
    invalidateCredentials: async (scope) => {
      if (scope === "all" || scope === "tokens") {
        const entry = await store.findEntry(undefined, target);
        if (entry) await store.removeEntry(entry.issuer, target);
      }
    },
    state: () => randomBytes(16).toString("base64url"),
  };
}

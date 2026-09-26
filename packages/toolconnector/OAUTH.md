# OAuth 2.1 in Toolrator

This document explains OAuth 2.1 as implemented across Toolrator: the grants
toolconnector (the CLI/stdio MCP bridge) supports, why a remote or CLI client
needs different flows than a web app, and exactly what happens when you log in
to toolrator.org/mcp and change your search-engine configuration.

Toolconnector's implementation status per feature lives in
[`MCP-FEATURES.md`](./MCP-FEATURES.md) §8; the file you are reading is the
conceptual explainer.

---

## The actors

| Actor | In Toolrator |
|---|---|
| **Resource owner** | The human user (your account at toolrator.org). |
| **Client** | `toolconnector` — a native/CLI-style public client (no client secret). |
| **Authorization server (AS)** | toolrator.org (the MCP endpoint's OAuth provider). Any upstream MCP server can expose its own. |
| **Resource server (RS)** | The MCP endpoint (`https://toolrator.org/mcp`), the `verify-key` / `config/auto` connector APIs, and any external MCP server the connector calls. |

---

## The grant types

### 1. Authorization code + PKCE — the web standard

The classic redirect flow, hardened per OAuth 2.1:

1. The client sends the user's browser to the AS `authorization_endpoint` with a
   random `state`, a PKCE `code_challenge` = SHA-256(`code_verifier`) (S256),
   and a `redirect_uri`.
2. The user logs in and approves.
3. The AS redirects to `redirect_uri` with a one-time `code` (and `iss`, RFC 9207).
4. The client exchanges `code` + `code_verifier` at the `token_endpoint`.

PKCE is the security anchor: an intercepted code is worthless without the
verifier, which never leaves the client. `state` (CSRF) and `iss`
(mix-up) are validated constant-time. OAuth 2.1 **mandates** PKCE for all
public clients and forbids the implicit and password grants entirely.

**Web apps** (confidential clients, backend + secret, HTTPS redirect URL) use
this flow with a real redirect back into the app.

### 2. Authorization code + PKCE with *paste-back* — the CLI variant

A CLI/stdio client has no web server to receive a redirect. toolconnector
therefore binds **no port at all**:

1. `manage_auth action: "start_oauth"` prints the authorization URL.
2. After approval, the browser lands on `http://127.0.0.1:49152/callback` —
   a dead address on purpose. The page will not load.
3. The user copies the full URL from the address bar and gives it to the agent,
   which calls `manage_auth action: "complete_oauth"`.
4. The connector validates `state` + `iss`, exchanges the code with the
   verifier it persisted (0600) *before* the browser hop, and stores the tokens.

This is RFC 8252 §7.3 parity for loopback redirects without running a local
HTTP listener: same redirect target class, but nothing listening — an
intercepted redirect can only complete via the verifier, and the verifier only
lives in the user's config dir.

### 3. Device authorization grant (RFC 8628) — when advertised

The smoothest flow for a remote/CLI client, and toolconnector's **preferred**
one whenever the AS advertises `device_authorization_endpoint` (toolrator.org
does):

1. `manage_auth action: "start_oauth"` POSTs to the device endpoint.
2. The user opens `verification_uri` (toolrator.org/device), approves.
3. The connector polls the token endpoint in the background — fast while the
   user is active, then slower; it honors the AS's `interval` and backs off on
   `slow_down` per RFC 8628 §3.5 — and completes without any paste-back.

No redirect, no browser on the same machine as the client: this is what makes
"the connector runs on a server, the user is on their laptop" work.

### 4. Refresh token — staying logged in

Access tokens are short-lived (1 h at toolrator.org); refresh tokens are
long-lived and **rotate on every use**: each refresh returns a new pair and
invalidates the old refresh token. Reusing an already-rotated refresh token is
treated as theft — the AS revokes the whole family (RFC 6819 §5.2.2.3). The
connector stores the current pair and refreshes on 401 via the MCP transport;
if the AS rejects the refresh, the stored entry is dropped and a fresh
`start_oauth` is required.

### 5. Client credentials — machine-to-machine (not used by the connector)

The `client_credentials` grant authenticates *a machine*, not a user: the
client presents its own secret and gets a token with no user behind it. It is
the right tool for service-to-service backends. Toolconnector deliberately
does not use it: everything the connector does is on behalf of a human account,
and it is a public client with no secret to present. A future headless
integration (CI fetching public data with a service identity) would use this
grant; there is nothing for it to log in *as* today.

### 6. What OAuth 2.1 removed

- **Implicit** (`response_type=token`) — tokens in URL fragments; replaced by
  authorization code + PKCE.
- **Resource-owner password** — too much trust, no MFA surface; removed.
- **Plain PKCE** (`code_challenge_method=plain`) — only S256 remains.

toolrator.org's AS metadata advertises exactly the 2.1 surface:
`code_challenge_methods_supported: ["S256"]`,
`token_endpoint_auth_methods_supported: ["none"]` (public client),
grants `authorization_code`, `refresh_token`, and the device grant.

---

## Client identity: CIMD (no DCR, no secrets)

toolconnector identifies itself with a **Client ID Metadata Document**
(CIMD): its `client_id` *is* a URL —

```
https://toolrator.org/.well-known/oauth-client/toolconnector.json
```

— and the AS fetches that document to learn the client's name, redirect URIs
and grant types. Consequences:

- **No Dynamic Client Registration** and no client secret exists anywhere.
- The AS fetches the document over real HTTPS; loopback/private client
  documents are never fetched (SSRF guard) — self-hosted ASs register their
  known clients directly in their cache.
- Public clients authenticate nothing at the token endpoint
  (`token_endpoint_auth_method: "none"`); PKCE + `redirect_uri` exact-match
  carry the proof.

---

## What a remote/CLI client can do (and what it can't)

**Can:**
- Log in as the user via device grant or paste-back — no browser on the client
  machine required for the device flow.
- Receive **delegated, scoped access**: the toolrator.org consent screen shows
  exactly which scopes (`profile:read`, `engines:read`, `engines:write`,
  `servers:read`, `servers:write`, `searchconfigs:write`) are granted, and the
  user approves or denies.
- Keep the session alive via rotating refresh tokens; revoke everything with
  `manage_auth action: "oauth_logout"` (local removal) or by revoking at the AS.
- Have tokens attached automatically to MCP calls — the transport refreshes on
  401 without agent involvement.

**Can't (by design):**
- See or export your password — OAuth never transmits it to the client.
- Act beyond the consented scopes; the AS enforces scope on every endpoint.
- Silently outlive an approved session — refresh reuse detection revokes the
  family server-side if tokens leak and are replayed.
- Open a browser by itself mid-tool-call — interactive redirects are
  suppressed; interactive login only happens through `manage_auth`.

---

## End-to-end: "change my search engines"

The steering scenario, step by step:

1. **Agent → connector**: `manage_auth` `action: "start_oauth"` (target
   `https://toolrator.org/mcp`). Device grant starts; the user approves at
   toolrator.org/device. Tokens land in `<configDir>/oauth-tokens.json` (0600).
2. **Auto-apply**: the connector immediately presents the new access token as
   the bearer to `POST /api/auth/verify-key` and `GET
   /api/connector/config/auto` — both accept OAuth tokens — and applies the
   returned engine list. No restart, no manual config.
3. **User (or agent via `mcp_server` → `manage_search_engines`)** changes
   engines at `https://toolrator.org/mcp`. The change is written server-side.
4. **Pickup**: the next `manage_auth action: "status"` (which re-verifies and
   re-pulls), the next login, or the periodic config resolution applies the new
   configuration and fires `notifications/tools/list_changed`.

The point of the design: the user changes configuration in a normal web UI
(toolrator.org/mcp); the agent just needs one login and everything downstream
follows automatically.

---

## Security properties checklist

- PKCE S256 on every authorization-code flow; verifier stored 0600 before the
  browser hop, never leaves the config dir.
- Constant-time `state` comparison; RFC 9207 `iss` validation.
- Refresh rotation + family revocation on reuse (server-side, RFC 6819).
- Opaque tokens; only masked values (`abcd…wxyz`) are ever shown in tool
  output. Token files are 0600 and written atomically.
- SSRF-guarded CIMD fetching on the AS side; no DCR, no client secrets.
- Explicit per-call `headers` still override stored tokens (escape hatch, not
  the default).

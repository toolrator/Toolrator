# Changelog

All notable changes to the Toolrator OSS ecosystem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Package versions are independent; each version heading identifies its package and links to its GitHub release or tag.

## [Unreleased]

### Changed

- **Toolhub:** indexing swaps retain the active index on failure; embedding requests use bounded chunks, pooling, and retry handling.
- Refreshed Toolhub's Hono lockfile to the patched release.
- Baseline-update workflows check out `main` and rebase before pushing their generated changes.

## [`@toolrator/toolpanel` 0.3.0](https://github.com/toolrator/Toolrator/releases/tag/toolpanel-v0.3.0) - 2026-09-30

### Changed

- Updated the Hono dependency to its patched release.

### Removed

- Legacy API-key device endpoints and the `/device` page. Toolpanel continues to serve local machine credentials and search-engine configuration; it does not provide interactive OAuth login.

## [`@toolrator/toolconnector` 0.4.0](https://github.com/toolrator/Toolrator/releases/tag/toolconnector-v0.4.0) - 2026-09-30

### Changed

- **Breaking — OAuth 2.1 is now the only interactive login.** The legacy
  Toolrator-specific API-key device flow (`manage_auth` actions
  `start_device_flow` / `poll_device_flow`, and the `/api/auth/device/start|poll`
  upstream endpoints) has been removed. Log in with `start_oauth` (device grant
  RFC 8628 with browser approval, or authorization-code + PKCE paste-back).
  `manage_auth` now offers exactly 6 actions: `status`, `start_oauth`,
  `complete_oauth`, `oauth_status`, `oauth_logout`, `logout`.
- **Breaking — unified credential state.** `authState` is now
  `anonymous | authenticated` and is `authenticated` when EITHER an API key OR
  stored OAuth tokens are present (previously it tracked only the API key, so
  OAuth-only sessions reported `authenticated: false` while holding a working
  login). Status output replaces `oauth_connected` with `credential`
  (`api_key` | `oauth_token`). Boot-time search-config pull now also works for
  OAuth-only sessions.
- `manage_auth action: "logout"` now clears BOTH credential domains (API key
  and OAuth tokens) plus any in-flight OAuth login.
- The API key remains a supported **machine credential** (`CONNECTOR_API_KEY`
  env var or a previously saved `credentials.json`); upstreams keep accepting
  both credential domains on `verify-key` / `config/auto`. `credentials.json` is
  now **read-only** to the connector: the removed device flow was its only
  writer, so an API key reaches the connector via the env var or a file the
  operator places in the config dir. `logout` still deletes it.

- OAuth starts against the resolved upstream. Device-grant polling honors the server interval and `slow_down`, and stops on terminal errors.
- Refreshed Hono and the development tooling lockfile to patched releases.

### Removed

- Consolidated MCP connections into `mcp-client.ts` and search-engine resolution into `search-engines.ts`; removed obsolete authentication and cache helpers.

- **Breaking — `manage_favorites` is gone.** `@toolrator/toolconnector` now exposes
  **3 tools** instead of 4: `search_mcp_ecosystem`, `mcp_server`, and `manage_auth`.
  Local server bookmarks were never more than a convenience layer over
  `search_mcp_ecosystem`, and the notes feature added cost to every error path for
  near-zero agent value. Agents pinned to the old four-tool interface should
  re-fetch `tools/list`; the connector already ships `notifications/tools/list_changed`
  plus in-band stale-schema compensation for harnesses that ignore it.
- **Breaking — the `memory_note` field is gone from the structured error payload.**
  `mcp_server` errors no longer carry `memory_note`; it only ever existed to surface
  a `manage_favorites` bookmark's free-text notes on failure. `error_code`, `reason`,
  and `required_step` are unchanged.
- `favorites.json` is no longer read or written. A boot-time one-shot migration
  (`removeLegacyFavoritesFile`) deletes a leftover copy from older installs, so the
  file does not linger in the config dir. The file is removed, not archived.

## [`@toolrator/toolconnector` 0.3.0](https://github.com/toolrator/Toolrator/releases/tag/toolconnector-v0.3.0) - 2026-09-23

### Changed

- Boot-time remote resolution is bounded to 4 seconds.

## [`@toolrator/toolpanel` 0.2.0](https://github.com/toolrator/Toolrator/releases/tag/toolpanel-v0.2.0) - 2026-09-23

### Changed

- Refreshed the runtime dependency to `@hono/node-server` 2.x.

## [`@toolrator/toolconnector` 0.2.0](https://github.com/toolrator/Toolrator/releases/tag/toolconnector-v0.2.0) - 2026-09-18

### Added

- Added in-band stale-tool-list compensation. When a client ignores
  `notifications/tools/list_changed`, stale calls return the current input
  schema with the submitted arguments; successful calls include a one-time
  notice with the updated schema. Schemas come from a per-tool Zod registry and
  are validated live.

### Release

- Published via GitHub OIDC Trusted Publishing with SLSA provenance.

## [`@toolrator/toolpanel` 0.1.1](https://github.com/toolrator/Toolrator/releases/tag/toolpanel-v0.1.1) - 2026-09-18

### Changed

- Added the Project Status banner to the README; no functional changes from 0.1.0.

### Release

- Published via GitHub OIDC Trusted Publishing with SLSA provenance.

## [`@toolrator/toolconnector` 0.1.1](https://github.com/toolrator/Toolrator/releases/tag/toolconnector-v0.1.1) - 2026-09-18

### Changed

- Device-flow polling no longer returns `credits_remaining`.
- No breaking changes; the four-tool interface remained unchanged.

### Release

- Pre-release hardening and pipeline-validation release, published via GitHub
  OIDC Trusted Publishing with SLSA provenance.

## [0.1.0] - 2026-09-11

### Added

- `@toolrator/toolconnector` — first release of the local stdio MCP bridge
  ([GitHub release](https://github.com/toolrator/Toolrator/releases/tag/toolconnector-v0.1.0)).
  Supports MCP 2026-07-28 (stateless protocol, MRTR, Tasks extension), exposes
  `search_mcp_ecosystem`, `mcp_server`, `manage_auth`, and `manage_favorites`,
  and includes fallback support for legacy 2025-11-25 servers.
- `@toolrator/toolpanel` — first release of the Hono-based web UI
  ([GitHub release](https://github.com/toolrator/Toolrator/releases/tag/toolpanel-v0.1.0)),
  with search forms over the toolhub index, admin CRUD, and connector
  configuration management.
- `toolhub` — included in the initial open-source ecosystem release as the
  typo-tolerant and hybrid-vector search service (MeiliSearch or in-memory
  backend); it has no separate package release tag.

### Fixed

- Toolhub: `eval:perf --compare` failures now print the full stack trace instead of only the error message.

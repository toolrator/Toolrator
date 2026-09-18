# Changelog

All notable changes to the Toolrator OSS ecosystem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-18

### Added

- `toolconnector`: in-band stale-tool-list compensation. Many MCP clients ignore
  `notifications/tools/list_changed` and keep serving the session-start tool list,
  so mid-session schema changes (e.g. after login) fail with confusing validation
  errors. The connector now detects the stale state and appends the likely cause
  plus the tool's current JSON schema to failed calls, and a one-time notice to
  successful calls of affected tools. Fresh clients see no difference.

## [0.1.0] - 2026-09-11

### Added

- Initial open source release of the Toolrator OSS ecosystem:
  - `@toolrator/toolconnector` — local stdio MCP bridge connecting AI agents to search backends and external MCP servers.
  - `@toolrator/toolpanel` — self-hosted control panel (auth device flow, search-engine config, admin UI).
  - `@toolrator/toolhub` — typo-tolerant + hybrid vector search engine (MeiliSearch or in-memory backend).

### Fixed

- Toolhub: `eval:perf --compare` failures now print the full stack trace instead of only the error message.
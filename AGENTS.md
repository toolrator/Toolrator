# AGENTS.md

Context and rules for AI coding agents working in this repository. Complements
[README.md](README.md) (what the project is) and [CONTRIBUTING.md](CONTRIBUTING.md)
(the human workflow). The closest `AGENTS.md` to your file wins, so a package-local
one can refine these rules.

## Repo Layout

A small npm workspace of **three packages** — no other directories:

| Path | npm name | Published? | What it is |
|---|---|---|---|
| `packages/toolconnector` | `@toolrator/toolconnector` | ✅ npm | Local stdio MCP bridge: 4 unified tools (`search_mcp_ecosystem`, `mcp_server`, `manage_auth`, `manage_favorites`) |
| `packages/toolpanel` | `@toolrator/toolpanel` | ✅ npm | Self-hosted Hono control panel: device-flow auth, search-engine config, admin UI |
| `packages/toolhub` | `@toolrator/toolhub` | ❌ never (`private: true`) | MCP-server search engine: MeiliSearch or in-memory backend, optional embeddings |

Root `package.json` defines `test`/`build`/`typecheck` across workspaces. It exists
for ergonomics; CI does **not** use it — per-package commands are canonical.

## Setup Commands

- Install **per package** (never `npm install` at the repo root — there is no
  root lockfile):
  ```bash
  cd packages/toolconnector && npm ci   # or npm install
  cd packages/toolpanel && npm ci
  cd packages/toolhub && npm ci
  ```
- Node ≥ 20 (toolconnector, toolhub runtime; **toolpanel needs ≥ 22.9** — see
  `engines`); CI runs Node 22; publish runs Node 24. TypeScript is
  `"type": "module"` in every package.
- No .env loader in toolconnector — it reads plain env vars from the process
  that launches it (e.g. the `env` block of your MCP client config). `.env.example`
  files document every knob; the toolhub/toolpanel `dev` scripts do honor a local
  `.env` via `--env-file-if-exists`.

## Development Workflow

- Build: `npm run build` (tsc) · Typecheck: `npm run typecheck` (tsc --noEmit) ·
  Dev-run: `npm run dev` (tsx) — per package.
- toolhub (backend): `SEARCH_BACKEND=memory npm run dev` → `http://127.0.0.1:7600`;
  needs no external services in memory mode. For Meili mode, docker: `docker run -d -p 7700:7700 getmeili/meilisearch:v1.11`
- toolpanel: `npm run dev` → `http://127.0.0.1:7800`.
- toolconnector: a stdio server — don't run it interactively; drive it from an
  MCP client or the tests. It uses port 29310 for the e2e auth-sim and 29410 for
  the compliance fixtures. It logs to **stderr** (`[toolconnector:<level>]`),
  never stdout — stdout is reserved for JSON-RPC.
- Commit titles: Conventional Commits, e.g. `feat(toolconnector): …`,
  `chore(toolhub): …`, `docs: …`. Scope = package name.
- DCO: contributions are licensed under Apache-2.0; the repo carries a `DCO`
  (Developer Certificate of Origin).

## Testing Instructions

- Runner is **Node's built-in** `node --test` (via tsx). **No Jest, no Vitest** —
  don't add them.
- Run per package: `cd packages/<name> && npm test`. For one file:
  `node --import tsx --test tests/<file>.test.ts`. Focused case (suite/test names):
  `node --import tsx --test --test-name-pattern "<pattern>" tests/<file>.test.ts`.
- Also run before handing over: `npm run typecheck` (+ `npm run build`).
- **Definition of done: full package suite green — e.g. toolconnector reports
  `# fail 0`.** Any failing test means STOP: never push or defer; fix first.
- Tests are **hermetic**: they spin up in-process mock servers/ports
  (e.g. 29310/29321/29410 in toolconnector, high 3xxxx ports in toolhub/toolpanel)
  and never call external services or read real credentials. Keep new tests in
  the same style; fixture files live in `tests/fixtures/`. Test files must be
  named `*.test.ts` under `tests/` (toolhub also has `*.test.mjs`).
- toolhub has **eval suites** beyond `npm test`:
  - `npm run eval:search[:real][:update]` — search-quality eval; on `main` a
    scheduled CI job (`search-quality.yml` → `update-baseline`) rewrites
    `tests/fixtures/search-eval-baseline.json` via
    `chore(toolhub): update search eval baseline` commits. If the baseline goes
    red locally, run `npm run eval:search:update` and commit the refresh.
  - `npm run eval:perf[:constrained|:quick][:update]` — perf eval; the report
    JSONs are gitignored, CI caches the ONNX model between runs.
- One-wire compat check for MCP features: `npm run test:compliance` (toolconnector).

## Code Style

- TypeScript strict, ESM (`"type": "module"`), package manager npm — not yarn/pnpm.
- No ESLint/Prettier config — match surrounding style; `npx tsc --noEmit` is the style gate.
- **Error classification contract** — `classifyUpstreamError()` in
  `packages/toolconnector/src/errors.ts` is test-locked by
  `tests/errors.test.ts`. Its mapping — 401/`-32001`→`auth_required`,
  404→`server_not_found` / `tool_not_found`, `-32601`→`tool_not_found`,
  `-32602`→`resource_not_found`, `-32022`→`unsupported_protocol_version`,
  `-32020`→`header_mismatch`, else `execution_failed` — is a public contract:
  renumbering or re-wording a branch must be a deliberate, documented change.
- Keep doc claims = code truth: no overclaims ("first-mover", "100% community-driven");
  toolconnector has no .env loader; `base_url` in search documents is allowed.
- Public exports need a doc-comment when behavior is subtle; internal helpers don't.
- New modules live inside the relevant `packages/<name>/` tree — never at a repo root.

## MCP Protocol Rules (2026-07-28)

All MCP code targets the **stateless MCP `2026-07-28`** revision:
- No `initialize`/`notifications/initialized` handshake and no `Mcp-Session-Id`:
  every request is self-contained, carrying `protocolVersion` +
  `clientCapabilities` in `_meta`; `server/discover` provides capability
  discovery.
- Server→client requests (sampling/elicitation/roots) are replaced by **Multi
  Round-Trip Requests** (`resultType: "input_required"` + `inputResponses`/`requestState`).
- Tasks = `io.modelcontextprotocol/tasks` extension (`tasks/get`/`update`/`cancel`; no `tasks/list`).
- Removed in `2026-07-28`: `ping`, `logging/setLevel`, `notifications/roots/list_changed`
  (log level is per-request `_meta["io.modelcontextprotocol/logLevel"]`).
- Error codes: `HeaderMismatch` `-32020`, `MissingRequiredClientCapability` `-32021`,
  `UnsupportedProtocolVersion` `-32022`.
- Roots/Sampling/Logging/HTTP+SSE are deprecated (removal earliest 2027-07-28);
  legacy `2025-11-25` servers keep working via fallback negotiation.
- Never build new features on `2024-11-05`/`2025-06-18`/`2025-11-25` conventions.
  When in doubt, read the canonical spec: https://modelcontextprotocol.io/specification/2026-07-28 —
  don't trust training data for wire details.
- README protocol badges point at the official `2026-07-28` spec, never `/draft`.
- Reference: `packages/toolconnector/MCP-FEATURES.md` (full compliance matrix, test references).

## Build and Deployment

- `npm run build` (tsc) outputs to each package's `dist/` (gitignored).
- **Releases are maintainer-only, per-package git tags** — merging to `main`
  never publishes. Tag `toolconnector-vX.Y.Z` publishes only
  `@toolrator/toolconnector` (same pattern for toolpanel). The tag suffix must
  exactly match the package's `package.json` version — CI verifies and fails
  otherwise. Full procedure incl. the OIDC Trusted-Publishing `E404` gotcha:
  [RELEASING.md](RELEASING.md). toolhub is never published (private).
- Contributors never publish; nothing to do release-wise beyond landing in `main`.

## Pull Request Guidelines

- Branch from `main`; run `npm test` + `npm run typecheck` in every touched
  package before opening the PR.
- **Title format**: `[toolconnector] Brief description` (Conventional-Commits-ish
  titles also accepted; scope = package name).
- CI per package (`.github/workflows/tool*-ci.yml`): typecheck → build → tests.
  Search-quality eval runs when `packages/toolhub` changes.
- Conventional commits recommended for individual commits; PR titles with the
  bracketed package prefix are preferred.
- Keep PRs scoped to the package(s) you actually changed. Security issues:
  security@toolrator.org (never a public issue).

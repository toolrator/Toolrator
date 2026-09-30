# Toolpanel

A small, open-source, self-hostable **control panel** for the [toolconnector](../toolconnector) and [Toolhub](../toolhub). It is a drop-in replacement for the upstream SaaS endpoint — point your toolconnector's `CONNECTOR_UPSTREAM_URL` at toolpanel, and your local AI agent gets its discovery configuration from this panel instead of the upstream SaaS.

Toolpanel is intentionally **lightweight**: a single Node process, Hono HTTP server, server-rendered HTML, zero database, zero build pipeline besides `tsc`. It mirrors only the **communication surface** toolconnector actually consumes (verify-key, search-engine config, the canonical search schema, and the implicit-default search proxy) plus a simple admin UI for Toolhub.

> **⚠️ Local-only by design.** Toolpanel ships with **no authentication**. The HTTP server binds to `127.0.0.1` by default. Do **not** bind it to a public interface (`HOST=0.0.0.0`). The README and server logs repeat this warning. This project is a template — add a reverse proxy + auth if you need anything more.

## 🟢 Project Status

**Previous v0.2.0** — Runtime dependency refresh: `@hono/node-server` 2.x, `zod` 4.6.x, `@types/node` 26, and `"types": ["node"]` declared explicitly in the tsconfig. That release had no functional API changes.

**v0.3.0** — removes the legacy device-flow endpoints and `/device` page. The panel remains a local configuration and administration service without authentication or an OAuth authorization server.

---

## Quick start

### Option 1: Run instantly with npx (NPM Package)
```bash
npx -y @toolrator/toolpanel
# → http://127.0.0.1:7800
```

### Option 2: Run from source
```bash
cd packages/toolpanel
npm install
npm start
# → http://127.0.0.1:7800
```

Then point toolconnector at toolpanel:

```bash
# In the shell that runs toolconnector:
export CONNECTOR_UPSTREAM_URL=http://127.0.0.1:7800
# machine credential — toolpanel accepts any non-empty bearer
export CONNECTOR_API_KEY=toolpanel-local
npx -y @toolrator/toolconnector
```

You also need a running [Toolhub](../toolhub) for the Search UI and admin pages to be useful:

```bash
cd packages/toolhub
SEARCH_BACKEND=memory npm run dev   # → http://127.0.0.1:7600
```

Make sure `SEARCH_ENGINE_BASE_URL` and `SEARCH_ADMIN_TOKEN` in toolpanel's `.env` match the search engine's `PORT` and `SEARCH_ADMIN_TOKEN`.

---

## What it provides

### Landing page `/`
Two big cards. Each is **active** or **inactive** based on environment / state:

- **Toolconnector** card → `/panel/toolconnector`.
  Active iff at least one search engine is configured (`toolpanel-config/search-engines.json`) **or** `CONNECTOR_API_KEY`  is set in the env. The card also shows a status pill that reflects whether a toolconnector has actually been seen calling this panel recently — `toolconnector authorized · last verify-key 12s ago`, `toolconnector seen 3m ago but not since`, or `no toolconnector seen yet — start one with TOOLPANEL_URL=…`. The env hint `TOOLPANEL_URL=http://127.0.0.1:7800 · CONNECTOR_SEARCH_CONFIG_MODE=auto` is always shown so the user knows what to set in the connector.
- **Toolhub** card → `/panel/search`.
  Active iff a `GET ${SEARCH_ENGINE_BASE_URL}/health` returns `status: "ok"`.

When a card is inactive, the button is disabled and a hint explains why.

A JSON view of the same state is exposed at `GET /api/status` for client islands.

### Toolconnector panel `/panel/toolconnector`
CRUD UI for the `search-engines.json` array — exactly the schema toolconnector validates with its Zod (`SearchEngineConfigSchema`):

| Field | Type | Notes |
|---|---|---|
| `id` | string | `^[a-z0-9-]+$`, ≤64, unique |
| `label` | string | ≤80 chars |
| `transport` | `http` \| `mcp-http` \| `mcp-sse` \| `mcp-stdio` | |
| `endpoint` | string | URL (or executable for `mcp-stdio`) |
| `args` | string[] | Required for `mcp-stdio`, comma-separated in the UI |
| `schemaUrl` | string | Hidden for `mcp-stdio` |
| `auth` | `{ type, tokenEnv, headerName }?` | `type`: `bearer` \| `basic` \| `header`. `headerName` required when `type=header` |
| `notes` | string | ≤500 |
| `timeoutMs` | number | default `10000` |
| `enabled` | boolean | default `true` |

Saving writes the file that toolconnector (or this panel's `/api/connector/config/auto`) serves back.

### Search panel `/panel/search`
Public search box with `tags` filters. Queries this panel's `POST /api/search`, which proxies to `${SEARCH_ENGINE_BASE_URL}/search`. Shows server cards, `toolHits`, and facet chips from `/api/facets`.

### Search admin `/panel/search/admin`
List, add, edit, delete, reindex MCP servers — all proxied to `${SEARCH_ENGINE_BASE_URL}/admin/*`:

- List: `GET /admin/dump`
- Add / Edit: `POST /admin/index` with `{ documents: [ <oneDoc> ] }`
- Delete: `DELETE /admin/index/:name`
- Reindex all: `POST /admin/reindex` with the current dump
- Health pill: `GET /health`

Document schema (per the [Toolhub README](../toolhub/README.md)):

| Field | Required | Notes |
|---|---|---|
| `mcp_name` | yes | `[a-z0-9][a-z0-9._/-]{0,127}` |
| `display_name` | yes | ≤256 |
| `tags` | no | array, ≤20 |
| `description` | no | ≤4096 |
| `provider` | no | |
| `docs_url`, `homepage_url` | no | `http(s)` only |
| `protocol_version` | no | MCP protocol version |
| `capabilities` | no | object, e.g. `{ "tools": [...] }` — powers `toolHits` |
| `health_status` | no | free-text status |
| `updated_at` | no | ISO-8601, defaults to now |

---

## Auth (toolconnector ↔ toolpanel)

The connector supports OAuth login against remote authorization servers, but
Toolpanel does **not** implement an OAuth authorization server or interactive
login. Its legacy device-flow endpoints were removed. For local use, configure
a non-empty machine credential in the connector's environment. Toolpanel keeps
the contract surface the connector needs on every boot:

```
Connector boot / every credential change:
  → POST /api/auth/verify-key   (Authorization: Bearer ...)
  ← { valid: true, user: { ... } }   (open mode: any non-empty bearer)
  → GET  /api/connector/config/auto   (Authorization: Bearer ...)
  ← { searchEngines: [...] } + Last-Modified (or 304 Not Modified)
```

Because toolpanel is unauthenticated, `verify-key` accepts any non-empty bearer and `connector/config/auto` always returns the current `search-engines.json`. The connector can therefore run end-to-end locally without any real account.

`GET /api/status` (and the landing card) report whether a toolconnector has actually been seen recently — `toolconnector authorized · last verify-key 12s ago` once a boot completes — so you can tell at a glance whether the connector on your machine is really pointed here.

`/api/search/schema` returns the canonical search schema (the `schemaUrl` the connector fetches for the implicit-default `${CONNECTOR_PRODUCT_NAME}-default` engine — default id `toolconnector-default`):

```json
{
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query (supports typos and prefixes; multi-word triggers hybrid semantic search)." },
      "limit": { "type": "number" },
      "offset": { "type": "number" }
    },
    "required": ["query"]
  },
  "outputDescription": "JSON with `hits` (matching servers) and `toolHits` (matched tools inside those servers) plus `facets` and pagination."
}
```

---

## Liveness probe

Toolpanel exposes a single well-known URL for toolconnector's auto-discovery:

```
GET /.well-known/toolpanel-alive   →   204 No Content
```

Any 2xx means "toolpanel is here." Anything else (including 404) means "not here." No body, no auth, no side effects — safe to call on every connector boot. The connector's `isToolpanelAlive()` probe uses this URL, gated by `TOOLPANEL_DISCOVERY` (default `auto`).

The probe path is published here as a stable contract — do not rename it without also updating `TOOLPANEL_PROBE_PATH` in `packages/toolconnector/src/config.ts`.

---

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7800` | HTTP server port |
| `HOST` | `127.0.0.1` | Bind address. **Do not** set `0.0.0.0` (panel is unauthenticated). |
| `TOOLPANEL_PUBLIC_URL` | `http://127.0.0.1:$PORT` | Public URL advertised by the panel. |
| `TOOLPANEL_CONFIG_DIR` | `./toolpanel-config` | Where `search-engines.json` is stored. |
| `SEARCH_ENGINE_BASE_URL` | `http://127.0.0.1:7600` | Upstream Toolhub URL. |
| `SEARCH_ADMIN_TOKEN` | `dev-admin-token` | Bearer token for upstream `/admin/*` calls. Must match the search engine's `SEARCH_ADMIN_TOKEN`. |
| `CONNECTOR_API_KEY` | _(unset)_ | If set, advertised in the panel UI as a ready-to-use API key for toolconnector. |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Toolpanel  (Hono + @hono/node-server, single Node process)  │
│                                                              │
│  Browser UI      ◀──── server-rendered HTML + app.ts islands │
│  /                Landing (status-aware cards)              │
│  /panel/toolconnector  search-engines.json CRUD             │
│  /panel/search          public search (proxy)                │
│  /panel/search/admin    MCP server admin (proxy)            │
│                                                              │
│  /api/auth/verify-key                                            │
│  /api/connector/config          (GET/PUT)                       │
│  /api/connector/config/auto     (GET)                           │
│  /api/search                    (GET/POST)   ──┐                │
│  /api/search/schema             (GET)          │  proxy          │
│  /api/facets                    (GET)          ▼                │
│                                       ┌─────────────────────┐   │
│                                       │       Toolhub       │   │
│                                       │  /search /admin/*   │   │
│                                       │  /facets /health    │   │
│                                       └─────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

State is a couple of JSON files in `TOOLPANEL_CONFIG_DIR`. There is no database, no JWT, no session, no OAuth — by design.

---

## Scripts

```bash
npm install          # deps
npm run dev          # tsx, live reload
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/
npm start            # build + run dist/server.js
```

A `.env` file in the current working directory is loaded automatically by
`npm run dev` and `npm start` (Node's `--env-file-if-exists`). Copy
`.env.example` to `.env` and adjust the values there.

---

## License

Apache License 2.0. © Toolrator.

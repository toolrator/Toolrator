# Toolhub

A fast, typo-tolerant search engine for discovering MCP servers. Part of the toolconnector/toolpanel ecosystem.

## Features

- **Full-text search** with typo tolerance (MeiliSearch) and prefix matching
- **Semantic / hybrid search** — queries are vectorized locally with an ONNX embedder (`Xenova/multilingual-e5-small`, 384-dim) and fused with lexical results via MeiliSearch's hybrid search. Lexical-only fallback when no vector is available (e.g. single short keywords, or the in-memory backend).
- **Tool-level matching** — search results include matched individual tools (`toolHits`) extracted from each server's `capabilities.tools`, with a compact schema summary.
- **Faceted filtering** by tags and provider
- **Pluggable adapter architecture** — swap search backends without changing business logic
- **Admin API** for document ingestion with strict validation and normalization
- **Result caching** — search results are cached (LRU, 60s TTL); admin writes evict the cache. Query embeddings are cached separately (LRU, 1h TTL).
- **Two search backends:**
  - **MeiliSearch** (recommended for production) — sub-50ms queries, typo tolerance, faceted search, and the only backend that supports semantic/hybrid search.
  - **In-memory** (for development/testing) — no external service required. Performs substring/lexical matching; typo tolerance and semantic search are not available in this mode.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables (optional for local in-memory dev)
cp .env.example .env

# 3. Start in development mode (in-memory adapter, no MeiliSearch needed)
SEARCH_BACKEND=memory npm run dev

# 4. Run tests
npm test
```

> Semantic search loads the ONNX model `Xenova/multilingual-e5-small` on first use; this requires a one-time download from the HuggingFace Hub and the `@xenova/transformers` dependency (installed with `npm install`). On failure it silently falls back to lexical search.

## API Endpoints

### Public (no auth required)

| Endpoint | Method | Description |
|:---|:---|:---|
| `/health` | `GET` | Health check with backend status and document count |
| `/search?q=...` | `GET` | Full-text (and hybrid) search with filters |
| `/search` | `POST` | Same, with JSON body for complex queries |
| `/suggest?q=...` | `GET` | Autocomplete endpoint — lexical-only, cached, default `limit=5` |
| `/mcp/:name` | `GET` | Get a single MCP server by name |
| `/facets` | `GET` | Get available filter facets with counts |

> All routes have CORS enabled and append a `Server-Timing: search;dur=...` header.

### Admin (requires `Authorization: Bearer <SEARCH_ADMIN_TOKEN>`)

| Endpoint | Method | Description |
|:---|:---|:---|
| `/admin/index` | `POST` | Index one or more documents |
| `/admin/index/:name` | `DELETE` | Remove a document |
| `/admin/reindex` | `POST` | Full reindex from payload |
| `/admin/dump` | `GET` | Export all indexed documents (used by the hourly cron to build the search-index dump) |

### Search Query Parameters

| Parameter | Type | Description |
|:---|:---|:---|
| `q` | `string` | Search query (supports typos, prefixes; multi-word queries trigger hybrid semantic search on MeiliSearch) |
| `tags` | `string` | Comma-separated tag filter (AND logic) |
| `provider` | `string` | Filter by provider name |
| `limit` | `number` | Max results (default: 20, max: 100) |
| `offset` | `number` | Pagination offset |
| `maxTools` | `number` | Max `toolHits` to return per query (default: 10) |

> Search results are cached for 60 seconds. After any admin write (`/admin/index`, `/admin/index/:name`, `/admin/reindex`) the cache is cleared, so new documents appear immediately.

### Example

```bash
# Search for GitHub-related code tools
curl "http://localhost:7600/search?q=github&tags=code"

# Index a new MCP server
curl -X POST http://localhost:7600/admin/index \
  -H "Authorization: Bearer dev-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"documents": [{"mcp_name": "my-server", "display_name": "My Server", "tags": ["code"]}]}'
```

## Search Response

A `/search` (and `/suggest`) call returns JSON like:

```json
{
  "hits": [ { "mcp_name": "...", "display_name": "...", "_score": 1.0, ... } ],
  "toolHits": [
    {
      "name": "tool_name",
      "description": "...",
      "compactSchema": "arg*(string: url), ...",
      "server_mcp_name": "...",
      "server_health_status": "healthy"
    }
  ],
  "total": 42,
  "offset": 0,
  "limit": 20,
  "processingTimeMs": 3,
  "facets": { "tags": { "code": 42 }, "provider": { "acme": 7 } }
}
```

- `hits` — matching servers, ordered by relevance (`_score` is present on the in-memory backend, omitted on MeiliSearch).
- `toolHits` — individual tools matched within `hits` (capped by `maxTools`). Each carries a `compactSchema` (a truncated input-schema summary) and its parent server's metadata.
- `facets` — distribution counts for `tags`, `provider`, and `health_status`.

`/health` returns `{ "status": "ok" | "degraded", "service": "toolhub", "backend": "...", "documentCount": N }` and responds `503` when degraded.

## Document Schema & Validation

Admin ingestion (`/admin/index`, `/admin/reindex`) accepts a JSON body in any of these shapes:

```json
{ "documents": [ ... ] }     // preferred
[ ... ]                      // bare array
{ "mcp_name": "...", ... }   // single document object
```

Each document is validated and normalized. Required and supported fields:

| Field | Required | Notes |
|:---|:---|:---|
| `mcp_name` | yes | Lowercase `[a-z0-9][a-z0-9._\/-]{0,127}`. Invalid names are skipped. |
| `display_name` | yes | Truncated to 256 chars. |
| `tags` | no | Array, lowercased/deduplicated, max **20**. |
| `description` | no | Truncated to 4096 chars. |
| `provider` | no | Provider name. |
| `docs_url`, `homepage_url` | no | Sanitized to `http(s)` only; invalid URLs are dropped. |
| `protocol_version` | no | MCP protocol version. |
| `capabilities` | no | Object (e.g. `{ "tools": [...] }`); powers `toolHits`. |
| `health_status` | no | Free-text status string. |
| `updated_at` | no | ISO-8601 timestamp; defaults to now if omitted. |

Internally, each document gets a `semantic_text` summary and a precomputed 384-dim `_vectors.default` embedding for hybrid search. Invalid documents are skipped (the response reports `indexed` vs `skipped` counts).

## Configuration

All settings are via environment variables:

| Variable | Default | Description |
|:---|:---|:---|
| `PORT` | `7600` | HTTP server port |
| `SEARCH_ADMIN_TOKEN` | `dev-admin-token` | Bearer token for admin endpoints |
| `SEARCH_BACKEND` | `meilisearch` | Search backend: `meilisearch` or `memory` |
| `MEILI_URL` | `http://localhost:7700` | MeiliSearch server URL |
| `MEILI_SEARCH_KEY` | `` | MeiliSearch search-only API key |
| `MEILI_ADMIN_KEY` | `` | MeiliSearch admin API key |
| `MEILI_INDEX_NAME` | `mcp_servers` | MeiliSearch index name |
| `SEARCH_MAX_LIMIT` | `100` | Maximum results per query |
| `SEARCH_DEFAULT_LIMIT` | `20` | Default results per query |
| `LOG_LEVEL` | `info` | Log verbosity |

## Docker

```bash
# Build
docker build -t @toolrator/toolhub .

# Run with MeiliSearch
docker run -p 7600:7600 \
  -e MEILI_URL=http://meilisearch:7700 \
  -e MEILI_ADMIN_KEY=your-key \
  -e SEARCH_ADMIN_TOKEN=your-admin-token \
  @toolrator/toolhub
```

### Monitoring Container Stats

To monitor resource utilization of your Search Engine and MeiliSearch containers, you can use the provided monitoring scripts:

- **Windows (PowerShell)**: Run `./docker-stats.ps1`
- **Linux / macOS (Bash)**: Run `chmod +x docker-stats.sh && ./docker-stats.sh`


## Architecture: Adapter Pattern

The search engine uses a pluggable adapter interface (`SearchAdapter`) to abstract the search backend. This makes it trivial to swap MeiliSearch for a more advanced engine later:

```
┌──────────────┐     ┌─────────────────┐     ┌───────────────────┐
│  HTTP Server │────►│  SearchService  │────►│  SearchAdapter    │
│  (Hono)      │     │  (business      │     │  (interface)      │
│              │     │   logic)        │     ├───────────────────┤
└──────────────┘     └─────────────────┘     │ MeiliSearchAdapter│
                                              │ MemoryAdapter     │
                                              │ YourCustomAdapter │
                                              └───────────────────┘
```

To add a new backend, implement the `SearchAdapter` interface in `src/adapters/` and add it to the adapter factory in `src/server.ts`.

## Known Issues

- **Transitive dependency advisories** — `npm audit` reports vulnerabilities in `onnxruntime-web` and `sharp`, pulled in transitively via `@xenova/transformers` (used for local ONNX embeddings). The only automated remediation is a breaking downgrade to `@xenova/transformers@1.x`, which would change the embedder API. This is tracked; we recommend running toolhub as a private service (default bind `127.0.0.1`) until the dependency chain is updated.

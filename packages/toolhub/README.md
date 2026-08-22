# Toolhub

A fast, typo-tolerant search engine for discovering MCP servers. Part of the toolconnector/toolpanel ecosystem.

## Features

- **Full-text search** with typo tolerance (MeiliSearch) and prefix matching
- **Semantic / hybrid search** — queries are vectorized by a pluggable embedding provider (opt-in: local ONNX `Xenova/multilingual-e5-small`, or any OpenAI-compatible API — Cloudflare Workers AI, OpenRouter, ... see the embedding models guide below) and fused with lexical results via MeiliSearch's hybrid search. Embeddings are **off by default** (`TOOLHUB_EMBEDDING_PROVIDER` unset → pure lexical search); semantic search activates only when a provider is configured. Lexical-only fallback when no vector is available (e.g. single short keywords, the in-memory backend, or an embedding failure).
- **Tool-level ranking (D7 tool index)** — every tool from `capabilities.tools` is indexed as its own document (`mcp_tools`) and ranked by RRF against the server surface. Tool evidence rolls up into server cards (bounded: a tool cluster can never outrank the direct rank-1 server) and `toolHits` returns the matched tools with compact schema summaries.
- **Heuristic intent classification** — each query is labeled `server` or `tool` (with confidence) via exact matches, action-cue/tool-name-overlap rules and a multi-tool aggregation rule; the `maxTools` cap widens on tool intent.
- **Embedding fingerprint & auto-reindex signal** — the active embedding configuration (provider, model, dims, budget, pooling, indexer version) is recorded as a fingerprint. `/health` reports it alongside the fingerprint the index was last built with, and `needsReindex` flips when they diverge — the enterprise control plane reindexes automatically (cooldown-protected).
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

> Semantic search is **off by default** — without `TOOLHUB_EMBEDDING_PROVIDER`, toolhub runs pure lexical search (zero memory overhead). To enable it, set `TOOLHUB_EMBEDDING_PROVIDER` **and** `TOOLHUB_EMBEDDING_BATCH_SIZE` (required, no default — see the embedding models guide). The local ONNX provider loads the `Xenova/multilingual-e5-small` model on first use (one-time download from the HuggingFace Hub, ~80 MB) and runs inference on your CPU — RAM usage scales with `TOOLHUB_EMBEDDING_BATCH_SIZE`, so on memory-constrained machines prefer the `openai-compatible` provider (zero local inference) or keep lexical-only. On any embedding failure the search silently falls back to lexical.

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
| `/admin/index` | `GET` | List the index: every server doc (id, `updated_at`, `content_hash`, `has_vector`) and every tool doc |
| `/admin/index` | `POST` | Index one or more documents (upserts the server and rebuilds its tool docs from `capabilities.tools`) |
| `/admin/index/:name` | `DELETE` | Remove a document (cascade-deletes its tool docs) |
| `/admin/reindex` | `POST` | Full reindex from payload; records the active embedding fingerprint afterwards |
| `/admin/sync` | `POST` | Incremental sync: `{ upsert: [...], delete: [...] }` — applies the diff and reports `toolsIndexed`/`deleted` per server |
| `/admin/tools` | `GET` | Export all tool documents (used by the hourly cron for the v2 dump's `tools.json`) |
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
  "intent": "server",
  "intentConfidence": 0.5,
  "diagnostics": { "serverHits": 20, "toolHits": 7 },
  "processingTimeMs": 3,
  "facets": { "tags": { "code": 42 }, "provider": { "acme": 7 } }
}
```

- `hits` — matching servers, ordered by the RRF merge of the direct server ranking and the tool rollup (direct weight 0.55, tool rollup 0.45; rollup contributions are capped so tool clusters refine but never dominate the rank-1 server).
- `toolHits` — individual tools matched in the `mcp_tools` index (capped by `maxTools`; up to 3 per server, 5 on tool intent). Each carries a `compactSchema` (a truncated input-schema summary) and its parent server's metadata.
- `intent` / `intentConfidence` — heuristic label of the query (`server` or `tool`) and its confidence (see the Search Quality section).
- `diagnostics` — `serverHits` (how many server docs entered the merge) and `toolHits` (how many tool docs entered the rollup).
- `facets` — distribution counts for `tags`, `provider`, and `health_status`.

`/health` returns `{ "status": "ok" | "degraded", "service": "toolhub", "backend": "...", "documentCount": N, "toolDocumentCount": M, "embedding": { "currentFingerprint": "...", "activeFingerprint": "...", "needsReindex": bool, "provider": "...", "model": "...", "dimensions": N } }` and responds `503` when degraded. `needsReindex` is `true` when the current embedding configuration differs from the one the index was built with.

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
| `base_url` | no | Direct connection URL for the MCP server. Sanitized to `http(s)` only. |
| `protocol_version` | no | MCP protocol version. |
| `capabilities` | no | Object (e.g. `{ "tools": [...] }`); powers `toolHits`. |
| `health_status` | no | Free-text status string. |
| `updated_at` | no | ISO-8601 timestamp; defaults to now if omitted. |

Internally, each document gets a `semantic_text` summary and a precomputed embedding (`_vectors.default`, dimensions per the active provider/model) for hybrid search. Invalid documents are skipped (the response reports `indexed` vs `skipped` counts).

## Configuration

All settings are via environment variables:

| Variable | Default | Description |
|:---|:---|:---|
| `HOST` | `127.0.0.1` | Host/interface to bind — `127.0.0.1` (loopback only) or `0.0.0.0` to expose externally |
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
| `TOOLHUB_EMBEDDING_PROVIDER` | *(unset)* | Embedding provider: unset/`null` (lexical-only, default), `local` (ONNX on CPU — RAM scales with `TOOLHUB_EMBEDDING_BATCH_SIZE`) or `openai-compatible` (any OpenAI-compatible embeddings API) |
| `TOOLHUB_LOCAL_EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | ONNX model for the local provider |
| `TOOLHUB_LOCAL_EMBEDDING_DIMENSIONS` | `384` | Vector dimensionality of the local model |
| `TOOLHUB_LOCAL_EMBEDDING_MAX_CHARS` | `2048` | Max input chars for the local model (~4 chars/token) |
| `TOOLHUB_EMBEDDING_BASE_URL` | — | OpenAI-compatible API base URL (required for `openai-compatible`), e.g. `https://api.openai.com/v1` |
| `TOOLHUB_EMBEDDING_API_KEY` | — | Bearer API key (required for `openai-compatible`) |
| `TOOLHUB_EMBEDDING_MODEL` | `text-embedding-3-small` | Model name (see registry below) |
| `TOOLHUB_EMBEDDING_INPUT_TYPE_DOC` | — | Optional `input_type` for document embeddings (asymmetric models, e.g. `search_document`) |
| `TOOLHUB_EMBEDDING_INPUT_TYPE_QUERY` | — | Optional `input_type` for query embeddings (asymmetric models, e.g. `search_query`) |
| `TOOLHUB_EMBEDDING_DIMENSIONS` | registry | Override vector dimensionality (custom models) |
| `TOOLHUB_EMBEDDING_CONTEXT_TOKENS` | registry | Override model context window in tokens (custom models) |
| `TOOLHUB_EMBEDDING_MAX_CHARS` | registry | Override max input chars (custom models) |
| `TOOLHUB_EMBEDDING_CHARS_PER_TOKEN` | `3.5` | Chars per token used for the embedding budget |
| `TOOLHUB_EMBEDDING_BUDGET_SAFETY_FACTOR` | `0.95` | Safety factor applied to the embedding budget |
| `TOOLHUB_EMBEDDING_MIN_CHUNK_CHARS` | `64` | Minimum chunk length before embedding |
| `TOOLHUB_EMBEDDING_POOLING_MODE` | `weighted_mean` | Pooling mode (`weighted_mean` or `simple_mean`) |
| `TOOLHUB_EMBEDDING_BATCH_SIZE` | *(required, no default)* | Embedding batch size — **required whenever an embedding provider is enabled** (deliberately no default: the safe value depends on your host's RAM, so a silent default would hide misconfiguration). Applies to both providers — every forward pass / API request is packed into count- and char-bounded batches, so memory scales with this value, never with catalog size. Start at `32`; use `8` for local ONNX on ≤8 GB hosts. Irrelevant for lexical-only setups. |
| `TOOLHUB_EMBEDDING_CONCURRENCY` | `4` | Parallel embedding requests (2 for 8B-class models; remote provider only) |
| `TOOLHUB_EMBEDDING_RETRIES` | `3` | Retry count for embedding requests (remote provider) |
| `TOOLHUB_EMBEDDING_MAX_BATCH_CHARS` | `100000` | Max chars per embedding batch (applies to both providers — the local ONNX provider splits every forward pass into count- and char-bounded batches so real-scale reindexes can't OOM) |
| `TOOLHUB_MAX_DESCRIPTION_CHARS` | `4096` | Description cap for the semantic text builder |
| `TOOLHUB_MAX_SEMANTIC_CHARS` | `16000` | Semantic text cap per document |
| `TOOLHUB_TOOL_INDEX_ENABLED` | `true` | Enable the `mcp_tools` tool index |
| `TOOLHUB_TOOL_INDEX_NAME` | `mcp_tools` | Tool index name |
| `TOOLHUB_MAX_TOOLS_EMBEDDED` | `64` | Max tools embedded per server |
| `TOOLHUB_MAX_TOOL_DESC_CHARS` | `1200` | Tool description cap |
| `TOOLHUB_MAX_TOOL_SCHEMA_CHARS` | `1200` | Tool input-schema cap |
| `TOOLHUB_RRF_K` | `60` | RRF constant for the rank fusion |
| `TOOLHUB_DIRECT_SERVER_WEIGHT` | `0.55` | Weight of the direct server ranking |
| `TOOLHUB_TOOL_ROLLUP_WEIGHT` | `0.45` | Weight of the tool rollup |
| `TOOLHUB_SEARCH_SERVER_TOP_K` | `20` | Server docs fetched per query |
| `TOOLHUB_SEARCH_TOOL_TOP_K` | `50` | Tool docs fetched per query |
| `TOOLHUB_MAX_TOOL_HITS_RETURNED` | `10` | Max `toolHits` in the response |
| `TOOLHUB_INTENT_ENABLED` | `true` | Enable the intent classifier |
| `TOOLHUB_INTENT_FALLBACK` | `server` | Intent when the classifier is uncertain |
| `TOOLHUB_INTENT_TOOL_MIN_SCORE` | `0.35` | Min top-tool score for tool intent |
| `TOOLHUB_INTENT_TOOL_MARGIN` | `0.05` | Min tool-vs-server margin for tool intent |
| `TOOLHUB_INTENT_MULTI_TOOL_COUNT` | `3` | Strong tool hits from one server that flip intent to `server` |
| `TOOLHUB_INTENT_MULTI_TOOL_TOP_N` | `10` | Tool hits examined for the multi-tool rule |
| `TOOLHUB_INTENT_MULTI_TOOL_MIN_SCORE` | `0.3` | Min score for the multi-tool rule |
| `TOOLHUB_ONNX_THREADS` | auto | Pin ONNX threads for the local provider |

### Embedding models — a practical guide

Semantic search needs dense vectors. Toolhub gets them from a **pluggable embedding provider** selected at boot via `TOOLHUB_EMBEDDING_PROVIDER`. Every provider (and every model) declares two capabilities that drive the whole system:

- **`dimensions`** — vector dimensionality; MeiliSearch's vector settings are configured from it automatically.
- **`maxInputChars`** — max input length in characters; documents are **truncated** to this before embedding (with a `…` marker), so a small-window model can never be fed oversized text.

There is exactly one abstraction (`src/embedder.ts`, `EmbeddingProvider` interface), so switching providers or models is purely configuration — no code changes.

#### Choosing a provider

| | `null` (default) | `local` | `openai-compatible` |
|:---|:---|:---|:---|
| **Runs on** | — (no embeddings) | Your CPU (ONNX Runtime) | The API host's GPUs (OpenAI, OpenRouter, Cloudflare Workers AI, Groq, ...) |
| **Latency per embedding** | — | ~8–20 ms | Host-dependent: ~100 ms (CF bge-small), ~1.4–2.8 s (qwen3-0.6b, p50) |
| **Cost** | — | Free (electricity) | Per-token pricing of the host (OpenAI ≈ $0.02/M tokens; CF free allowance ~10k neurons/day) |
| **Setup** | None | One-time model download from HuggingFace (~80 MB) | Base URL + API key + model name |
| **Offline** | Yes | Yes, after the initial download | No |
| **Best for** | Dev, minimal footprints, RAM-limited hosts | Self-hosting, privacy, high query volume | Zero local inference, managed ops, multilingual (qwen3), any OpenAI-compatible host |

`openai-compatible` is a **single universal client** for the OpenAI embeddings protocol — one implementation that talks to any host exposing `POST {baseUrl}/embeddings` with a Bearer token: OpenAI, OpenRouter, Cloudflare Workers AI, Groq, Mistral, Together, vLLM, Ollama, LM Studio, ... Only the base URL, key and model name differ. Example base URLs:

| Host | Base URL |
|:---|:---|
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| vLLM / Ollama / LM Studio (self-hosted) | `http://localhost:8000/v1` (vLLM) etc. |


#### How to configure

```bash
# Default: lexical-only search, no embeddings, no config needed.
# (Leave TOOLHUB_EMBEDDING_PROVIDER unset.)

# Local ONNX on your CPU (opt-in; RAM usage scales with batch size —
# keep it low on memory-constrained machines). Batch size is REQUIRED:
TOOLHUB_EMBEDDING_PROVIDER=local
TOOLHUB_EMBEDDING_BATCH_SIZE=32

# Any OpenAI-compatible host — base URL + key + model + batch size required
# together (no default for any of them).
# OpenAI:
TOOLHUB_EMBEDDING_PROVIDER=openai-compatible
TOOLHUB_EMBEDDING_BASE_URL=https://api.openai.com/v1
TOOLHUB_EMBEDDING_API_KEY=sk-...
TOOLHUB_EMBEDDING_MODEL=text-embedding-3-small
TOOLHUB_EMBEDDING_BATCH_SIZE=32

# OpenRouter (model names carry a provider prefix):
# TOOLHUB_EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
# TOOLHUB_EMBEDDING_API_KEY=sk-or-v1-...
# TOOLHUB_EMBEDDING_MODEL=openai/text-embedding-3-small

# Cloudflare Workers AI (openai-compatible endpoint; token needs the
# Workers AI permission):
# TOOLHUB_EMBEDDING_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
# TOOLHUB_EMBEDDING_API_KEY=<CF_API_TOKEN>
# TOOLHUB_EMBEDDING_MODEL=@cf/baai/bge-small-en-v1.5

# Asymmetric models benefit from explicit input types — the values are
# model-specific:
#   bge-m3 (Workers AI) / OpenRouter in general: search_document / search_query
#   nemotron-3-embed-1b (NVIDIA, OpenRouter):  passage / query
# TOOLHUB_EMBEDDING_INPUT_TYPE_DOC=search_document
# TOOLHUB_EMBEDDING_INPUT_TYPE_QUERY=search_query

# Optional: pin local model / override capabilities (e.g. custom fine-tunes)
TOOLHUB_LOCAL_EMBEDDING_MODEL=Xenova/multilingual-e5-small
TOOLHUB_LOCAL_EMBEDDING_DIMENSIONS=384
TOOLHUB_LOCAL_EMBEDDING_MAX_CHARS=2048
TOOLHUB_EMBEDDING_DIMENSIONS=1536
TOOLHUB_EMBEDDING_MAX_CHARS=4096
```

`packages/toolhub/.env` (gitignored) is loaded automatically by `npm start` / `npm run dev` (Node `--env-file-if-exists`). API keys only ever need permissions for the embedding model being called.

#### Switching models / providers

Every model embeds into its **own vector space** — vectors from different models are not comparable and must not be mixed:

1. Change the env vars (see above).
2. **Reindex** (`POST /admin/reindex`). When the dimensionality changed, MeiliSearch rejects the old vector settings; toolhub detects this and automatically rebuilds the settings and wipes incompatible vectors (self-healing, verified with 384→1024 switches). The full reindex records the new embedding fingerprint.
3. **Or let the control plane do it** — `/health` exposes `embedding.currentFingerprint` vs `activeFingerprint` and `needsReindex`. When they diverge, the enterprise cron reindexes automatically (cooldown-protected) — restarting toolhub after a config change is enough to trigger it.
4. Start queries. During the transition, or if any single embedding fails, that query degrades to lexical-only search — never an error.

#### Evaluations & baselines

- **Quality eval** (`npm run eval:search`) runs 32 server-surface queries plus 16 tool-surface queries and scores precision@1/3, weighted, intent accuracy, tool-evidence rate and false-tool rate against the synthetic fixture. Baselines are stored **per provider/model** (`tests/fixtures/search-eval-baseline.json`), so switching models never false-fails the gate — a model without its own baseline bootstraps it; scores must stay within tolerance of that model's own history. The gate asserts the server weighted/p@3, the tool p@3 and the intent accuracy.
- **Real-MCP benchmark** (`npm run eval:search:real`) runs 32 server-surface queries plus 20 tool-surface queries (52 total) against ~263 authentic MCP servers (~4,000 tools) downloaded on demand from the public Smithery registry. Because the raw catalog data is downloaded on demand for local benchmarking only and not redistributed/committed to the repository, you can fetch it with:
  ```bash
  node tests/tools/fetch-smithery-catalog.mjs
  ```
  Once fetched, run the benchmark with:
  ```bash
  npm run eval:search:real
  ```
  The real-catalog baseline is stored separately in `tests/fixtures/search-eval-baseline-real.json` (per-provider/model keyed) and can be refreshed via `npm run eval:search:real:update`. Provenance and licensing metadata are recorded in `tests/fixtures/real/provenance.json`.
- **Perf eval** (`npm run eval:perf:quick` / `npm run eval:perf -- --config 2c4g`) records the embedding `provider` + `model` in each baseline section. A run whose provider/model differs from the recorded section is **informational only** (report without assertion) — thresholds measured with one model are meaningless for another.
- Measured quality on the fixture eval (bge-small, production config): **server weighted 82** (p@1 72%, p@3 91%), **tool weighted 98** (p@1 94%, p@3 100%), **intent accuracy 85%**, false-tool 0%. The local ONNX fallback scores lower on intent (63%) because its compressed cosine space defeats the tool/server margin — it is a dev fallback, not a production gate. Other models: local 78, bge-small 80 (pre-tool), qwen3-0.6b 83, text-embedding-3-small 84, nemotron-3-embed-1b 87 — re-run `npm run eval:search` to reproduce (requires the matching provider env).

#### Search quality design

- **Hybrid search & adaptive semantic ratio** — on MeiliSearch, vector and lexical matches are fused with an adaptive `semanticRatio` based on query length (0.3 for short queries $\le$ 2 words, 0.7 for long natural-language queries $\ge$ 5 words, 0.5 default).
- **Merge** — server and tool rankings are fused with RRF (k=60): `score = 0.55 · rrf(serverRank) + 0.45 · rollup(toolRanks)`, where the rollup weights the top-5 tool ranks with a [1, .75, .55, .4, .3] decay and is **capped at `1/(k+1)`** so tool clusters can refine a server card but never outrank the direct rank-1 server.
- **Intent** — evaluated in order: exact server match → `server` (0.95); exact tool match → `tool` (0.95); specific tool (top tool ≥ 0.35, beats the competing servers by the margin, action cue or tool-name overlap) → `tool`; 3+ strong (≥ 0.3) tool hits from one server in the top-10 → `server` (aggregation intent); otherwise the fallback. When the top server IS the tool's home server, the margin is measured against the best *other* server with a stricter threshold (+0.05), because a tool always embeds close to its own server.
- **Fingerprint** — `v2|provider|model|dims|maxInputChars|charsPerToken|minChunkChars|poolingMode|indexer-2|compact-schema-1|toolIndexName` is recorded at each full reindex. Changing the embedding config (model, pooling, budget, ...) makes `/health` report `needsReindex: true`; the enterprise control plane reindexes automatically (15-min cooldown, 60-min backoff).

#### Troubleshooting

| Symptom | Cause / fix |
|:---|:---|
| `[embedder] TOOLHUB_EMBEDDING_PROVIDER=... requires TOOLHUB_EMBEDDING_BATCH_SIZE ...` | Batch size has no default by design — set `TOOLHUB_EMBEDDING_BATCH_SIZE` explicitly (e.g. `32`) whenever a provider is enabled |
| `[embedder] TOOLHUB_EMBEDDING_PROVIDER=openai-compatible requires ...` | Missing `TOOLHUB_EMBEDDING_BASE_URL` / `TOOLHUB_EMBEDDING_API_KEY` |
| HTTP 401 / 403 from the API | Key wrong, lacks permissions, or the base URL points at the wrong account |
| HTTP 429 | Host rate/quota limit exceeded — retried once automatically, then this query falls back to lexical |
| `Unexpected OpenAI-compatible embeddings response shape` | API schema changed — update `extractVector` in `src/embedder.ts` (tolerates the standard `data[0].embedding` + a nested `data[0].data`) |
| API rejects `input_type` | Model is symmetric (e.g. OpenAI `text-embedding-3-*`) — unset `TOOLHUB_EMBEDDING_INPUT_TYPE_*`; or the values are wrong for the model (e.g. nemotron wants `passage`/`query`, not `search_document`/`search_query`) |
| `_vectors` / settings task failure during reindex | Dimension change — automatic wipe-and-retry handles it; if the log shows repeated failures, verify `TOOLHUB_*_EMBEDDING_DIMENSIONS` matches the model |
| Semantic results look wrong after switching models | Old vectors from the previous model are still indexed — reindex |

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

- **Transitive dependency advisories** — `npm audit` reports vulnerabilities in `onnxruntime-web` and `sharp`, pulled in transitively via `@xenova/transformers` (used for local ONNX embeddings). The only automated remediation is a breaking downgrade to `@xenova/transformers@1.x`, which would change the embedder API. This is tracked.

- **Loopback-only by default** — the server binds `127.0.0.1` (see `HOST`). To expose it to other machines, set `HOST=0.0.0.0` explicitly and put it behind a firewall/reverse proxy; the admin endpoints are only protected by `SEARCH_ADMIN_TOKEN`.

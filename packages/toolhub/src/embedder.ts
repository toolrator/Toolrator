// ---------------------------------------------------------------------------
// toolhub — Embedding Providers
// ---------------------------------------------------------------------------
// Dense vectors for semantic hybrid search are produced by an interchangeable
// embedding provider, selected at boot via TOOLHUB_EMBEDDING_PROVIDER:
//
//   local            (opt-in) Transformers.js (@xenova/transformers) running
//                    an ONNX model on the local CPU. Model, vector
//                    dimensionality and input length are configurable via
//                    TOOLHUB_LOCAL_EMBEDDING_*. Fully offline after the
//                    one-time model download. RAM usage scales with
//                    TOOLHUB_EMBEDDING_BATCH_SIZE — prefer a remote provider
//                    or lexical-only on memory-constrained hosts.
//
//   openai-compatible Any API that speaks the OpenAI embeddings protocol:
//                    POST {baseUrl}/embeddings with {model, input} and a
//                    Bearer token, responding with {data:[{embedding}]}.
//                    Works with OpenAI, OpenRouter, Cloudflare Workers AI
//                    (https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1),
//                    Groq, Mistral, vLLM, Ollama and most other hosts.
//                    Requires TOOLHUB_EMBEDDING_BASE_URL +
//                    TOOLHUB_EMBEDDING_API_KEY; model selected via
//                    TOOLHUB_EMBEDDING_MODEL; dimensions and input length come
//                    from a built-in registry, overridable via
//                    TOOLHUB_EMBEDDING_DIMENSIONS / TOOLHUB_EMBEDDING_MAX_CHARS.
//                    Asymmetric models can be driven with
//                    TOOLHUB_EMBEDDING_INPUT_TYPE_DOC / _QUERY (e.g.
//                    "search_document" / "search_query" on OpenRouter and
//                    Workers AI, or "passage" / "query" on NVIDIA models),
//                    sent as the API's `input_type` field.
//
// Every provider:
//   - declares its vector dimensionality and its maximum input budget (chars);
//   - truncates nothing: texts that exceed the budget are split into
//     code-point-safe chunks that are embedded and length-weighted mean-pooled
//     (with L2 normalization) so the final vector covers the whole text;
//   - supports embedMany() for batched, retried, rate-limit-aware embedding
//     where one bad input can never kill the whole batch.
//
// Token budgeting is deliberate, not assumed: budgets are derived from the
// provider-declared context window (tokens) × a chars-per-token ratio
// (TOOLHUB_EMBEDDING_CHARS_PER_TOKEN, default 3.5 — conservative for
// code/JSON-heavy MCP content) × a safety factor (default 0.95), capped by an
// explicit maxInputChars when the registry supplies one. The API is treated
// as ground truth: a context/token/length error triggers an automatic chunk
// budget shrink and retry instead of a hard failure.
//
// NOTE: switching providers or models invalidates already-indexed vectors
// because the vector space differs — reindex after a switch (see the
// embedding fingerprint / auto-reindex feature). The search backend
// automatically rebuilds its vector settings on a dimension change.
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  /** Provider kind ("local" | "openai-compatible"). */
  readonly provider: string;
  /** Resolved model name. */
  readonly model: string;
  /** Vector dimensionality produced by the underlying model. */
  readonly dimensions: number;
  /** Maximum input length in characters per embedding request. */
  readonly maxInputChars: number;
  /** Embed a single document text for indexing (chunked + pooled if needed). */
  embedDocument(text: string): Promise<number[]>;
  /** Embed a single search query. Queries are never chunked. */
  embedQuery(text: string): Promise<number[]>;
  /**
   * Embed many texts in one call. Returns one vector per input, aligned by
   * index; `null` marks a text that could not be embedded after all retries.
   * Long texts are chunked + pooled automatically.
   */
  embedMany(texts: string[], kind?: "document" | "query"): Promise<Array<number[] | null>>;
}

/** Model capability spec: vector dimensionality + context/budget. */
export interface ModelSpec {
  dimensions: number;
  /** Provider-declared maximum input context in tokens (if known). */
  contextTokens?: number;
  /** Explicit maximum input in chars (overrides the computed budget). */
  maxInputChars?: number;
  /** Per-model chars-per-token ratio override (default 3.5). */
  charsPerToken?: number;
  /** Whether the model supports an `input_type` request field. */
  supportsInputType?: boolean;
  inputTypeDoc?: string;
  inputTypeQuery?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Model registry & env resolution
// ---------------------------------------------------------------------------

const DEFAULT_LOCAL_MODEL = "Xenova/multilingual-e5-small";
const DEFAULT_REMOTE_MODEL = "text-embedding-3-small";
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_CHARS_PER_TOKEN = 3.5;
const DEFAULT_SAFETY_FACTOR = 0.95;
const DEFAULT_MIN_CHUNK_CHARS = 64;

/**
 * Context windows are declared by the model providers (max input tokens).
 * Budgets are derived from these values at runtime (see computeBudget), so
 * token limits can differ wildly between models without hardcoded assumptions.
 */
const MODEL_REGISTRY: Record<string, ModelSpec> = {
  // OpenAI
  "text-embedding-3-small": { dimensions: 1536, contextTokens: 8191 },
  "text-embedding-3-large": { dimensions: 3072, contextTokens: 8191 },
  "text-embedding-ada-002": { dimensions: 1536, contextTokens: 8191 },
  // Cloudflare Workers AI (openai-compatible endpoint, @cf/... model names)
  "@cf/baai/bge-small-en-v1.5": { dimensions: 384, contextTokens: 512 },
  "@cf/baai/bge-base-en-v1.5": { dimensions: 768, contextTokens: 512 },
  "@cf/baai/bge-large-en-v1.5": { dimensions: 1024, contextTokens: 512 },
  "@cf/baai/bge-m3": { dimensions: 1024, contextTokens: 8192 },
  "@cf/qwen/qwen3-embedding-0.6b": { dimensions: 1024, contextTokens: 32768 },
  "@cf/qwen/qwen3-embedding-8b": { dimensions: 4096, contextTokens: 32768 },
  // NVIDIA Nemotron-3-Embed-1B (e.g. nvidia/nemotron-3-embed-1b:free on
  // OpenRouter; asymmetric — needs input_type "passage" / "query")
  "nemotron-3-embed-1b": {
    dimensions: 2048,
    contextTokens: 32768,
    supportsInputType: true,
    inputTypeDoc: "passage",
    inputTypeQuery: "query",
    notes: "Asymmetric: requires input_type passage/query",
  },
  // Qwen3 embedding family (e.g. via OpenRouter / vLLM / Ollama)
  "qwen3-embedding-0.6b": { dimensions: 1024, contextTokens: 32768 },
  "qwen3-embedding-4b": { dimensions: 2560, contextTokens: 32768 },
  "qwen3-embedding-8b": { dimensions: 4096, contextTokens: 32768 },
};

function envPositive(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Reads a required positive integer env var with NO default. Knobs whose
 * correct value depends on the host (RAM, request packing) must be set
 * explicitly, so a misconfigured deployment fails loudly at boot instead of
 * silently running with a guess. `context` names what enabled the
 * requirement (e.g. "TOOLHUB_EMBEDDING_PROVIDER=local") for the message.
 */
function requireEnvPositive(name: string, context: string): number {
  const value = envPositive(name);
  if (value === undefined) {
    throw new Error(
      `[embedder] ${context} requires ${name} to be set explicitly — there is no default. ` +
      `Add it to .env (e.g. ${name}=32; lower on memory-constrained hosts).`
    );
  }
  return value;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.trim().toLowerCase() !== "false" && raw.trim().toLowerCase() !== "0";
}

export function resolveLocalSpec(): ModelSpec {
  return {
    dimensions: envPositive("TOOLHUB_LOCAL_EMBEDDING_DIMENSIONS") ?? 384,
    maxInputChars: envPositive("TOOLHUB_LOCAL_EMBEDDING_MAX_CHARS") ?? 2048,
  };
}

/**
 * Resolves a remote model's capabilities from the registry. OpenRouter-style
 * names carry a provider prefix and a routing variant (e.g.
 * "openai/text-embedding-3-small", "nvidia/nemotron-3-embed-1b:free"); those
 * are looked up with the prefix and ":variant" stripped.
 *
 * Env overrides:
 * - TOOLHUB_EMBEDDING_DIMENSIONS: vector dimensions
 * - TOOLHUB_EMBEDDING_CONTEXT_TOKENS: model context window in tokens
 * - TOOLHUB_EMBEDDING_MAX_CHARS: explicit character budget
 * If any parameter in env is empty/omitted, it uses the current model config from the registry.
 * If parameter in env is provided, the env value is used.
 */
export function resolveRemoteSpec(model: string): ModelSpec {
  const base = stripVariant(model);
  const known =
    MODEL_REGISTRY[model] ??
    MODEL_REGISTRY[base] ??
    MODEL_REGISTRY[stripProviderPrefix(base)];

  const contextTokens = envPositive("TOOLHUB_EMBEDDING_CONTEXT_TOKENS") ?? known?.contextTokens;
  const dimensions = envPositive("TOOLHUB_EMBEDDING_DIMENSIONS") ?? known?.dimensions ?? 384;
  const specWithEnv: ModelSpec = {
    ...(known ?? {}),
    dimensions,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };

  return {
    ...specWithEnv,
    maxInputChars:
      envPositive("TOOLHUB_EMBEDDING_MAX_CHARS") ??
      computeBudget(specWithEnv),
  };
}

function stripProviderPrefix(model: string): string {
  // "openai/text-embedding-3-small" -> "text-embedding-3-small"
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

function stripVariant(model: string): string {
  // "nvidia/nemotron-3-embed-1b:free" -> "nvidia/nemotron-3-embed-1b"
  const colon = model.lastIndexOf(":");
  return colon === -1 ? model : model.slice(0, colon);
}

/**
 * Effective embedding budget in characters:
 *   explicit env override > registry maxInputChars > computed
 *   computed = contextTokens × charsPerToken × safetyFactor
 * When both a registry maxInputChars and contextTokens exist, the smaller
 * budget wins (conservative by construction).
 */
export function computeBudget(spec: ModelSpec): number {
  const charsPerToken = envPositive("TOOLHUB_EMBEDDING_CHARS_PER_TOKEN") ?? spec.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const safety = envPositive("TOOLHUB_EMBEDDING_BUDGET_SAFETY_FACTOR") ?? DEFAULT_SAFETY_FACTOR;

  let budget: number | undefined;
  if (spec.contextTokens) {
    budget = Math.max(1, Math.floor(spec.contextTokens * charsPerToken * safety));
  }
  if (spec.maxInputChars !== undefined) {
    budget = budget === undefined ? spec.maxInputChars : Math.min(budget, spec.maxInputChars);
  }
  return budget ?? 2048;
}

export class NullEmbedder implements EmbeddingProvider {
  readonly provider = "null";
  readonly model = "none";
  readonly dimensions = 0;
  readonly maxInputChars = 0;

  constructor(private readonly logger: Pick<Console, "info" | "warn" | "error"> = console) {}

  async embedDocument(_text: string): Promise<number[]> {
    return [];
  }

  async embedQuery(_text: string): Promise<number[]> {
    return [];
  }

  async embedMany(texts: string[], _kind?: "document" | "query"): Promise<Array<number[] | null>> {
    return texts.map(() => null);
  }
}

export function embeddingProviderKind(): "null" | "local" | "openai-compatible" {
  const provider = (process.env.TOOLHUB_EMBEDDING_PROVIDER || "null").trim().toLowerCase();
  if (provider === "openai-compatible") return "openai-compatible";
  if (provider === "local") return "local";
  return "null";
}

/** Vector dimensionality of the currently selected provider (no instance needed). */
export function embeddingDimensions(): number {
  const kind = embeddingProviderKind();
  if (kind === "openai-compatible") {
    return resolveRemoteSpec(process.env.TOOLHUB_EMBEDDING_MODEL || DEFAULT_REMOTE_MODEL).dimensions;
  }
  if (kind === "local") {
    return resolveLocalSpec().dimensions;
  }
  return 0;
}

/**
 * Full embedding profile of the currently selected provider, used to build
 * the embedding fingerprint (D5). Pure env/config read — no instance needed,
 * so it can run during server boot and in health checks.
 */
export function embeddingProfile(): {
  provider: string;
  model: string;
  dimensions: number;
  maxInputChars: number;
  charsPerToken: number;
  minChunkChars: number;
  poolingMode: "weighted_mean" | "simple_mean";
} {
  const kind = embeddingProviderKind();
  let model: string;
  let dimensions: number;
  let maxInputChars: number;

  if (kind === "openai-compatible") {
    model = process.env.TOOLHUB_EMBEDDING_MODEL || DEFAULT_REMOTE_MODEL;
    const spec = resolveRemoteSpec(model);
    dimensions = spec.dimensions;
    maxInputChars = spec.maxInputChars ?? computeBudget(spec);
  } else if (kind === "local") {
    model = process.env.TOOLHUB_LOCAL_EMBEDDING_MODEL || DEFAULT_LOCAL_MODEL;
    const spec = resolveLocalSpec();
    dimensions = spec.dimensions;
    maxInputChars = spec.maxInputChars ?? computeBudget(spec);
  } else {
    model = "none";
    dimensions = 0;
    maxInputChars = 0;
  }

  return {
    provider: kind,
    model,
    dimensions,
    maxInputChars,
    charsPerToken: envPositive("TOOLHUB_EMBEDDING_CHARS_PER_TOKEN") ?? DEFAULT_CHARS_PER_TOKEN,
    minChunkChars: envPositive("TOOLHUB_EMBEDDING_MIN_CHUNK_CHARS") ?? DEFAULT_MIN_CHUNK_CHARS,
    poolingMode: poolingMode(),
  };
}

// ---------------------------------------------------------------------------
// Chunking & pooling
// ---------------------------------------------------------------------------

/**
 * Splits text into chunks that fit the given character budget without ever
 * splitting surrogate pairs or grapheme clusters (emoji). Preferred boundary
 * order: paragraph -> line -> sentence -> whitespace -> grapheme-safe hard
 * split. Each chunk targets a size below the budget, never exactly at it.
 */
export function chunkText(text: string, budget: number): string[] {
  if (budget <= 0) return [];
  if (text.length <= budget) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= budget) {
      chunks.push(remaining);
      break;
    }
    const window = remaining.slice(0, budget);
    const boundary = findBoundaryIndex(window);
    const cut = boundary > 0 ? boundary : graphemeSafeHardCut(window, budget);
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

/**
 * Finds the best split point in `window`: the last paragraph/line/sentence/
 * whitespace boundary within the trailing 60% of the window (so chunks stay
 * close to the budget while respecting natural boundaries).
 */
function findBoundaryIndex(window: string): number {
  const floor = Math.floor(window.length * 0.4);
  const candidates = [
    { idx: window.lastIndexOf("\n\n"), off: 2 },
    { idx: window.lastIndexOf("\n"), off: 1 },
    { idx: lastSentenceBoundary(window), off: 0 },
    { idx: window.lastIndexOf(" "), off: 1 },
  ];
  let best = 0;
  for (const cand of candidates) {
    if (cand.idx >= floor && cand.idx + cand.off > best) {
      best = cand.idx + cand.off;
    }
  }
  return best;
}

function lastSentenceBoundary(window: string): number {
  const marks = [".", "!", "?"];
  let best = -1;
  for (const mark of marks) {
    let idx = window.lastIndexOf(mark);
    while (idx !== -1) {
      // require a following space or end-of-window so "1.5" or "example.com" don't split
      const next = window[idx + 1];
      if (next === " " || next === "\n" || next === undefined) {
        if (idx > best) best = idx + 1;
        break;
      }
      idx = window.lastIndexOf(mark, idx - 1);
    }
  }
  return best;
}

/**
 * Hard split that never breaks surrogate pairs or grapheme clusters.
 * Uses Intl.Segmenter (Node >= 16) when available; falls back to code points.
 */
function graphemeSafeHardCut(window: string, budget: number): number {
  if (budget >= window.length) return window.length;

  let boundaryIdx = 0;
  if (typeof Intl !== "undefined" && (Intl as any).Segmenter) {
    const segmenter = new (Intl as any).Segmenter(undefined, { granularity: "grapheme" });
    let offset = 0;
    for (const seg of segmenter.segment(window)) {
      const next = offset + (seg.segment as string).length;
      if (next > budget) break;
      offset = next;
    }
    boundaryIdx = offset;
  } else {
    const codePoints = Array.from(window);
    let length = 0;
    for (const cp of codePoints) {
      const cpLen = cp.length;
      if (length + cpLen > budget) break;
      length += cpLen;
    }
    boundaryIdx = length;
  }
  // Never leave a dangling high surrogate at the cut point.
  if (boundaryIdx > 0 && boundaryIdx < window.length) {
    const unit = window.charCodeAt(boundaryIdx);
    const prev = window.charCodeAt(boundaryIdx - 1);
    if (unit >= 0xdc00 && unit <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) {
      boundaryIdx += 1;
    }
  }
  return Math.min(boundaryIdx, window.length);
}

function l2Normalize(vector: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return vector;
  return vector.map((v) => v / norm);
}

/**
 * Pools chunk vectors into a single vector. Default mode is length-weighted
 * mean (a tiny trailing chunk must not dominate a full chunk), then L2
 * normalization so the pooled vector is comparable to single-vector outputs.
 */
export function poolVectors(
  vectors: number[][],
  weights: number[],
  mode: "weighted_mean" | "simple_mean" = "weighted_mean",
): number[] {
  if (vectors.length === 0) throw new Error("poolVectors requires at least one vector");
  const dims = vectors[0].length;
  const pooled = new Array<number>(dims).fill(0);
  let totalWeight = 0;

  for (let i = 0; i < vectors.length; i++) {
    const w = mode === "weighted_mean" ? Math.max(1, weights[i] ?? 1) : 1;
    totalWeight += w;
    const v = vectors[i];
    for (let d = 0; d < dims; d++) pooled[d] += (v[d] ?? 0) * w;
  }
  if (totalWeight > 0) {
    for (let d = 0; d < dims; d++) pooled[d] /= totalWeight;
  }
  return l2Normalize(pooled);
}

// ---------------------------------------------------------------------------
// Local ONNX provider (opt-in)
// ---------------------------------------------------------------------------

export class Embedder implements EmbeddingProvider {
  readonly provider = "local";
  readonly model: string;
  readonly dimensions: number;
  readonly maxInputChars: number;
  private readonly batchSize: number;
  private readonly maxBatchChars: number;
  private pipelinePromise: any = null;

  constructor(
    private readonly logger: Pick<Console, "info" | "warn" | "error"> = console,
    spec: ModelSpec = resolveLocalSpec(),
  ) {
    this.model = process.env.TOOLHUB_LOCAL_EMBEDDING_MODEL || DEFAULT_LOCAL_MODEL;
    this.dimensions = spec.dimensions;
    this.maxInputChars = spec.maxInputChars ?? computeBudget(spec);
    // The local provider is opt-in and its peak RAM is bounded by the batch
    // size, so the operator must choose it explicitly — no silent default.
    this.batchSize = requireEnvPositive("TOOLHUB_EMBEDDING_BATCH_SIZE", "TOOLHUB_EMBEDDING_PROVIDER=local");
    this.maxBatchChars = envPositive("TOOLHUB_EMBEDDING_MAX_BATCH_CHARS") ?? 100_000;
  }

  private async getPipeline() {
    if (!this.pipelinePromise) {
      const modelName = process.env.TOOLHUB_LOCAL_EMBEDDING_MODEL || DEFAULT_LOCAL_MODEL;
      this.logger.info(`[embedder] Loading ${modelName} ONNX model...`);
      const t0 = performance.now();
      this.pipelinePromise = (async () => {
        // Dynamic import to avoid loading transformers during boot before config check
        const { pipeline, env } = await import("@xenova/transformers");

        // Disable telemetry/analytics and use standard defaults
        env.allowLocalModels = false; // Always fetch from HuggingFace Hub on first run

        // Allow pinning ONNX worker threads (useful for resource-constrained
        // environments where auto-detected thread counts cause oversubscription).
        const onnxThreads = Number(process.env.TOOLHUB_ONNX_THREADS);
        if (Number.isFinite(onnxThreads) && onnxThreads > 0) {
          env.backends.onnx.numThreads = onnxThreads;
        }

        return pipeline("feature-extraction", modelName);
      })();

      this.pipelinePromise.then(
        () => {
          const duration = performance.now() - t0;
          this.logger.info(`[embedder] Model loaded successfully in ${duration.toFixed(0)}ms`);
        },
        (err: any) => {
          this.logger.error("[embedder] Failed to load model:", err);
          this.pipelinePromise = null; // Reset on failure so we can retry
        }
      );
    }
    return this.pipelinePromise;
  }

  /**
   * Embed one document text. Long texts are chunked and pooled so the whole
   * document is represented (no truncation). E5 models require the
   * "passage: " prefix, which is accounted for in the chunk budget.
   */
  async embedDocument(text: string): Promise<number[]> {
    return this.embedOne(text, "document");
  }

  /**
   * Embed a search query. Queries are short user input and are never chunked.
   */
  async embedQuery(text: string): Promise<number[]> {
    return this.embedOne(text, "query");
  }

  async embedMany(texts: string[], kind: "document" | "query" = "document"): Promise<Array<number[] | null>> {
    const prefix = kind === "query" ? "query: " : "passage: ";
    const budget = Math.max(1, this.maxInputChars - prefix.length);

    const results: Array<number[] | null> = new Array(texts.length).fill(null);
    const batches: Array<{ text: string; weight: number; item: number }> = [];
    const perItem: Array<{ vector: number[]; weight: number }[]> = new Array(texts.length).fill(null).map(() => []);

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i] ?? "";
      if (!text) continue;
      const chunks = kind === "query" ? [text] : chunkText(text, budget);
      for (const chunk of chunks) {
        batches.push({ text: `${prefix}${chunk}`, weight: chunk.length, item: i });
      }
    }

    const flat = await this.embedChunks(batches.map((b) => b.text));
    if (flat && flat.length === batches.length) {
      for (let b = 0; b < batches.length; b++) {
        if (flat[b]) perItem[batches[b].item].push({ vector: flat[b], weight: batches[b].weight });
      }
    }

    for (let i = 0; i < texts.length; i++) {
      const parts = perItem[i];
      if (parts.length === 0) continue;
      const mode = poolingMode();
      results[i] = poolVectors(parts.map((p) => p.vector), parts.map((p) => p.weight), mode);
    }
    return results;
  }

  private async embedOne(text: string, kind: "document" | "query"): Promise<number[]> {
    const many = await this.embedMany([text], kind);
    const vector = many[0];
    if (!vector) throw new Error(`[embedder] Failed to embed ${kind} text (${text.length} chars)`);
    return vector;
  }

  /**
   * Runs the ONNX model over a list of texts. The list is packed into
   * bounded batches (by item count AND total characters, honoring
   * TOOLHUB_EMBEDDING_BATCH_SIZE / TOOLHUB_EMBEDDING_MAX_BATCH_CHARS — the
   * same knobs the remote provider uses) and each batch is a separate
   * forward pass, executed sequentially so peak memory stays proportional
   * to a single batch. A single unbounded pass over a real catalog (hundreds
   * of documents, thousands of chunks) would otherwise allocate multi-GB
   * intermediate tensors and OOM-crash the process.
   *
   * Returns an array of vectors aligned with the input list, or null when
   * the batch shape is unexpected.
   */
  private async embedChunks(texts: string[]): Promise<number[][] | null> {
    const extractor = await this.getPipeline();
    if (texts.length === 0) return [];

    // Batch size was validated at construction (required, no default) — it
    // bounds peak RAM, so the operator picks it explicitly. Batches are
    // count- AND char-bounded here: a single unbounded forward pass over a
    // real catalog (hundreds of docs, thousands of chunks) previously
    // allocated a multi-GB tensor and crashed.
    const batchSize = this.batchSize;
    const maxBatchChars = this.maxBatchChars;
    const dims = this.dimensions;
    const vectors: number[][] = [];

    for (const batch of buildBatches(texts.map((text) => ({ text })), batchSize, maxBatchChars)) {
      const output = await extractor(batch.map((b) => b.text), { pooling: "mean", normalize: true });
      const data = output.data as Float32Array;
      if (data.length !== batch.length * dims) return null;
      for (let i = 0; i < batch.length; i++) {
        vectors.push(Array.from(data.subarray(i * dims, (i + 1) * dims)));
      }
    }
    return vectors;
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible remote provider
// ---------------------------------------------------------------------------

export interface OpenAICompatibleEmbedderOptions {
  /** Base URL of an OpenAI-compatible API, e.g. https://api.openai.com/v1. */
  baseUrl: string;
  /** Bearer API key (OpenAI / OpenRouter / Cloudflare API token / ...). */
  apiKey: string;
  /** Model name, e.g. text-embedding-3-small or @cf/baai/bge-small-en-v1.5. */
  model?: string;
  /**
   * Optional `input_type` sent for document embeddings (e.g. "search_document"
   * on OpenRouter / Workers AI). Omit for symmetric models like OpenAI's.
   */
  inputTypeDoc?: string;
  /**
   * Optional `input_type` sent for query embeddings (e.g. "search_query").
   * Omit for symmetric models like OpenAI's.
   */
  inputTypeQuery?: string;
  retryDelayMs?: number;
  /** Override vector dimensionality (defaults to the model registry). */
  dimensions?: number;
  /** Override max input length in chars (defaults to the model registry). */
  maxInputChars?: number;
  /** Maximum number of texts per API request (default 32). */
  batchSize?: number;
  /** Maximum total characters per API request (default 100000). */
  maxBatchChars?: number;
  /** Maximum retry attempts per request (default 3). */
  retries?: number;
  /** How many batches may run concurrently (default 4). */
  concurrency?: number;
  /** Minimum chunk size in chars when shrinking on context errors (default 64). */
  minChunkChars?: number;
  /** Per-request timeout in ms (default 60000) — a hung upstream must never hang a search forever. */
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Matches API error messages describing context/token/length overflow. */
const CONTEXT_ERROR_RE = /context|token|too long|input.*length|maximum.*(length|input|size|tokens)/i;

/** Errors that affect the whole request, not a single input — fail fast. */
const FATAL_ERROR_RE = /unauthorized|authentication|invalid api key|forbidden|model.*(not found|does not exist|unknown)/i;

class EmbeddingContextError extends Error {}
class EmbeddingItemError extends Error {}

/**
 * Config-level failure (bad credentials, unknown model, forbidden). Affects
 * every request — never degrade to "no vector" on these; fail fast.
 */
class FatalEmbeddingError extends Error {}

function poolingMode(): "weighted_mean" | "simple_mean" {
  const raw = (process.env.TOOLHUB_EMBEDDING_POOLING_MODE || "weighted_mean").trim().toLowerCase();
  return raw === "simple_mean" ? "simple_mean" : "weighted_mean";
}

export class OpenAICompatibleEmbedder implements EmbeddingProvider {
  readonly provider = "openai-compatible";
  readonly dimensions: number;
  readonly maxInputChars: number;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly inputTypeDoc?: string;
  private readonly inputTypeQuery?: string;
  private readonly retryDelayMs: number;
  private readonly batchSize: number;
  private readonly maxBatchChars: number;
  private readonly retries: number;
  private readonly concurrency: number;
  private readonly minChunkChars: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    options: OpenAICompatibleEmbedderOptions,
    private readonly logger: Pick<Console, "info" | "warn" | "error"> = console,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model || DEFAULT_REMOTE_MODEL;
    this.inputTypeDoc = options.inputTypeDoc;
    this.inputTypeQuery = options.inputTypeQuery;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    // Qwen3-8B is heavy (4096 dims): fewer parallel requests keep memory sane
    const eightBModel = /8b/i.test(this.model);
    // Batch size is required when embeddings are enabled — deliberately no
    // default (a silent default is how the local/remote mismatch confused
    // operators, and the right value depends on host RAM). options.batchSize
    // is the programmatic path; otherwise it must come from env.
    this.batchSize = options.batchSize ?? requireEnvPositive("TOOLHUB_EMBEDDING_BATCH_SIZE", "TOOLHUB_EMBEDDING_PROVIDER=openai-compatible");
    this.maxBatchChars = options.maxBatchChars ?? envPositive("TOOLHUB_EMBEDDING_MAX_BATCH_CHARS") ?? 100_000;
    this.retries = options.retries ?? envPositive("TOOLHUB_EMBEDDING_RETRIES") ?? 3;
    this.concurrency = options.concurrency ?? (eightBModel ? 2 : envPositive("TOOLHUB_EMBEDDING_CONCURRENCY") ?? 4);
    this.minChunkChars = options.minChunkChars ?? envPositive("TOOLHUB_EMBEDDING_MIN_CHUNK_CHARS") ?? DEFAULT_MIN_CHUNK_CHARS;
    this.timeoutMs = options.timeoutMs ?? envPositive("TOOLHUB_EMBEDDING_TIMEOUT_MS") ?? 60_000;
    this.fetchImpl = fetchImpl;

    const spec = resolveRemoteSpec(this.model);
    this.dimensions = options.dimensions ?? spec.dimensions;
    this.maxInputChars = options.maxInputChars ?? spec.maxInputChars ?? computeBudget(spec);

    this.logger.info(
      `[embedder] Using OpenAI-compatible embeddings (endpoint ${this.baseUrl}/embeddings, ` +
      `model ${this.model}, ${this.dimensions} dims, budget ${this.maxInputChars} chars, ` +
      `batch ${this.batchSize}, retries ${this.retries})`
    );
  }

  async embedDocument(text: string): Promise<number[]> {
    const many = await this.embedMany([text], "document");
    const vector = many[0];
    if (!vector) throw this.lastFailureFor(0) ?? new Error(`[embedder] Failed to embed document (${text.length} chars)`);
    return vector;
  }

  async embedQuery(text: string): Promise<number[]> {
    const many = await this.embedMany([text], "query");
    const vector = many[0];
    if (!vector) throw this.lastFailureFor(0) ?? new Error(`[embedder] Failed to embed query (${text.length} chars)`);
    return vector;
  }

  /** Most recent per-item failure recorded by embedMany (for rich errors). */
  private lastEmbedErrors = new Map<number, Error>();

  private lastFailureFor(item: number): Error | null {
    const err = this.lastEmbedErrors.get(item);
    this.lastEmbedErrors.delete(item);
    return err ?? null;
  }

  /**
   * Embed many texts. Each text is chunked (documents only) to fit the model
   * budget, chunks are packed into bounded batches (by count AND total chars),
   * batches run with limited concurrency, and the retry ladder handles:
   *   - 429: Retry-After header or exponential backoff + jitter
   *   - 5xx / network: exponential backoff + jitter
   *   - other 4xx: binary-split the batch to isolate the bad input
   *   - context/token overflow: binary-split, then shrink the offending text's
   *     chunk budget and re-chunk
   * A text that still fails after all of that yields `null` (callers index it
   * lexically without a vector) — one bad input never kills the batch.
   */
  async embedMany(texts: string[], kind: "document" | "query" = "document"): Promise<Array<number[] | null>> {
    const inputType = kind === "query" ? this.inputTypeQuery : this.inputTypeDoc;
    const results: Array<number[] | null> = new Array(texts.length).fill(null);

    // Work items: one entry per chunk, grouped per original text index.
    type WorkItem = { item: number; text: string; weight: number };
    const pending = new Set<number>();
    const chunked = new Map<number, WorkItem[]>();
    const pieces = new Map<number, Array<{ vector: number[]; weight: number }>>();

    const chunkFor = (item: number, budget: number): WorkItem[] => {
      const text = texts[item] ?? "";
      if (!text) return [];
      const chunks = kind === "query" ? [text] : chunkText(text, budget);
      return chunks.map((c) => ({ item, text: c, weight: c.length }));
    };

    let budget = this.maxInputChars;
    for (let i = 0; i < texts.length; i++) {
      if (!(texts[i] ?? "")) continue;
      pending.add(i);
      chunked.set(i, chunkFor(i, budget));
    }

    let guard = 0;
    while (pending.size > 0 && guard < 16) {
      guard++;
      // Flatten all pending chunks into bounded batches
      const flat: WorkItem[] = [];
      for (const item of pending) flat.push(...(chunked.get(item) ?? []));

      const batches = buildBatches(flat, this.batchSize, this.maxBatchChars);

      // Run batches with limited concurrency, collecting failures per item.
      // Chunks that succeed are recorded as pooled pieces and removed from the
      // item's pending chunk list; an item is done when all its chunks are in.
      const failedContextItems = new Set<number>();
      const failedItems = new Set<number>();

      const runBatch = async (batch: WorkItem[]): Promise<void> => {
        try {
          const vectors = await this.requestBatch(
            batch.map((w) => w.text),
            inputType
          );
          for (let i = 0; i < batch.length; i++) {
            const w = batch[i];
            if (!vectors[i]) continue;
            const itemPieces = pieces.get(w.item) ?? [];
            itemPieces.push({ vector: vectors[i] as number[], weight: w.weight });
            pieces.set(w.item, itemPieces);

            const prev = chunked.get(w.item) ?? [];
            const idx = prev.findIndex((x) => x.text === w.text);
            if (idx !== -1) prev.splice(idx, 1);
            if (prev.length === 0) pending.delete(w.item);
          }
        } catch (err) {
          // The whole batch failed; items in it are retried (context) or
          // abandoned (other errors). Any partially accumulated pieces for
          // these items are dropped so we never pool a partial vector.
          for (const w of batch) pieces.delete(w.item);
          if (err instanceof FatalEmbeddingError) {
            // Config-level failure (auth/unknown model): abort everything
            throw err;
          }
          if (err instanceof EmbeddingContextError) {
            for (const w of batch) {
              failedContextItems.add(w.item);
              this.lastEmbedErrors.set(w.item, err);
            }
          } else {
            for (const w of batch) {
              failedItems.add(w.item);
              this.lastEmbedErrors.set(w.item, err instanceof Error ? err : new Error(String(err)));
            }
          }
        }
      };

      await mapWithConcurrency(batches, runBatch, this.concurrency);

      for (const item of failedItems) {
        pending.delete(item);
        this.logger.warn(`[embedder] Embedding failed for item ${item} after retries — indexing without vector`);
      }
      if (failedContextItems.size > 0) {
        const nextBudget = Math.max(this.minChunkChars, Math.floor(budget / 2));
        if (nextBudget >= budget) {
          // Cannot shrink further — give up on these items
          for (const item of failedContextItems) {
            pending.delete(item);
            this.logger.warn(`[embedder] Context overflow persists at minimum chunk size for item ${item} — indexing without vector`);
          }
        } else {
          budget = nextBudget;
          this.logger.warn(
            `[embedder] Context overflow on ${failedContextItems.size} item(s) — shrinking chunk budget to ${budget} chars and retrying`
          );
          for (const item of failedContextItems) {
            chunked.set(item, chunkFor(item, budget));
            pending.add(item);
          }
        }
      }
    }

    for (let i = 0; i < texts.length; i++) {
      const itemPieces = pieces.get(i);
      if (itemPieces && itemPieces.length > 0) {
        results[i] = poolVectors(itemPieces.map((p) => p.vector), itemPieces.map((p) => p.weight), poolingMode());
      }
    }
    return results;
  }

  /**
   * POST a batch of texts to the OpenAI-compatible embeddings endpoint with
   * the retry ladder. Returns vectors aligned with the input texts.
   * Throws EmbeddingContextError when a single input exceeds the context
   * budget (after binary isolation), EmbeddingItemError for other unrecoverable
   * per-item failures.
   */
  private async requestBatch(texts: string[], inputType?: string): Promise<number[][]> {
    const body: Record<string, unknown> = { model: this.model, input: texts };
    if (inputType) body.input_type = inputType;

    let attempt = 0;
    while (true) {
      try {
        // Plain setTimeout (not AbortSignal.timeout — its internal timer is
        // unref'd in Node, so a process with nothing else pending can drain
        // the event loop before the timeout ever fires); cleared in finally.
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new DOMException("Embedding request timed out", "TimeoutError")),
          this.timeoutMs,
        );
        let response: Response;
        let bodyText: string;
        try {
          response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          // fetch resolves once headers arrive — the body must be read inside
          // the same timeout window, or a server that sends headers and then
          // stalls the response body hangs the request forever.
          bodyText = await response.text();
        } catch (err) {
          // The only abort source is our timeout timer — any abort therefore
          // means the request timed out (the fetch rejects with either the
          // AbortError or the reason we passed). Convert it to a plain error
          // so the retry ladder treats it like any other network failure
          // (bounded retries, then lexical fallback).
          if (controller.signal.aborted) {
            throw new Error(`Embedding request timed out after ${this.timeoutMs}ms`);
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }

        if (response.status === 429) {
          // Rate-limit retries are capped like every other retry — a
          // persistently throttled (or quota-exhausted) upstream must
          // degrade to lexical search, not retry forever.
          const retryAfter = Number(response.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoffMs(attempt);
          this.logger.warn(
            `\x1b[33;1m[embedder:429 RATE-LIMIT]\x1b[0m ${this.baseUrl}/embeddings throttled (attempt ${attempt + 1}/${this.retries}). Waiting ${(delay / 1000).toFixed(1)}s before retry...`
          );
          await sleep(delay);
          attempt++;
          if (attempt >= this.retries) {
            throw new EmbeddingItemError(
              `OpenAI-compatible embeddings API rate-limited after ${attempt} attempts (HTTP 429)`
            );
          }
          continue;
        }

        if (response.status >= 500) {
          const delay = this.backoffMs(attempt);
          const message = extractErrorMessage(bodyText);
          this.logger.warn(
            `\x1b[38;5;208;1m[embedder:5xx SERVER-ERROR]\x1b[0m HTTP ${response.status} from ${this.baseUrl}/embeddings (attempt ${attempt + 1}/${this.retries}): ${message}. Retrying in ${(delay / 1000).toFixed(1)}s...`
          );
          await sleep(delay);
          attempt++;
          if (attempt >= this.retries) {
            throw new EmbeddingItemError(`OpenAI-compatible embeddings API returned HTTP ${response.status}: ${message}`);
          }
          continue;
        }

        if (!response.ok) {
          const message = extractErrorMessage(bodyText);
          this.logger.error(
            `\x1b[38;5;196;1m[embedder:API-ERROR]\x1b[0m HTTP ${response.status} from ${this.baseUrl}/embeddings: ${message}`
          );
          if (CONTEXT_ERROR_RE.test(message)) {
            // One or more inputs exceed the context budget. Binary-split to
            // isolate the offending input(s); a single remaining input that
            // still overflows surfaces as EmbeddingContextError.
            if (texts.length > 1) {
              const mid = Math.ceil(texts.length / 2);
              const left = await this.requestBatch(texts.slice(0, mid), inputType);
              const right = await this.requestBatch(texts.slice(mid), inputType);
              return [...left, ...right];
            }
            throw new EmbeddingContextError(`Context overflow for input (${texts[0]?.length ?? 0} chars): ${message}`);
          }
          if (FATAL_ERROR_RE.test(message) || response.status === 401 || response.status === 403) {
            throw new FatalEmbeddingError(`OpenAI-compatible embeddings error ${response.status}: ${message}`);
          }
          // Generic 4xx — binary-split to isolate the bad input
          if (texts.length > 1) {
            const mid = Math.ceil(texts.length / 2);
            const left = await this.requestBatch(texts.slice(0, mid), inputType);
            const right = await this.requestBatch(texts.slice(mid), inputType);
            return [...left, ...right];
          }
          throw new EmbeddingItemError(`OpenAI-compatible embeddings error ${response.status}: ${message}`);
        }

        let payload: any;
        try {
          payload = JSON.parse(bodyText);
        } catch {
          throw new EmbeddingItemError("Unexpected OpenAI-compatible embeddings response shape");
        }
        const vectors = extractVectors(payload);
        if (vectors && vectors.length === texts.length) return vectors;
        throw new EmbeddingItemError("Unexpected OpenAI-compatible embeddings response shape");
      } catch (err) {
        if (err instanceof EmbeddingContextError) throw err;
        if (err instanceof EmbeddingItemError) throw err;
        if (err instanceof FatalEmbeddingError) throw err;
        // Network/parse error (or request timeout — AbortSignal.timeout rejects
        // with a DOMException whose name is "TimeoutError") — retry with backoff
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `\x1b[38;5;196;1m[embedder:NET-ERROR]\x1b[0m Connection to ${this.baseUrl}/embeddings failed (attempt ${attempt + 1}/${this.retries}): ${errMsg}`
        );
        attempt++;
        if (attempt >= this.retries) {
          throw new EmbeddingItemError(`Embeddings request failed after ${attempt} attempts: ${errMsg}`);
        }
        await sleep(this.backoffMs(attempt));
      }
    }
  }

  private backoffMs(attempt: number): number {
    const base = this.retryDelayMs * Math.pow(2, Math.min(attempt, 6));
    return base * (0.5 + Math.random() * 0.5);
  }
}

/** Groups work items into batches bounded by count AND total characters. */
function buildBatches<T extends { text: string }>(
  items: T[],
  batchSize: number,
  maxBatchChars: number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = item.text.length;
    if (current.length > 0 && (current.length >= batchSize || currentChars + itemChars > maxBatchChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function mapWithConcurrency<T>(items: T[], fn: (item: T) => Promise<void>, concurrency: number): Promise<void> {
  const workers = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => run()));
}

/** Reads an OpenAI-style `error.message` from a response body, or a fallback. */
function extractErrorMessage(text: string): string {
  try {
    const payload = JSON.parse(text) as any;
    if (typeof payload?.error?.message === "string") return payload.error.message;
  } catch {
    // Non-JSON error body — fall through to raw text.
  }
  return text.slice(0, 500) || "unknown error";
}

/**
 * Extracts vectors from an OpenAI-compatible embeddings response:
 *   - standard: data = [ { object, index, embedding: [ ...floats ] } ]
 *   - tolerant: data[0].data (nested shape seen in some legacy gateways)
 * Vectors are returned in input order (sorted by `index` when present).
 */
function extractVectors(payload: any): number[][] | null {
  const data = payload?.data;
  if (!Array.isArray(data) || data.length === 0) return null;

  if (Array.isArray(data[0]?.embedding)) {
    const sorted = [...data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
    const vectors = sorted.map((entry) => entry.embedding);
    return vectors.every((v) => Array.isArray(v)) ? (vectors as number[][]) : null;
  }
  if (Array.isArray(data[0]?.data)) {
    // Legacy nested shape: data = [ { data: [0.7, 0.8] } ] carries a single
    // vector under `data` instead of `embedding` — wrap it as one entry.
    // Some gateways instead nest a full list: data = [ { data: [[..],[..]] } ].
    const nested = data[0].data as unknown[];
    if (Array.isArray(nested[0])) return nested as number[][];
    return [nested as number[]];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the embedding provider selected by TOOLHUB_EMBEDDING_PROVIDER.
 * Defaults to the NullEmbedder (disabled, zero memory, pure lexical search).
 * Supports "openai-compatible" (e.g. OpenRouter, Cloudflare, OpenAI) and
 * "local" (Transformers.js ONNX, only when explicitly requested).
 */
export function createEmbedder(
  logger: Pick<Console, "info" | "warn" | "error"> = console,
  fetchImpl: typeof fetch = globalThis.fetch,
): EmbeddingProvider {
  const provider = (process.env.TOOLHUB_EMBEDDING_PROVIDER || "null").trim().toLowerCase();

  switch (provider) {
    case "":
    case "none":
    case "disabled":
    case "null":
      return new NullEmbedder(logger);
    case "local":
      return new Embedder(logger, resolveLocalSpec());
    case "openai-compatible": {
      const baseUrl = process.env.TOOLHUB_EMBEDDING_BASE_URL;
      const apiKey = process.env.TOOLHUB_EMBEDDING_API_KEY;
      if (!baseUrl || !apiKey) {
        throw new Error(
          "[embedder] TOOLHUB_EMBEDDING_PROVIDER=openai-compatible requires " +
          "TOOLHUB_EMBEDDING_BASE_URL and TOOLHUB_EMBEDDING_API_KEY"
        );
      }
      return new OpenAICompatibleEmbedder(
        {
          baseUrl,
          apiKey,
          model: process.env.TOOLHUB_EMBEDDING_MODEL || DEFAULT_REMOTE_MODEL,
          inputTypeDoc: process.env.TOOLHUB_EMBEDDING_INPUT_TYPE_DOC || undefined,
          inputTypeQuery: process.env.TOOLHUB_EMBEDDING_INPUT_TYPE_QUERY || undefined,
        },
        logger,
        fetchImpl,
      );
    }
    default:
      throw new Error(
        `[embedder] Unknown TOOLHUB_EMBEDDING_PROVIDER: "${provider}" ` +
        '(expected "null", "local", or "openai-compatible")'
      );
  }
}

export { envBoolean };
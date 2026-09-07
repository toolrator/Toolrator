import { test, describe, afterEach } from "node:test";
import assert from "node:assert";
import {
  OpenAICompatibleEmbedder,
  createEmbedder,
  Embedder,
  NullEmbedder,
  embeddingDimensions,
  resolveRemoteSpec,
} from "../src/embedder.js";
import type { EmbeddingProvider } from "../src/embedder.js";

const quietLogger = { info() {}, warn() {}, error() {} } as any;

/** Returns a fetch stub that delegates to the provided handler. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return (async (url: string | URL, init?: RequestInit) =>
    handler(String(url), init ?? {})) as unknown as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

/** OpenAI-style embeddings payload for one text. */
function embeddingsResponse(vector: number[]): Record<string, unknown> {
  return {
    object: "list",
    data: [{ object: "embedding", index: 0, embedding: vector }],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 8, total_tokens: 8 },
  };
}

const baseOptions = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "text-embedding-3-small",
  batchSize: 32,
  retryDelayMs: 5,
};

/** Vectors are L2-normalized before they reach the search backend (cosine). */
function assertVectorClose(actual: number[], expected: number[], eps = 1e-9): void {
  assert.strictEqual(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < eps, `dim ${i}: ${actual[i]} !== ${expected[i]}`);
  }
}

describe("OpenAICompatibleEmbedder", () => {
  test("embeds a single text with correct URL, auth header and payload", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchStub = stubFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(embeddingsResponse([0.1, 0.2]));
    });

    const embedder = new OpenAICompatibleEmbedder(baseOptions, quietLogger, fetchStub);
    const vector = await embedder.embedDocument("hello world");

    assertVectorClose(vector, [0.4472135954999579, 0.8944271909999159]);
    assert.strictEqual(capturedUrl, "https://api.openai.com/v1/embeddings");
    assert.strictEqual(capturedInit!.headers["Authorization"], "Bearer sk-test");
    assert.strictEqual(capturedInit!.headers["Content-Type"], "application/json");
    assert.deepStrictEqual(JSON.parse(String(capturedInit!.body)), {
      model: "text-embedding-3-small",
      input: ["hello world"],
    });
  });

  test("appends /embeddings to base URLs with and without a trailing slash", async () => {
    let urls: string[] = [];
    const fetchStub = stubFetch((url) => {
      urls.push(url);
      return jsonResponse(embeddingsResponse([0.1]));
    });

    await new OpenAICompatibleEmbedder(
      { ...baseOptions, baseUrl: "https://api.openai.com/v1/" },
      quietLogger,
      fetchStub,
    ).embedDocument("a");
    await new OpenAICompatibleEmbedder(
      { ...baseOptions, baseUrl: "https://openrouter.ai/api/v1" },
      quietLogger,
      fetchStub,
    ).embedDocument("b");

    assert.deepStrictEqual(urls, [
      "https://api.openai.com/v1/embeddings",
      "https://openrouter.ai/api/v1/embeddings",
    ]);
  });

  test("does not send input_type unless configured", async () => {
    let body = "";
    const fetchStub = stubFetch((_url, init) => {
      body = String(init.body);
      return jsonResponse(embeddingsResponse([0.5]));
    });

    const embedder = new OpenAICompatibleEmbedder(baseOptions, quietLogger, fetchStub);
    await embedder.embedDocument("github");
    await embedder.embedQuery("github");

    assert.deepStrictEqual(JSON.parse(body), { model: "text-embedding-3-small", input: ["github"] });
  });

  test("sends input_type per role when configured", async () => {
    const bodies: string[] = [];
    const fetchStub = stubFetch((_url, init) => {
      bodies.push(String(init.body));
      return jsonResponse(embeddingsResponse([0.5]));
    });

    const embedder = new OpenAICompatibleEmbedder(
      {
        ...baseOptions,
        inputTypeDoc: "search_document",
        inputTypeQuery: "search_query",
      },
      quietLogger,
      fetchStub,
    );
    await embedder.embedDocument("a doc");
    await embedder.embedQuery("a query");

    assert.deepStrictEqual(bodies.map((b) => JSON.parse(b)), [
      { model: "text-embedding-3-small", input: ["a doc"], input_type: "search_document" },
      { model: "text-embedding-3-small", input: ["a query"], input_type: "search_query" },
    ]);
  });

  test("tolerates the nested data[0].data response shape", async () => {
    const fetchStub = stubFetch(() =>
      jsonResponse({
        object: "list",
        data: [{ object: "embedding", index: 0, data: [0.7, 0.8] }],
      }),
    );

    const embedder = new OpenAICompatibleEmbedder(baseOptions, quietLogger, fetchStub);
    const vector = await embedder.embedDocument("solo");

    const norm = Math.hypot(0.7, 0.8);
    assertVectorClose(vector, [0.7 / norm, 0.8 / norm]);
  });

  test("throws with the API error message on HTTP failure", async () => {
    const fetchStub = stubFetch(() =>
      jsonResponse({ error: { message: "Model not found" } }, 404),
    );

    const embedder = new OpenAICompatibleEmbedder(baseOptions, quietLogger, fetchStub);
    await assert.rejects(
      () => embedder.embedDocument("boom"),
      /Model not found/,
    );
  });

  test("falls back to raw body text when the error has no JSON message", async () => {
    const fetchStub = stubFetch(() =>
      new Response("gibberish gateway error", { status: 502 }),
    );

    const embedder = new OpenAICompatibleEmbedder(baseOptions, quietLogger, fetchStub);
    await assert.rejects(
      () => embedder.embedDocument("boom"),
      /gibberish gateway error/,
    );
  });

  test("retries once on 429 and succeeds on the second attempt", async () => {
    let calls = 0;
    const fetchStub = stubFetch(() => {
      calls++;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return jsonResponse(embeddingsResponse([1.0]));
    });

    const embedder = new OpenAICompatibleEmbedder(baseOptions, quietLogger, fetchStub);
    const vector = await embedder.embedDocument("retry-me");

    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(vector, [1.0]);
  });

  test("rejects when the response has an unexpected shape", async () => {
    const fetchStub = stubFetch(() =>
      jsonResponse({ object: "list", data: [{ embedding: "base64..." }] }),
    );

    const embedder = new OpenAICompatibleEmbedder(baseOptions, quietLogger, fetchStub);
    await assert.rejects(() => embedder.embedDocument("x"), /Unexpected/);
  });

  test("times out a hung upstream and gives up after retries", async () => {
    // A fetch stub that never answers — only rejects when the caller's
    // AbortSignal fires. Without the timeout this would hang forever.
    const fetchStub = stubFetch((_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "TimeoutError")),
          { once: true },
        );
      });
    });

    const embedder = new OpenAICompatibleEmbedder(
      { ...baseOptions, retries: 1, timeoutMs: 50, retryDelayMs: 5 },
      quietLogger,
      fetchStub,
    );
    await assert.rejects(() => embedder.embedDocument("hello"), /failed after 1 attempts/);
  });

  test("caps 429 retries instead of retrying forever", async () => {
    const fetchStub = stubFetch(() => new Response("rate limited", { status: 429 }));
    const embedder = new OpenAICompatibleEmbedder(
      { ...baseOptions, retries: 2, retryDelayMs: 5 },
      quietLogger,
      fetchStub,
    );
    await assert.rejects(
      () => embedder.embedDocument("hello"),
      /rate-limited after 2 attempts/,
    );
  });
});

describe("provider capabilities", () => {
  test("local embedder declares 384 dims and 2048 chars", () => {
    // Batch size is required (no default) — set it explicitly for this test.
    const prev = process.env.TOOLHUB_EMBEDDING_BATCH_SIZE;
    process.env.TOOLHUB_EMBEDDING_BATCH_SIZE = "32";
    try {
      const embedder = new Embedder(quietLogger);
      assert.strictEqual(embedder.dimensions, 384);
      assert.strictEqual(embedder.maxInputChars, 2048);
    } finally {
      if (prev === undefined) delete process.env.TOOLHUB_EMBEDDING_BATCH_SIZE;
      else process.env.TOOLHUB_EMBEDDING_BATCH_SIZE = prev;
    }
  });

  test("registry maps known models to dims and context", () => {
    assert.deepStrictEqual(resolveRemoteSpec("text-embedding-3-small"), { dimensions: 1536, contextTokens: 8191, maxInputChars: 27235 });
    assert.deepStrictEqual(resolveRemoteSpec("text-embedding-3-large"), { dimensions: 3072, contextTokens: 8191, maxInputChars: 27235 });
    assert.deepStrictEqual(resolveRemoteSpec("text-embedding-ada-002"), { dimensions: 1536, contextTokens: 8191, maxInputChars: 27235 });
    assert.deepStrictEqual(resolveRemoteSpec("@cf/baai/bge-small-en-v1.5"), { dimensions: 384, contextTokens: 512, maxInputChars: 1702 });
    assert.deepStrictEqual(resolveRemoteSpec("@cf/baai/bge-base-en-v1.5"), { dimensions: 768, contextTokens: 512, maxInputChars: 1702 });
    assert.deepStrictEqual(resolveRemoteSpec("@cf/baai/bge-large-en-v1.5"), { dimensions: 1024, contextTokens: 512, maxInputChars: 1702 });
    assert.deepStrictEqual(resolveRemoteSpec("@cf/baai/bge-m3"), { dimensions: 1024, contextTokens: 8192, maxInputChars: 27238 });
    assert.deepStrictEqual(resolveRemoteSpec("@cf/qwen/qwen3-embedding-0.6b"), { dimensions: 1024, contextTokens: 32768, maxInputChars: 108953 });
    assert.deepStrictEqual(resolveRemoteSpec("nemotron-3-embed-1b"), { dimensions: 2048, contextTokens: 32768, maxInputChars: 108953, supportsInputType: true, inputTypeDoc: "passage", inputTypeQuery: "query", notes: "Asymmetric: requires input_type passage/query" });
  });

  test("OpenRouter-style provider prefixes and :variants resolve to the underlying model", () => {
    assert.deepStrictEqual(resolveRemoteSpec("openai/text-embedding-3-small"), { dimensions: 1536, contextTokens: 8191, maxInputChars: 27235 });
    assert.deepStrictEqual(resolveRemoteSpec("cloudflare/@cf/baai/bge-m3"), { dimensions: 1024, contextTokens: 8192, maxInputChars: 27238 });
    assert.deepStrictEqual(resolveRemoteSpec("nvidia/nemotron-3-embed-1b:free"), { dimensions: 2048, contextTokens: 32768, maxInputChars: 108953, supportsInputType: true, inputTypeDoc: "passage", inputTypeQuery: "query", notes: "Asymmetric: requires input_type passage/query" });
  });

  test("unknown model falls back to conservative defaults", () => {
    assert.deepStrictEqual(resolveRemoteSpec("some-vendor/unknown-embed-9b"), { dimensions: 384, maxInputChars: 2048 });
  });

  test("embedder exposes the resolved model spec", () => {
    const embedder = new OpenAICompatibleEmbedder(
      { ...baseOptions, model: "text-embedding-3-large" },
      quietLogger,
      stubFetch(() => jsonResponse(embeddingsResponse([0.1]))),
    );
    assert.strictEqual(embedder.dimensions, 3072);
    assert.strictEqual(embedder.maxInputChars, 27235);
  });

  test("env overrides win over the registry", () => {
    process.env.TOOLHUB_EMBEDDING_PROVIDER = "openai-compatible";
    process.env.TOOLHUB_EMBEDDING_DIMENSIONS = "1024";
    process.env.TOOLHUB_EMBEDDING_MAX_CHARS = "500";
    try {
      assert.deepStrictEqual(resolveRemoteSpec("text-embedding-3-small"), { dimensions: 1024, contextTokens: 8191, maxInputChars: 500 });
      assert.strictEqual(embeddingDimensions(), 1024);
    } finally {
      delete process.env.TOOLHUB_EMBEDDING_PROVIDER;
      delete process.env.TOOLHUB_EMBEDDING_DIMENSIONS;
      delete process.env.TOOLHUB_EMBEDDING_MAX_CHARS;
    }
  });

  test("embeddingDimensions follows the selected provider", () => {
    process.env.TOOLHUB_EMBEDDING_PROVIDER = "openai-compatible";
    process.env.TOOLHUB_EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";
    try {
      assert.strictEqual(embeddingDimensions(), 1024);
    } finally {
      delete process.env.TOOLHUB_EMBEDDING_PROVIDER;
      delete process.env.TOOLHUB_EMBEDDING_MODEL;
    }
  });
});

describe("local embedder batching", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TOOLHUB_") && !(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  test("embedMany runs count-bounded ONNX forward passes and pools results", async () => {
    // Small spec so a single text produces multiple chunks, and a tiny batch
    // size so the number of forward passes is observable. Batch size is
    // required (no default), so set it before constructing.
    process.env.TOOLHUB_EMBEDDING_BATCH_SIZE = "3";
    process.env.TOOLHUB_EMBEDDING_MAX_BATCH_CHARS = "10000";
    const embedder = new Embedder(quietLogger, { dimensions: 4, maxInputChars: 64 });

    const batchSizes: number[] = [];
    (embedder as any).getPipeline = async () =>
      async (texts: string[], _opts: unknown) => {
        batchSizes.push(texts.length);
        const data = new Float32Array(texts.length * 4);
        // Unit vector along dim 0 for every input (pooling stays well-defined)
        for (let i = 0; i < texts.length; i++) data[i * 4] = 1;
        return { data };
      };

    const texts = Array.from({ length: 10 }, (_, i) => `text ${i} `.repeat(10));
    const vectors = await embedder.embedMany(texts, "document");

    assert.strictEqual(vectors.length, 10, "one pooled vector per input text");
    for (const v of vectors) {
      assert.ok(v && v.length === 4);
    }
    // 10 texts ~2 chunks each = ~20 chunks; with batchSize 3 that means >= 7
    // forward passes, none exceeding the batch cap.
    assert.ok(batchSizes.length >= 7, `expected >=7 forward passes, got ${batchSizes.length}`);
    for (const size of batchSizes) {
      assert.ok(size <= 3, `forward pass exceeded batch cap: ${size}`);
    }
  });
});

describe("createEmbedder factory", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TOOLHUB_") && !(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  test("defaults to the null provider", () => {
    delete process.env.TOOLHUB_EMBEDDING_PROVIDER;
    const provider = createEmbedder(quietLogger);
    assert.ok(provider instanceof NullEmbedder);
    assert.strictEqual(provider.dimensions, 0);
  });

  test("selects the local provider when explicitly configured", () => {
    process.env.TOOLHUB_EMBEDDING_PROVIDER = "local";
    process.env.TOOLHUB_EMBEDDING_BATCH_SIZE = "32";
    const provider = createEmbedder(quietLogger);
    assert.ok(provider instanceof Embedder);
  });

  test("selects the remote provider when configured", () => {
    process.env.TOOLHUB_EMBEDDING_PROVIDER = "openai-compatible";
    process.env.TOOLHUB_EMBEDDING_BASE_URL = "https://api.openai.com/v1";
    process.env.TOOLHUB_EMBEDDING_API_KEY = "sk-test";
    process.env.TOOLHUB_EMBEDDING_BATCH_SIZE = "32";
    const provider = createEmbedder(quietLogger);
    assert.ok(provider instanceof OpenAICompatibleEmbedder);
  });

  test("throws when embeddings are enabled but batch size is unset (no silent default)", () => {
    process.env.TOOLHUB_EMBEDDING_PROVIDER = "local";
    delete process.env.TOOLHUB_EMBEDDING_BATCH_SIZE;
    assert.throws(() => createEmbedder(quietLogger), /TOOLHUB_EMBEDDING_BATCH_SIZE/);

    process.env.TOOLHUB_EMBEDDING_PROVIDER = "openai-compatible";
    process.env.TOOLHUB_EMBEDDING_BASE_URL = "https://api.openai.com/v1";
    process.env.TOOLHUB_EMBEDDING_API_KEY = "sk-test";
    delete process.env.TOOLHUB_EMBEDDING_BATCH_SIZE;
    assert.throws(() => createEmbedder(quietLogger), /TOOLHUB_EMBEDDING_BATCH_SIZE/);
  });

  test("throws when remote credentials are missing", () => {
    process.env.TOOLHUB_EMBEDDING_PROVIDER = "openai-compatible";
    delete process.env.TOOLHUB_EMBEDDING_BASE_URL;
    delete process.env.TOOLHUB_EMBEDDING_API_KEY;
    assert.throws(
      () => createEmbedder(quietLogger),
      /TOOLHUB_EMBEDDING_BASE_URL and TOOLHUB_EMBEDDING_API_KEY/,
    );
  });

  test("throws on an unknown provider", () => {
    process.env.TOOLHUB_EMBEDDING_PROVIDER = "aws";
    assert.throws(() => createEmbedder(quietLogger), /Unknown TOOLHUB_EMBEDDING_PROVIDER/);
  });

  test("provider returned by the factory implements the interface", () => {
    delete process.env.TOOLHUB_EMBEDDING_PROVIDER;
    const provider: EmbeddingProvider = createEmbedder(quietLogger);
    assert.strictEqual(typeof provider.embedDocument, "function");
    assert.strictEqual(typeof provider.embedQuery, "function");
  });
});

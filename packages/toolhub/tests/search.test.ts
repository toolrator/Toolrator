import { test, describe } from "node:test";
import assert from "node:assert";
import { MemorySearchAdapter } from "../src/adapters/memory.js";
import { SearchService } from "../src/search-service.js";
import { Indexer } from "../src/indexer.js";
import { loadConfig } from "../src/config.js";
import type { EmbeddingProvider } from "../src/embedder.js";
import { chunkText, Embedder, poolVectors } from "../src/embedder.js";
import { encodeServerId, toolDocumentId } from "../src/tool-indexer.js";

/**
 * Fake embedder: deterministic, instant, model-free. Keeps tests fast and
 * independent of the ONNX model download.
 */
function fakeEmbedder(): EmbeddingProvider {
  return {
    provider: "local",
    model: "fake-model",
    dimensions: 384,
    maxInputChars: 2048,
    async embedDocument(text: string): Promise<number[]> {
      return [text.length];
    },
    async embedQuery(text: string): Promise<number[]> {
      return [text.length];
    },
    async embedMany(texts: string[]): Promise<Array<number[] | null>> {
      return texts.map((t) => [t.length]);
    },
  };
}

function makeService(env: Record<string, string> = {}): {
  adapter: MemorySearchAdapter;
  service: SearchService;
} {
  const adapter = new MemorySearchAdapter();
  const config = loadConfig({
    SEARCH_BACKEND: "memory",
    PORT: "7600",
    SEARCH_ADMIN_TOKEN: "test-token",
    SEARCH_DEFAULT_LIMIT: "2",
    SEARCH_MAX_LIMIT: "5",
    ...env,
  });
  const service = new SearchService(adapter, config, console, fakeEmbedder());
  return { adapter, service };
}

describe("Toolhub - In-Memory Tests", () => {
  test("Health check returns ok and memory status", async () => {
    const { service } = makeService();
    const health = await service.health();

    assert.strictEqual(health.status, "ok");
    assert.strictEqual(health.service, "toolhub");
    assert.strictEqual(health.backend, "memory");
    assert.strictEqual(health.documentCount, 0);
    assert.strictEqual(health.embedding.model, "fake-model");
  });

  test("Document normalization and indexing", async () => {
    const { adapter, service } = makeService();

    const mockDocs: any[] = [
      {
        mcp_name: "test-server-1",
        display_name: "Test Server One",
        description: "A server for testing things.",
        tags: ["test", "utility"],
        provider: "Acme Corp",
        capabilities: {
          tools: [
            {
              name: "run_test",
              description: "Runs a test tool",
              inputSchema: {
                type: "object",
                properties: {
                  command: { type: "string" },
                },
                required: ["command"],
              },
            },
          ],
        },
      },
      {
        mcp_name: "database-server",
        display_name: "Database Server",
        description: "A database query tool.",
        tags: ["db", "sql"],
        provider: "Acme Corp",
      },
      {
        mcp_name: "invalid-name!!!", // invalid name, should be skipped
        display_name: "Invalid",
      },
    ];

    const result = await service.indexer.indexBatch(mockDocs);
    assert.strictEqual(result.indexed, 2);
    assert.strictEqual(result.skipped, 1);

    const count = await adapter.getDocumentCount();
    assert.strictEqual(count, 2);

    // Tool index populated from capabilities (D7)
    const toolCount = await adapter.getToolDocumentCount();
    assert.strictEqual(toolCount, 1);

    // Retrieve single document by name
    const doc = (await service.getByName("test-server-1"))!;
    assert.ok(doc);
    assert.strictEqual(doc.mcp_name, "test-server-1");
    assert.strictEqual(doc.display_name, "Test Server One");
  });

  test("Faceted search and filters", async () => {
    const { service } = makeService();

    const mockDocs = [
      { mcp_name: "git-helper", display_name: "Git Helper", tags: ["code"], provider: "GitLab" },
      { mcp_name: "github-api", display_name: "GitHub API", tags: ["code", "api"], provider: "GitHub" },
      { mcp_name: "postgres-connector", display_name: "PostgreSQL Connector", tags: ["db"], provider: "Supa" },
    ];

    await service.indexer.indexBatch(mockDocs);

    // Search query with tags filter
    const resultTags = await service.search("git", { tags: ["code", "api"] });
    assert.strictEqual(resultTags.hits.length, 1);
    assert.strictEqual(resultTags.hits[0].mcp_name, "github-api");

    // Search query with provider filter
    const resultProvider = await service.search("", { provider: "Supa" });
    assert.strictEqual(resultProvider.hits.length, 1);
    assert.strictEqual(resultProvider.hits[0].mcp_name, "postgres-connector");

    // Facet counts for the entire index
    const allFacets = await service.getFacets();
    assert.ok(allFacets);
    assert.strictEqual(allFacets.provider["GitLab"], 1);
    assert.strictEqual(allFacets.provider["GitHub"], 1);
  });

  test("Search query paging and limits", async () => {
    const { service } = makeService();

    const mockDocs = [
      { mcp_name: "item-1", display_name: "Item 1", tags: ["test"] },
      { mcp_name: "item-2", display_name: "Item 2", tags: ["test"] },
      { mcp_name: "item-3", display_name: "Item 3", tags: ["test"] },
      { mcp_name: "item-4", display_name: "Item 4", tags: ["test"] },
    ];

    await service.indexer.indexBatch(mockDocs);

    // Default limit should be 2 (from our custom config)
    const resultDefault = await service.search("");
    assert.strictEqual(resultDefault.hits.length, 2);
    assert.strictEqual(resultDefault.limit, 2);

    // Custom limit
    const resultCustom = await service.search("", { limit: 3 });
    assert.strictEqual(resultCustom.hits.length, 3);

    // Offset paging
    const resultPaged = await service.search("", { limit: 2, offset: 2 });
    assert.strictEqual(resultPaged.hits.length, 2);
    assert.strictEqual(resultPaged.offset, 2);
    assert.strictEqual(resultPaged.hits[0].mcp_name, "item-3");
  });

  test("Browse pagination reaches beyond the default top-K window", async () => {
    const { service } = makeService();
    await service.indexer.indexBatch(Array.from({ length: 25 }, (_, i) => ({
      mcp_name: `browse-${i}`, display_name: `Browse ${i}`, tags: [],
    })));
    const page = await service.search("", { offset: 22, limit: 2 });
    assert.strictEqual(page.total, 25);
    assert.strictEqual(page.hits.length, 2);
    assert.strictEqual(page.hits[0].mcp_name, "browse-22");
  });

  test("A tool-free update removes previous tool documents", async () => {
    const { adapter, service } = makeService();
    await service.indexer.indexBatch([{
      mcp_name: "changing", display_name: "Changing", tags: [],
      capabilities: { tools: [{ name: "old_tool" }] },
    }]);
    assert.strictEqual(await adapter.getToolDocumentCount(), 1);
    await service.indexer.indexBatch([{
      mcp_name: "changing", display_name: "Changing", tags: [],
      capabilities: { tools: [] },
    }]);
    assert.strictEqual(await adapter.getToolDocumentCount(), 0);
  });

  test("Configured embed limits apply to incremental indexing without dropping tool documents", async () => {
    // TOOLHUB_MAX_TOOLS_EMBEDDED bounds EMBEDDING per server — it must never
    // drop tool documents: the tool index is the complete tool list.
    const adapter = new MemorySearchAdapter();
    const config = loadConfig({
      SEARCH_BACKEND: "memory",
      PORT: "7600",
      SEARCH_ADMIN_TOKEN: "test-token",
      SEARCH_DEFAULT_LIMIT: "2",
      SEARCH_MAX_LIMIT: "5",
      TOOLHUB_MAX_TOOLS_EMBEDDED: "1",
    });
    const base = fakeEmbedder();
    let embeddedTexts = 0;
    const counting: EmbeddingProvider = {
      ...base,
      async embedMany(texts: string[]) {
        embeddedTexts += texts.length;
        return base.embedMany(texts);
      },
    };
    const service = new SearchService(adapter, config, console, counting);
    await service.indexer.indexBatch([{
      mcp_name: "limited", display_name: "Limited", tags: [],
      capabilities: { tools: [{ name: "first" }, { name: "second" }] },
    }]);
    // Both tools stay searchable …
    assert.strictEqual(await adapter.getToolDocumentCount(), 2);
    // … but only the configured subset is embedded (1 tool + 1 server text).
    assert.strictEqual(embeddedTexts, 2);
  });

  test("Invalid full reindex keeps existing documents", async () => {
    const { adapter, service } = makeService();
    await service.indexer.indexBatch([{ mcp_name: "keep", display_name: "Keep", tags: [] }]);
    await assert.rejects(() => service.indexer.reindex([{ mcp_name: "invalid!!!" }]), /no valid documents/);
    assert.strictEqual(await adapter.getDocumentCount(), 1);
    assert.ok(await adapter.getByName("keep"));
  });

  test("Document IDs remain distinct after former lossy encodings", () => {
    assert.notStrictEqual(encodeServerId("foo.bar"), encodeServerId("foo_bar"));
    assert.notStrictEqual(encodeServerId("foo/bar"), encodeServerId("foo__bar"));
    assert.notStrictEqual(toolDocumentId("foo", "read.file"), toolDocumentId("foo", "read_file"));
  });

  test("Tool hits via the D7 tool index", async () => {
    const { service } = makeService();

    const mockDocs = [
      {
        mcp_name: "filesystem",
        display_name: "Filesystem MCP",
        capabilities: {
          tools: [
            { name: "read_file", description: "Read a file from disk" },
            { name: "write_file", description: "Write a file to disk" },
          ],
        },
      },
    ];

    await service.indexer.indexBatch(mockDocs);

    const result = await service.search("read file from disk");
    const toolHits = result.toolHits!;
    assert.ok(toolHits);
    assert.strictEqual(toolHits.length, 1);
    assert.strictEqual(toolHits[0].name, "read_file");
    assert.strictEqual(toolHits[0].server_mcp_name, "filesystem");
    assert.strictEqual(result.intent, "tool");
    assert.ok(result.diagnostics?.usedToolIndex);
  });

  test("Exact server match wins intent", async () => {
    const { service } = makeService();

    const mockDocs = [
      {
        mcp_name: "filesystem",
        display_name: "Filesystem MCP",
        capabilities: {
          tools: [{ name: "read_file", description: "Read a file from disk" }],
        },
      },
      {
        mcp_name: "postgres",
        display_name: "PostgreSQL Server",
        capabilities: {
          tools: [{ name: "run_query", description: "Run a SQL query" }],
        },
      },
    ];

    await service.indexer.indexBatch(mockDocs);

    const result = await service.search("filesystem");
    assert.strictEqual(result.intent, "server");
    assert.strictEqual(result.hits[0].mcp_name, "filesystem");
  });

  test("Removing a server cascades to its tools", async () => {
    const { adapter, service } = makeService();

    await service.indexer.indexBatch([
      {
        mcp_name: "filesystem",
        display_name: "Filesystem MCP",
        capabilities: {
          tools: [
            { name: "read_file", description: "Read a file from disk" },
            { name: "write_file", description: "Write a file to disk" },
          ],
        },
      },
    ]);

    assert.strictEqual(await adapter.getToolDocumentCount(), 2);
    await service.indexer.remove("filesystem");
    assert.strictEqual(await adapter.getDocumentCount(), 0);
    assert.strictEqual(await adapter.getToolDocumentCount(), 0);
  });

  test("recordEmbeddingFingerprint refreshes a stale active fingerprint", async () => {
    const { adapter, service } = makeService();

    // Simulate a meta left over from a previous embedding provider: after a
    // full reindex with the current config, health must stop reporting
    // needsReindex (the old behavior preserved the stale active fingerprint
    // forever, so an orchestrator polling health would reindex on every
    // cooldown cycle).
    await adapter.writeEmbeddingMeta({
      id: "embedding",
      current_fingerprint: "stale-current",
      active_fingerprint: "stale-active",
      provider: "openai-compatible",
      model: "old-model",
      dimensions: 384,
      updated_at: new Date().toISOString(),
    });

    await service.recordEmbeddingFingerprint();

    const health = await service.health();
    assert.strictEqual(health.embedding.activeFingerprint, health.embedding.currentFingerprint);
    assert.strictEqual(health.embedding.needsReindex, false);
  });

  test("Index list returns server + tool metadata", async () => {
    const { service } = makeService();

    await service.indexer.indexBatch([
      {
        mcp_name: "filesystem",
        display_name: "Filesystem MCP",
        capabilities: {
          tools: [{ name: "read_file", description: "Read a file from disk" }],
        },
      },
    ]);

    const list = await service.getIndexList();
    assert.strictEqual(list.servers.length, 1);
    assert.strictEqual(list.servers[0].id, "filesystem");
    assert.ok(list.servers[0].content_hash);
    assert.strictEqual(list.tools.length, 1);
    assert.strictEqual(list.tools[0].id, toolDocumentId("filesystem", "read_file"));
  });
});

describe("Toolhub - Embedding Chunking", () => {
  test("chunkText respects the budget and prefers boundary breaks", () => {

    const text =
      "First paragraph with a sentence. And another sentence!\n\n" +
      "Second paragraph has a line break\nand continues here.";

    // Budget large enough for a paragraph boundary
    const chunks = chunkText(text, 80);
    assert.ok(chunks.length >= 2, `expected paragraph split, got ${chunks.length} chunk(s)`);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 80, `chunk exceeded budget: ${chunk.length}`);
    }
    assert.strictEqual(chunks.join(""), text, "chunks must preserve the full text");

    // Tiny budget forces hard splits without losing content
    const tiny = chunkText("a".repeat(500), 64);
    assert.ok(tiny.length >= 8);
    assert.strictEqual(tiny.join(""), "a".repeat(500));

    // Never splits a surrogate pair / emoji
    const emoji = "🎉".repeat(200);
    const emojiChunks = chunkText(emoji, 64);
    for (const chunk of emojiChunks) {
      assert.ok([...chunk].every((cp) => cp === "🎉"), "surrogate pair split detected");
    }

    const punctuation = "!Important" + "x".repeat(100);
    assert.strictEqual(chunkText(punctuation, 16).join(""), punctuation);
    assert.deepStrictEqual(chunkText("🎉🎉", 1), ["🎉", "🎉"]);
  });

  test("embedMany chunks long documents into multiple bounded requests", async () => {
    const { OpenAICompatibleEmbedder } = await import("../src/embedder.js");

    const inputs: string[][] = [];
    const fetchStub = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { input: string[] };
      inputs.push(body.input);
      return new Response(
        JSON.stringify({
          object: "list",
          data: body.input.map((_, i) => ({ object: "embedding", index: i, embedding: [0.5] })),
          model: "test",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const embedder = new OpenAICompatibleEmbedder(
      {
        baseUrl: "https://api.test/v1",
        apiKey: "sk-test",
        model: "test-model",
        maxInputChars: 60,
        batchSize: 32,
        retryDelayMs: 5,
      },
      { info() {}, warn() {}, error() {} } as any,
      fetchStub,
    );

    const longText = "A deliberately long document that must be chunked up. ".repeat(200);
    const vectors = await embedder.embedMany([longText], "document");

    assert.ok(vectors[0], "expected a pooled vector");
    assert.ok(inputs.length > 1, `expected multiple API requests, got ${inputs.length}`);
    for (const batch of inputs) {
      for (const input of batch) {
        assert.ok(input.length <= 60, `input exceeded budget: ${input.length} chars`);
      }
      assert.ok(batch.length <= 32, "batch exceeded batchSize");
    }
  });
});

describe("Toolhub - Trust Ranking", () => {
  test("Verified and popular servers outrank unverified copies at equal relevance", async () => {
    const { service } = makeService();

    // Identical descriptions = equal textual relevance. The unverified copy is
    // indexed first so any stable-order tie-break favors it.
    const docs: any[] = [
      {
        mcp_name: "toolrator-registry/copycat",
        display_name: "Copycat",
        description: "Search GitHub repositories and issues.",
        tags: ["github"],
      },
      {
        mcp_name: "toolrator-registry/official",
        display_name: "Official",
        description: "Search GitHub repositories and issues.",
        tags: ["github"],
        verified: true,
      },
      {
        mcp_name: "toolrator-registry/hot",
        display_name: "Hot",
        description: "Search GitHub repositories and issues.",
        tags: ["github"],
        popularity: 500,
      },
    ];
    await service.indexer.indexBatch(docs);

    const result = await service.search("github", { limit: 5 });
    const names = result.hits.map((h) => h.mcp_name);
    assert.deepStrictEqual(names, [
      "toolrator-registry/official",
      "toolrator-registry/hot",
      "toolrator-registry/copycat",
    ]);
  });

  test("Within the same trust tier, stronger text matches still rank first", async () => {
    const { service } = makeService();

    const docs: any[] = [
      {
        mcp_name: "toolrator-registry/weak",
        display_name: "Weak",
        description: "Weather forecasts.",
        tags: ["weather"],
        verified: true,
      },
      {
        mcp_name: "toolrator-registry/strong",
        display_name: "Strong",
        description: "GitHub issues, GitHub pull requests, GitHub repositories.",
        tags: ["github"],
        verified: true,
      },
    ];
    await service.indexer.indexBatch(docs);

    const result = await service.search("github", { limit: 5 });
    assert.ok(result.hits.length >= 1);
    assert.strictEqual(result.hits[0].mcp_name, "toolrator-registry/strong");
  });

  test("Popularity saturates instead of growing unbounded", async () => {
    const { service } = makeService();

    const docs: any[] = [
      {
        mcp_name: "toolrator-registry/plain",
        display_name: "Plain",
        description: "Search GitHub repositories and issues.",
        tags: ["github"],
      },
      {
        mcp_name: "toolrator-registry/huge",
        display_name: "Huge",
        description: "Search GitHub repositories and issues.",
        tags: ["github"],
        popularity: 1_000_000,
      },
    ];
    await service.indexer.indexBatch(docs);

    // A saturated popularity bonus (≤ 1 + 0.08) must not outweigh a genuine
    // relevance gap of several ranks — both docs are near-ties here, so the
    // popular one wins, but only just.
    const result = await service.search("github", { limit: 5 });
    assert.strictEqual(result.hits[0].mcp_name, "toolrator-registry/huge");
  });
});

describe("local embedder streaming pooling", () => {
  test("embedMany pooling is bit-identical to poolVectors across batches", async () => {
    process.env.TOOLHUB_EMBEDDING_BATCH_SIZE = "2";
    process.env.TOOLHUB_EMBEDDING_POOLING_MODE = "weighted_mean";
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    const embedder = new Embedder(quiet);
    const dims = embedder.dimensions;

    // Deterministic fake ONNX pipeline: each text maps to a fixed vector.
    // Values round through Float32Array to mirror what a real pipeline emits.
    const fakeVector = (text: string): number[] => {
      const v = new Float32Array(dims);
      for (let d = 0; d < dims; d++) {
        v[d] = ((text.charCodeAt(0) * 31 + text.length * 7 + d * 13) % 97) / 97;
      }
      return Array.from(v);
    };
    const fakeExtractor = async (texts: string[]) => {
      const data = new Float32Array(texts.length * dims);
      for (let i = 0; i < texts.length; i++) {
        const v = fakeVector(texts[i]);
        for (let d = 0; d < dims; d++) data[i * dims + d] = v[d];
      }
      return { data };
    };
    Object.assign(embedder, { pipelinePromise: Promise.resolve(fakeExtractor) });

    const texts = [
      "short doc",
      "x".repeat(5000), // multi-chunk, straddles batch boundaries (batchSize=2)
      "",
      "mixed content. ".repeat(200),
    ];
    const results = await embedder.embedMany(texts, "document");

    const budget = embedder.maxInputChars - "passage: ".length;
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i]) {
        assert.strictEqual(results[i], null);
        continue;
      }
      const chunks = chunkText(texts[i], budget);
      assert.ok(chunks.length >= 1);
      const vecs = chunks.map((c) => fakeVector(`passage: ${c}`));
      const expected = poolVectors(vecs, chunks.map((c) => c.length), "weighted_mean");
      assert.ok(results[i], `result ${i} should be embedded`);
      assert.strictEqual(results[i]!.length, dims);
      // Exact float equality on purpose: the streaming fold must produce the
      // same doubles in the same summation order as poolVectors.
      for (let d = 0; d < dims; d++) assert.strictEqual(results[i]![d], expected[d]);
    }
  });

  test("unexpected batch shape leaves results null", async () => {
    process.env.TOOLHUB_EMBEDDING_BATCH_SIZE = "2";
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    const embedder = new Embedder(quiet);
    const badExtractor = async () => ({ data: new Float32Array(3) });
    Object.assign(embedder, { pipelinePromise: Promise.resolve(badExtractor) });
    const results = await embedder.embedMany(["a", "b"], "document");
    assert.deepStrictEqual(results, [null, null]);
  });
});

describe("Indexer - per-document field budget", () => {
  /**
   * A tool whose input schema alone burns tens of thousands of MeiliSearch
   * fields. MeiliSearch charges every array entry and every nested key against
   * a 65,535-field per-document cap, and a giant `enum` is how registry servers
   * realistically get there.
   */
  function pathologicalTool(name: string, enumSize: number): unknown {
    return {
      name,
      description: `Tool ${name}`,
      inputSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            description: "a value",
            enum: Array.from({ length: enumSize }, (_, i) => `value_${i}`),
          },
        },
        required: ["value"],
      },
    };
  }

  function storedTools(
    adapter: MemorySearchAdapter,
    mcpName: string,
  ): Promise<Array<{ name: string; inputSchema?: unknown }>> {
    return adapter.getByName(mcpName).then((doc) => {
      assert.ok(doc, `expected "${mcpName}" to be indexed`);
      return ((doc!.capabilities as { tools?: Array<{ name: string; inputSchema?: unknown }> })?.tools ?? []);
    });
  }

  test("an oversized tool list is trimmed in the server document but kept whole in the tool index", async () => {
    process.env.TOOLHUB_SERVER_FIELD_BUDGET = "500";
    try {
      const { adapter, service } = makeService();

      // 8 tools x ~100 fields each = ~800, over the 500 budget but far below
      // MeiliSearch's hard 65,535 cap for any single one of them.
      const tools = Array.from({ length: 8 }, (_, i) => pathologicalTool(`tool_${i}`, 100));
      const result = await service.indexer.indexBatch([
        {
          mcp_name: "pathological-server",
          display_name: "Pathological Server",
          description: "Schemas that would break a MeiliSearch batch.",
          capabilities: { tools },
        },
      ]);

      // One oversized document must not poison its batch — nothing is rejected.
      assert.strictEqual(result.indexed, 1);
      assert.strictEqual(result.skipped, 0);

      const kept = await storedTools(adapter, "pathological-server");
      assert.ok(kept.length > 0, "at least one tool should survive");
      assert.ok(
        kept.length < tools.length,
        `expected the stored copy to be trimmed, got ${kept.length}/${tools.length}`,
      );
      // Trimming drops whole tools; survivors keep their full schema.
      for (const tool of kept) assert.ok(tool.inputSchema, `tool "${tool.name}" should keep its schema`);

      // The tool index still holds every tool, so search never loses them.
      assert.strictEqual(result.toolsIndexed, tools.length);
      assert.strictEqual(await adapter.getToolDocumentCount(), tools.length);
    } finally {
      delete process.env.TOOLHUB_SERVER_FIELD_BUDGET;
    }
  });

  test("a single tool whose schema alone exceeds the budget is still listed, minus the schema", async () => {
    process.env.TOOLHUB_SERVER_FIELD_BUDGET = "100";
    try {
      const { adapter, service } = makeService();

      const result = await service.indexer.indexBatch([
        {
          mcp_name: "one-huge-tool",
          display_name: "One Huge Tool",
          capabilities: {
            tools: [
              {
                ...(pathologicalTool("gigantic", 500) as Record<string, unknown>),
                // The fallback copy must not keep OTHER schema trees either:
                // prod (2026-10-16) — 67,621 fields travelled through
                // outputSchema enums + vendor metadata even with inputSchema
                // already dropped, rejecting its whole batch.
                outputSchema: { type: "object", properties: { out: { type: "string", enum: ["a", "b", "c"] } } },
                _meta: { vendor_blob: "x".repeat(10) },
              },
            ],
          },
        },
      ]);

      assert.strictEqual(result.indexed, 1);

      const kept = (await storedTools(adapter, "one-huge-tool")) as Array<Record<string, unknown>>;
      assert.strictEqual(kept.length, 1, "the tool should still be advertised");
      assert.strictEqual(kept[0].name, "gigantic");
      assert.strictEqual(kept[0].inputSchema, undefined, "the oversized schema is dropped");
      assert.strictEqual(kept[0].outputSchema, undefined, "other schema trees are dropped too");
      assert.strictEqual(kept[0]._meta, undefined, "vendor metadata is dropped too");
    } finally {
      delete process.env.TOOLHUB_SERVER_FIELD_BUDGET;
    }
  });

  test("documents within the budget keep their tools untouched", async () => {
    process.env.TOOLHUB_SERVER_FIELD_BUDGET = "5000";
    try {
      const { adapter, service } = makeService();

      await service.indexer.indexBatch([
        {
          mcp_name: "normal-server",
          display_name: "Normal Server",
          capabilities: { tools: [pathologicalTool("small", 5)] },
        },
      ]);

      const kept = await storedTools(adapter, "normal-server");
      assert.strictEqual(kept.length, 1);
      assert.ok(kept[0].inputSchema, "a normal document must not be trimmed");
    } finally {
      delete process.env.TOOLHUB_SERVER_FIELD_BUDGET;
    }
  });

  test("the server document caps its stored tool list while the tool index keeps every tool", async () => {
    const { adapter, service } = makeService();

    // 2,500 tiny tools ≈ 10k fields — within the 50k field budget, but every
    // `capabilities.tools.{i}.{key}` path permanently burns one of
    // Meilisearch's 65,535 per-index field IDs (meilisearch#3833), so the
    // server copy is count-capped as well.
    const tools = Array.from({ length: 2500 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tiny tool ${i}`,
    }));
    const result = await service.indexer.indexBatch([
      {
        mcp_name: "huge-tool-list",
        display_name: "Huge Tool List",
        capabilities: { tools },
      },
    ]);

    assert.strictEqual(result.indexed, 1);

    const kept = await storedTools(adapter, "huge-tool-list");
    assert.strictEqual(kept.length, 2_000, "server copy capped at 2,000 tools");
    assert.strictEqual(kept[0].name, "tool_0", "the cap keeps the head of the list deterministically");

    // The tool index keeps every tool.
    assert.strictEqual(result.toolsIndexed, tools.length);
    assert.strictEqual(await adapter.getToolDocumentCount(), tools.length);
  });

  test("TOOLHUB_SERVER_TOOL_SCHEMAS=off keeps every tool but drops schemas from the server copy", async () => {
    process.env.TOOLHUB_SERVER_TOOL_SCHEMAS = "off";
    try {
      const { adapter, service } = makeService();

      const tools = Array.from({ length: 6 }, (_, i) => pathologicalTool(`tool_${i}`, 40));
      const result = await service.indexer.indexBatch([
        {
          mcp_name: "schema-stripped-server",
          display_name: "Schema Stripped Server",
          capabilities: { tools },
        },
      ]);

      assert.strictEqual(result.indexed, 1);

      // Every tool survives in the server document, none with a schema.
      const kept = await storedTools(adapter, "schema-stripped-server");
      assert.strictEqual(kept.length, tools.length);
      for (const tool of kept) {
        assert.strictEqual(tool.inputSchema, undefined, `tool "${tool.name}" must not carry a schema`);
        const rec = tool as Record<string, unknown>;
        assert.strictEqual(rec.outputSchema, undefined, `tool "${tool.name}" must not carry an output schema`);
        assert.strictEqual(typeof rec.compact_schema, "string", `tool "${tool.name}" keeps its schema as the compact string`);
        assert.ok((rec.compact_schema as string).length > 0, "the compact schema should be non-empty");
      }

      // The tool index still holds every tool, built from the full schemas.
      assert.strictEqual(result.toolsIndexed, tools.length);
      assert.strictEqual(await adapter.getToolDocumentCount(), tools.length);
    } finally {
      delete process.env.TOOLHUB_SERVER_TOOL_SCHEMAS;
    }
  });

  test("TOOLHUB_SERVER_TOOL_SCHEMAS=off bounds registry-scale documents under Meilisearch's field cap", async () => {
    process.env.TOOLHUB_SERVER_TOOL_SCHEMAS = "off";
    try {
      const { adapter, service } = makeService();

      /** MeiliSearch counts one field per nested key AND per array entry. */
      const countFields = (value: unknown): number => {
        if (value === null || typeof value !== "object") return 1;
        if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + countFields(item), 1);
        return Object.keys(value as object).reduce(
          (sum, key) => sum + 1 + countFields((value as Record<string, unknown>)[key]),
          0,
        );
      };

      // Shape of a real registry server (measured 2026-10-16): inputSchema is
      // not the only schema tree — `outputSchema` enums and vendor metadata
      // pushed one live document to 67,621 fields with inputSchema already
      // dropped, rejecting its whole 250-doc batch.
      const bigEnum = Array.from({ length: 3000 }, (_, i) => `value_${i}`);
      const registryTool = (name: string): unknown => ({
        name,
        description: `Registry tool ${name}`,
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", enum: bigEnum } },
        },
        outputSchema: {
          type: "object",
          properties: { result: { type: "string", enum: bigEnum } },
        },
        execution: { retries: 3, timeout: 1000, modes: bigEnum.slice(0, 500) },
        _meta: Object.fromEntries(bigEnum.slice(0, 500).map((v) => [v, 1])),
        annotations: { readOnlyHint: true, title: "Registry" },
        tier: "pro",
        pricing_metadata: { price: 1, currency: "USD" },
      });

      // 10 tools x ~7,500 fields ≈ 75,000 raw fields — over the 65,535 cap.
      const tools = Array.from({ length: 10 }, (_, i) => registryTool(`tool_${i}`));
      const result = await service.indexer.indexBatch([
        {
          mcp_name: "registry-scale-server",
          display_name: "Registry Scale Server",
          capabilities: { tools },
        },
      ]);

      assert.strictEqual(result.indexed, 1);
      assert.strictEqual(result.skipped, 0);

      const kept = (await storedTools(adapter, "registry-scale-server")) as Array<Record<string, unknown>>;
      assert.strictEqual(kept.length, tools.length, "no tool may be dropped");

      // Arbitrary-keyed subtrees and vendor junk are gone; the searchable
      // schema survives as the one-field compact_schema string.
      for (const [i, tool] of kept.entries()) {
        for (const banned of ["inputSchema", "outputSchema", "execution", "_meta", "tier", "pricing_metadata", "parameters"]) {
          assert.strictEqual(tool[banned], undefined, `tool "${String(tool.name)}" must not carry "${banned}"`);
        }
        assert.strictEqual(typeof tool.compact_schema, "string");
        assert.ok((tool.compact_schema as string).length > 0, "the compact schema should be non-empty");
        assert.deepStrictEqual(tool.annotations, { readOnlyHint: true }, "only bounded hint flags survive");
        assert.strictEqual(tool.name, `tool_${i}`);
      }

      // The whole server document stays an order of magnitude under the cap
      // even though the raw tools would blow through it many times over.
      assert.ok(countFields({ tools: kept }) < 2000, `stored tools cost ${countFields({ tools: kept })} fields`);
      assert.ok(countFields({ tools }) > 65_535, "the raw fixture must exceed the cap to be a regression test");

      // The tool index still holds every tool, built from the full schemas.
      assert.strictEqual(result.toolsIndexed, tools.length);
      assert.strictEqual(await adapter.getToolDocumentCount(), tools.length);
    } finally {
      delete process.env.TOOLHUB_SERVER_TOOL_SCHEMAS;
    }
  });

  test("TOOLHUB_SERVER_TOOL_SCHEMAS=off still trims when the projected tool list alone exceeds the budget", async () => {
    process.env.TOOLHUB_SERVER_TOOL_SCHEMAS = "off";
    process.env.TOOLHUB_SERVER_FIELD_BUDGET = "500";
    try {
      const { adapter, service } = makeService();

      const countFields = (value: unknown): number => {
        if (value === null || typeof value !== "object") return 1;
        if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + countFields(item), 1);
        return Object.keys(value as object).reduce(
          (sum, key) => sum + 1 + countFields((value as Record<string, unknown>)[key]),
          0,
        );
      };

      // The projection bounds each tool but not their COUNT — prod
      // (2026-10-17): an aggregator server's projected tool list alone
      // exceeded MeiliSearch's 65,535-field document cap and rejected every
      // batch it travelled in. 400 tiny tools × ~6 projected fields ≈ 2,400,
      // over a 500 budget.
      const tools = Array.from({ length: 400 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tiny tool ${i}`,
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      }));
      const result = await service.indexer.indexBatch([
        {
          mcp_name: "aggregator-server",
          display_name: "Aggregator Server",
          capabilities: { tools },
        },
      ]);

      assert.strictEqual(result.indexed, 1);
      assert.strictEqual(result.skipped, 0);

      const kept = (await storedTools(adapter, "aggregator-server")) as Array<Record<string, unknown>>;
      assert.ok(kept.length > 0, "the head of the tool list must survive");
      assert.ok(
        kept.length < tools.length,
        `expected the projected list to be trimmed, got ${kept.length}/${tools.length}`,
      );
      assert.ok(countFields({ tools: kept }) <= 502, `stored tools cost ${countFields({ tools: kept })} fields`);
      for (const tool of kept) {
        assert.strictEqual(tool.inputSchema, undefined, `tool "${String(tool.name)}" must not carry a schema`);
      }

      // The tool index still holds every tool, built from the full schemas.
      assert.strictEqual(result.toolsIndexed, tools.length);
      assert.strictEqual(await adapter.getToolDocumentCount(), tools.length);
    } finally {
      delete process.env.TOOLHUB_SERVER_FIELD_BUDGET;
      delete process.env.TOOLHUB_SERVER_TOOL_SCHEMAS;
    }
  });
});

describe("Indexer - batched tool rebuild", () => {
  test("every tool becomes a tool document while embedding stays bounded per server", async () => {
    // The tool index is the COMPLETE tool list (the server document is what
    // trims to Meilisearch's field budget), but embedding cost is capped at
    // TOOLHUB_MAX_TOOLS_EMBEDDED per server — the remainder are stored
    // lexically searchable with has_vector: false.
    const adapter = new MemorySearchAdapter();
    const config = loadConfig({
      SEARCH_BACKEND: "memory",
      PORT: "7600",
      SEARCH_ADMIN_TOKEN: "test-token",
      SEARCH_DEFAULT_LIMIT: "2",
      SEARCH_MAX_LIMIT: "5",
      TOOLHUB_MAX_TOOLS_EMBEDDED: "8",
    });
    const base = fakeEmbedder();
    let embeddedTexts = 0;
    const counting: EmbeddingProvider = {
      ...base,
      async embedMany(texts: string[]) {
        embeddedTexts += texts.length;
        return base.embedMany(texts);
      },
    };
    const service = new SearchService(adapter, config, console, counting);

    const tools = Array.from({ length: 40 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool tool_${i}`,
    }));
    const result = await service.indexer.indexBatch([
      {
        mcp_name: "big-server",
        display_name: "Big Server",
        capabilities: { tools },
      },
    ]);

    // The tool index holds every tool …
    assert.strictEqual(result.toolsIndexed, tools.length);
    assert.strictEqual(await adapter.getToolDocumentCount(), tools.length);

    // …but only maxToolsEmbedded tool texts (+1 server text) are embedded.
    assert.strictEqual(embeddedTexts, 1 + 8);
  });

  test("re-upserting a server replaces its tools and leaves other servers untouched", async () => {
    const { adapter, service } = makeService();

    const toolsFor = (names: string[]) =>
      names.map((name) => ({ name, description: `Tool ${name}` }));

    await service.indexer.indexBatch([
      {
        mcp_name: "server-a",
        display_name: "Server A",
        capabilities: { tools: toolsFor(["a1", "a2"]) },
      },
      {
        mcp_name: "server-b",
        display_name: "Server B",
        capabilities: { tools: toolsFor(["b1"]) },
      },
    ]);
    assert.strictEqual(await adapter.getToolDocumentCount(), 3);

    // Server A sheds a1 and gains a3; server B is not in the batch at all.
    await service.indexer.indexBatch([
      {
        mcp_name: "server-a",
        display_name: "Server A",
        capabilities: { tools: toolsFor(["a2", "a3"]) },
      },
    ]);

    const names = (await adapter.getAllToolDocuments()).map((doc) => doc.tool_name).sort();
    assert.deepStrictEqual(names, ["a2", "a3", "b1"], `unexpected tool set: ${names.join(", ")}`);
  });
});

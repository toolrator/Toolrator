import { test, describe } from "node:test";
import assert from "node:assert";
import { MemorySearchAdapter } from "../src/adapters/memory.js";
import { SearchService } from "../src/search-service.js";
import { Indexer } from "../src/indexer.js";
import { loadConfig } from "../src/config.js";
import type { EmbeddingProvider } from "../src/embedder.js";
import { chunkText } from "../src/embedder.js";

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
    // forever, so the control plane would reindex on every cooldown cycle).
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
    assert.strictEqual(list.tools[0].id, "filesystem__read_file");
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

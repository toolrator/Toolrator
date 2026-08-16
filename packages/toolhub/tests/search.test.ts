import { test, describe } from "node:test";
import assert from "node:assert";
import { MemorySearchAdapter } from "../src/adapters/memory.js";
import { SearchService } from "../src/search-service.js";
import { loadConfig } from "../src/config.js";
import type { SearchDocument } from "../src/adapters/types.js";

describe("Toolhub - In-Memory Tests", () => {
  const config = loadConfig({
    SEARCH_BACKEND: "memory",
    PORT: "7600",
    SEARCH_ADMIN_TOKEN: "test-token",
    SEARCH_DEFAULT_LIMIT: "2",
    SEARCH_MAX_LIMIT: "5",
  });

  test("Health check returns ok and memory status", async () => {
    const adapter = new MemorySearchAdapter();
    const service = new SearchService(adapter, config);
    const health = await service.health();

    assert.strictEqual(health.status, "ok");
    assert.strictEqual(health.service, "toolhub");
    assert.strictEqual(health.backend, "memory");
    assert.strictEqual(health.documentCount, 0);
  });

  test("Document normalization and indexing", async () => {
    const adapter = new MemorySearchAdapter();
    const service = new SearchService(adapter, config);

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

    const indexedCount = await service.indexer.indexBatch(mockDocs);
    assert.strictEqual(indexedCount, 2);

    const count = await adapter.getDocumentCount();
    assert.strictEqual(count, 2);

    // Retrieve single document by name
    const doc = (await service.getByName("test-server-1"))!;
    assert.ok(doc);
    assert.strictEqual(doc.mcp_name, "test-server-1");
    assert.strictEqual(doc.display_name, "Test Server One");
  });

  test("Faceted search and filters", async () => {
    const adapter = new MemorySearchAdapter();
    const service = new SearchService(adapter, config);

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
    const adapter = new MemorySearchAdapter();
    const service = new SearchService(adapter, config);

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

  test("Tool Hits extraction", async () => {
    const adapter = new MemorySearchAdapter();
    const service = new SearchService(adapter, config);

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

    const result = await service.search("read");
    const toolHits = result.toolHits!;
    assert.ok(toolHits);
    assert.strictEqual(toolHits.length, 1);
    assert.strictEqual(toolHits[0].name, "read_file");
    assert.strictEqual(toolHits[0].server_mcp_name, "filesystem");
  });
});

import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Logger } from "../src/config.js";
import { fetchAndCacheSchema, loadCachedSchema, FALLBACK_SCHEMA } from "../src/schema-cache.js";

const PORT = 34568;
let serverInstance: any;

describe("SchemaCache", () => {
  let tmpConfigDir: string;

  before(() => {
    tmpConfigDir = join(tmpdir(), `tc-schema-test-${Math.random().toString(36).substring(7)}`);
    mkdirSync(tmpConfigDir, { recursive: true });

    const app = new Hono();
    app.get("/schema-endpoint", (c) => {
      return c.json({
        inputSchema: {
          type: "object",
          properties: {
            custom_query: { type: "string" }
          },
          required: ["custom_query"]
        },
        outputDescription: "Mock search outputs."
      });
    });

    serverInstance = serve({ fetch: app.fetch, port: PORT });
  });

  after(async () => {
    if (serverInstance) {
      await new Promise<void>((resolve) => serverInstance.close(() => resolve()));
    }
    try {
      rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const logger = new Logger("error");

  test("fetches and caches schema successfully from URL", async () => {
    const engineId = "test-live-engine";
    const schemaUrl = `http://localhost:${PORT}/schema-endpoint`;

    const schema = await fetchAndCacheSchema(engineId, schemaUrl, tmpConfigDir, logger);

    assert.ok(schema.inputSchema);
    assert.deepStrictEqual((schema.inputSchema as any).properties.custom_query, { type: "string" });
    assert.strictEqual(schema.outputDescription, "Mock search outputs.");

    // Verify cache file exists
    const cacheFile = join(tmpConfigDir, "schemas", `${engineId}.json`);
    assert.ok(existsSync(cacheFile));

    // Verify loading from cache directly
    const cached = loadCachedSchema(engineId, tmpConfigDir);
    assert.ok(cached);
    assert.deepStrictEqual(cached.inputSchema, schema.inputSchema);
  });

  test("falls back to cache when live fetch fails", async () => {
    const engineId = "test-fallback-cache";
    const cacheDir = join(tmpConfigDir, "schemas");
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    // Pre-populate cache
    const cacheFile = join(cacheDir, `${engineId}.json`);
    const mockSchema = {
      inputSchema: { type: "object", properties: { preloaded: { type: "boolean" } } },
      outputDescription: "Preloaded desc"
    };
    writeFileSync(cacheFile, JSON.stringify({ schema: mockSchema, _cachedAt: Date.now() }));

    // Try fetching from a non-existent URL (should fail and load from cache)
    const schema = await fetchAndCacheSchema(engineId, "http://localhost:9999/does-not-exist", tmpConfigDir, logger);
    assert.deepStrictEqual(schema, mockSchema);
  });

  test("falls back to FALLBACK_SCHEMA when both live fetch and cache fail", async () => {
    const engineId = "test-generic-fallback";
    const schema = await fetchAndCacheSchema(engineId, "http://localhost:9999/does-not-exist", tmpConfigDir, logger);
    assert.deepStrictEqual(schema, FALLBACK_SCHEMA);
  });
});

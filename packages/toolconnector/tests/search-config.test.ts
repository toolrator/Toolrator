import { test, describe } from "node:test";
import assert from "node:assert";
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSearchConfig, SearchEngineConfigSchema } from "../src/search-config.js";
import { DEFAULT_ENGINE_ID } from "../src/config.js";

describe("Search Config Validation", () => {
  test("accepts valid http search engine", () => {
    const config = {
      id: "test-engine",
      label: "Test HTTP Engine",
      transport: "http",
      endpoint: "http://localhost:7600",
      schemaUrl: "https://localhost:7600/schema",
      notes: "Some note",
      timeoutMs: 3000,
      enabled: true,
    };
    const res = SearchEngineConfigSchema.safeParse(config);
    assert.strictEqual(res.success, true);
  });

  test("rejects invalid transport types", () => {
    const config = {
      id: "test-engine",
      label: "Test HTTP Engine",
      transport: "invalid-transport",
      endpoint: "http://localhost:7600",
    };
    const res = SearchEngineConfigSchema.safeParse(config);
    assert.strictEqual(res.success, false);
  });

  test("rejects ID with uppercase or spaces", () => {
    const config1 = {
      id: "Test-Engine",
      label: "Test HTTP Engine",
      transport: "http",
      endpoint: "http://localhost:7600",
    };
    const res1 = SearchEngineConfigSchema.safeParse(config1);
    assert.strictEqual(res1.success, false);

    const config2 = {
      id: "test engine",
      label: "Test HTTP Engine",
      transport: "http",
      endpoint: "http://localhost:7600",
    };
    const res2 = SearchEngineConfigSchema.safeParse(config2);
    assert.strictEqual(res2.success, false);
  });

  test("requires args for transport=mcp-stdio", () => {
    const config = {
      id: "test-engine",
      label: "Test HTTP Engine",
      transport: "mcp-stdio",
      endpoint: "npx",
    };
    const res = SearchEngineConfigSchema.safeParse(config);
    assert.strictEqual(res.success, false);
  });
});

describe("Effective Config Resolution", () => {
  test("falls back to default implicit default engine", () => {
    const effective = loadSearchConfig({}, "/non-existent-directory");
    assert.strictEqual(effective.source, "default");
    assert.strictEqual(effective.engines.length, 1);
    assert.strictEqual(effective.engines[0].id, DEFAULT_ENGINE_ID);
  });

  test("loads from search-engines.json config file", () => {
    const tmpDir = join(tmpdir(), `tc-test-${Math.random().toString(36).substring(7)}`);
    mkdirSync(tmpDir, { recursive: true });

    const configPath = join(tmpDir, "search-engines.json");
    const enginesList = [
      {
        id: "local-index",
        label: "Local",
        transport: "http",
        endpoint: "http://127.0.0.1:9000",
        enabled: true,
      },
    ];
    writeFileSync(configPath, JSON.stringify(enginesList));

    try {
      const effective = loadSearchConfig({}, tmpDir);
      assert.strictEqual(effective.source, "file");
      assert.strictEqual(effective.engines.length, 1);
      assert.strictEqual(effective.engines[0].id, "local-index");
    } finally {
      unlinkSync(configPath);
      rmdirSync(tmpDir);
    }
  });

  test("resolves environment override file path", () => {
    const tmpFile = join(tmpdir(), `engines-${Math.random().toString(36).substring(7)}.json`);
    const enginesList = [
      {
        id: "env-index",
        label: "Env",
        transport: "http",
        endpoint: "http://127.0.0.1:9090",
        enabled: true,
      },
    ];
    writeFileSync(tmpFile, JSON.stringify(enginesList));

    try {
      const effective = loadSearchConfig({ CONNECTOR_SEARCH_CONFIG: tmpFile }, "/some-other-dir");
      assert.strictEqual(effective.source, "env");
      assert.strictEqual(effective.engines.length, 1);
      assert.strictEqual(effective.engines[0].id, "env-index");
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

import { test, describe } from "node:test";
import assert from "node:assert";
import { SearchRegistry } from "../src/search-registry.js";
import type { SearchEngine } from "../src/search-engine.js";
import type { EngineSchema } from "../src/schema-cache.js";

class MockSearchEngine implements SearchEngine {
  readonly id: string;
  readonly label: string;
  readonly schema: EngineSchema;
  private isClosed = false;

  constructor(id: string, label: string, schema: EngineSchema) {
    this.id = id;
    this.label = label;
    this.schema = schema;
  }

  async search(args: Record<string, unknown>): Promise<unknown> {
    return { engine: this.id, echoedArgs: args };
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }

  getClosed(): boolean {
    return this.isClosed;
  }
}

describe("SearchRegistry", () => {
  const dummySchema = { inputSchema: { type: "object", properties: {} } };

  test("registers and retrieves engines", () => {
    const registry = new SearchRegistry();
    const e1 = new MockSearchEngine("e1", "Engine 1", dummySchema);
    const e2 = new MockSearchEngine("e2", "Engine 2", dummySchema);

    registry.register(e1);
    registry.register(e2);

    assert.strictEqual(registry.get("e1"), e1);
    assert.strictEqual(registry.get("e2"), e2);
    assert.deepStrictEqual(registry.getEngineIds(), ["e1", "e2"]);
    assert.strictEqual(registry.getAll().length, 2);
  });

  test("routes search to correct engine with pass-through", async () => {
    const registry = new SearchRegistry();
    const e1 = new MockSearchEngine("e1", "Engine 1", dummySchema);
    registry.register(e1);

    const result = await registry.search("e1", { query: "hello", limit: 5 }) as any;
    assert.strictEqual(result.engine, "e1");
    assert.deepStrictEqual(result.echoedArgs, { query: "hello", limit: 5 });
  });

  test("throws error for unknown engine", async () => {
    const registry = new SearchRegistry();
    await assert.rejects(
      async () => {
        await registry.search("unknown-id", {});
      },
      /Unknown engine: unknown-id/
    );
  });

  test("closes all registered engines", async () => {
    const registry = new SearchRegistry();
    const e1 = new MockSearchEngine("e1", "Engine 1", dummySchema);
    const e2 = new MockSearchEngine("e2", "Engine 2", dummySchema);
    registry.register(e1);
    registry.register(e2);

    await registry.closeAll();
    assert.strictEqual(e1.getClosed(), true);
    assert.strictEqual(e2.getClosed(), true);
  });
});

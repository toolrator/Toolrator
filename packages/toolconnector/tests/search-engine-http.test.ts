import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { HttpSearchEngine } from "../src/search-engine-http.js";
import { Logger, DEFAULT_ENGINE_ID } from "../src/config.js";

const PORT = 34567;
let serverInstance: any;

describe("HttpSearchEngine", () => {
  before(() => {
    const app = new Hono();

    // GET endpoint for the implicit default engine (legacy `/api/search` contract)
    app.get("/api/search", (c) => {
      const q = c.req.query("q") ?? "";
      return c.json({
        hits: [{ name: "legacy-tool", description: `Legacy for query ${q}` }]
      });
    });

    // POST endpoint for custom engines
    app.post("/custom-search", async (c) => {
      const body = await c.req.json();
      const auth = c.req.header("Authorization");
      
      if (body.secure && auth !== "Bearer secret-token") {
        return c.json({ error: "unauthorized" }, 401);
      }

      return c.json({
        engineMatched: true,
        echoedArgs: body
      });
    });

    serverInstance = serve({ fetch: app.fetch, port: PORT });
  });

  after(async () => {
    if (serverInstance) {
      await new Promise<void>((resolve) => serverInstance.close(() => resolve()));
    }
  });

  const logger = new Logger("error");
  const dummySchema = { inputSchema: { type: "object", properties: {} } };

  test("implicit-default GET adapter works", async () => {
    const config: any = {
      id: DEFAULT_ENGINE_ID,
      label: "Implicit GET Default",
      transport: "http",
      endpoint: `http://localhost:${PORT}`,
      enabled: true,
    };

    const engine = new HttpSearchEngine(config, dummySchema, logger);
    const result = await engine.search({ query: "my-query", limit: 3 }) as any;

    assert.ok(result.hits);
    assert.strictEqual(result.hits[0].name, "legacy-tool");
    assert.strictEqual(result.hits[0].description, "Legacy for query my-query");
  });

  test("custom POST pass-through search works", async () => {
    const config: any = {
      id: "custom-post-engine",
      label: "Custom Post",
      transport: "http",
      endpoint: `http://localhost:${PORT}/custom-search`,
      enabled: true,
    };

    const engine = new HttpSearchEngine(config, dummySchema, logger);
    const result = await engine.search({ foo: "bar", baz: 123 }) as any;

    assert.strictEqual(result.engineMatched, true);
    assert.deepStrictEqual(result.echoedArgs, { foo: "bar", baz: 123 });
  });

  test("custom POST passes auth headers", async () => {
    process.env.TEST_POST_TOKEN = "secret-token";
    const config: any = {
      id: "secure-post-engine",
      label: "Secure Post",
      transport: "http",
      endpoint: `http://localhost:${PORT}/custom-search`,
      auth: {
        type: "bearer",
        tokenEnv: "TEST_POST_TOKEN",
      },
      enabled: true,
    };

    const engine = new HttpSearchEngine(config, dummySchema, logger);
    const result = await engine.search({ secure: true, hello: "world" }) as any;

    assert.strictEqual(result.engineMatched, true);
    assert.strictEqual(result.echoedArgs.hello, "world");

    delete process.env.TEST_POST_TOKEN;
  });
});

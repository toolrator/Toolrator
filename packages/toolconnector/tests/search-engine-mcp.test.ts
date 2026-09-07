import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpSearchEngine } from "../src/search-engine-mcp.js";
import { Logger } from "../src/config.js";

const logger = new Logger("error");
let mockServerScriptPath: string;

describe("McpSearchEngine Stdio", () => {
  before(() => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    mockServerScriptPath = join(__dirname, `mock-mcp-server-${Math.random().toString(36).substring(7)}.js`);
    
    const scriptContent = `
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const server = new McpServer({ name: "mock-search-mcp", version: "1.0.0" });

server.registerTool(
  "search",
  {
    description: "Mock Search",
    inputSchema: z.object({
      custom_arg: z.string(),
    })
  },
  async ({ custom_arg }) => {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          mcpOutput: true,
          echoedArg: custom_arg
        })
      }]
    };
  }
);

const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  console.error(err);
  process.exit(1);
});
`;
    writeFileSync(mockServerScriptPath, scriptContent, "utf-8");
  });

  after(() => {
    try {
      unlinkSync(mockServerScriptPath);
    } catch {
      // ignore
    }
  });

  const dummySchema = { inputSchema: { type: "object", properties: {} } };

  test("runs search against standard stdio Search Engine", async () => {
    const config: any = {
      id: "mock-stdio-engine",
      label: "Mock Stdio Engine",
      transport: "mcp-stdio",
      endpoint: process.execPath,
      args: [mockServerScriptPath],
      enabled: true,
      timeoutMs: 5000,
    };

    const engine = new McpSearchEngine(config, dummySchema, logger);
    
    try {
      const result = await engine.search({ custom_arg: "mcp-stdio-query" }) as any;
      assert.strictEqual(result.mcpOutput, true);
      assert.strictEqual(result.echoedArg, "mcp-stdio-query");
    } finally {
      await engine.close();
    }
  });
});

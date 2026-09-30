import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerAllTools } from "../src/tools.js";
import { ConnectorStateManager } from "../src/state.js";
import { ExternalMcpClient } from "../src/mcp-client.js";
import { Logger } from "../src/config.js";
import { mcpCache } from "../src/mcp-client.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { OAuthStore } from "../src/oauth-store.js";
import { startMockOauthAs, type MockOauthAs } from "./mock-oauth-as.js";

let mockAs: MockOauthAs;

// ============================================================================
// Mock Upstream MCP Server Counters & Variables
// ============================================================================

const PORT = 29410;
const MOCK_AS_PORT = 29342;
const MODERN_URL = `http://127.0.0.1:${PORT}/modern`;
const LEGACY_URL = `http://127.0.0.1:${PORT}/legacy`;
const BIG_URL = `http://127.0.0.1:${PORT}/big`;

let modernDiscoverCount = 0;
let modernListCount = 0;
let legacyDiscoverCount = 0;
let legacyInitializeCount = 0;
let legacyListCount = 0;

let elicitCallCount = 0;
let lastInputResponses: any = null;
let lastRequestState: any = null;

let taskActions: string[] = [];
let lastTaskParams: any = null;

// ============================================================================
// Hono Mock Upstream Server Setup
// ============================================================================

function createMockUpstreamServer(): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    console.log(`[MOCK UPSTREAM] Request: ${c.req.method} ${c.req.url}`);
    if (c.req.method === "POST") {
      try {
        const body = await c.req.raw.clone().json();
        console.log(`[MOCK UPSTREAM] Payload: ${JSON.stringify(body)}`);
      } catch (err) {
        console.log(`[MOCK UPSTREAM] Non-JSON payload or error cloning: ${err}`);
      }
    }
    await next();
  });

  // Modern Endpoint (2026-07-28 compliant)
  app.post("/modern", async (c) => {
    const payload = await c.req.json<{ method?: string; id?: number; params?: any }>();
    const { method, id, params } = payload;

    if (method === "server/discover") {
      modernDiscoverCount++;
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          supportedVersions: ["2026-07-28"],
          capabilities: {
            tools: {},
            tasks: {
              list: {},
              cancel: {}
            }
          },
          serverInfo: { name: "mock-modern", version: "1.0.0" }
        }
      });
    }

    if (method === "tools/list") {
      modernListCount++;
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete", // Required in 2026-07-28
          tools: [
            {
              name: "elicit_tool",
              description: "A tool requiring input",
              inputSchema: { type: "object", properties: {} }
            },
            {
              name: "error_tool",
              description: "A tool returning errors",
              inputSchema: {
                type: "object",
                properties: {
                  error_type: { type: "string" }
                }
              }
            }
          ],
          ttlMs: 100, // short TTL for caching test
          cacheScope: "public"
        }
      });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === "elicit_tool") {
        elicitCallCount++;
        const inputResponses = params?.inputResponses;
        const requestState = params?.requestState;

        lastInputResponses = inputResponses;
        lastRequestState = requestState;

        if (!inputResponses || !requestState) {
          return c.json({
            jsonrpc: "2.0",
            id,
            result: {
              resultType: "input_required",
              requestState: "opaque_compliance_state",
              inputRequests: {
                user_email: {
                  type: "string",
                  description: "Email address"
                }
              }
            }
          });
        } else {
          if (requestState === "opaque_compliance_state" && inputResponses.user_email === "compliance@test.com") {
            return c.json({
              jsonrpc: "2.0",
              id,
              result: {
                resultType: "complete",
                content: [{ type: "text", text: "Elicitation Successful" }]
              }
            });
          }
          return c.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid responses" }
          });
        }
      }

      if (toolName === "error_tool") {
        const errType = args.error_type;
        if (errType === "invalid_params") {
          return c.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params" }
          });
        }
        if (errType === "header_mismatch") {
          return c.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32020, message: "Header mismatch" }
          });
        }
        if (errType === "unsupported_version") {
          return c.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32022, message: "Unsupported protocol version" }
          });
        }
      }
    }

    if (method === "custom/echo") {
      return c.json({
        jsonrpc: "2.0",
        id,
        result: { resultType: "complete", echoed: params?.value ?? null }
      });
    }

    if (method === "tasks/get") {
      taskActions.push("get");
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete", // Required in 2026-07-28
          status: "running",
          progress: 0.5
        }
      });
    }

    if (method === "tasks/update") {
      taskActions.push("update");
      lastTaskParams = params;
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete", // Required in 2026-07-28
          status: "running",
          progress: 0.9
        }
      });
    }

    if (method === "tasks/cancel") {
      taskActions.push("cancel");
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete", // Required in 2026-07-28
          status: "cancelled"
        }
      });
    }

    return c.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  });

  // Legacy Endpoint (2025-11-25 only)
  app.post("/legacy", async (c) => {
    const payload = await c.req.json<{ method?: string; id?: number; params?: any }>();
    const { method, id } = payload;

    if (method === "server/discover") {
      legacyDiscoverCount++;
      return c.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" }
      });
    }

    if (method === "initialize") {
      legacyInitializeCount++;
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-legacy", version: "1.0.0" }
        }
      });
    }

    if (method === "notifications/initialized") {
      return c.json({ jsonrpc: "2.0", result: null });
    }

    if (method === "tools/list") {
      legacyListCount++;
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "legacy_tool",
              description: "A legacy tool",
              inputSchema: { type: "object" }
            }
          ]
        }
      });
    }

    return c.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" }
    });
  });

  // Big Endpoint (8 tools, no TTL — for transparent summarization test)
  app.post("/big", async (c) => {
    const payload = await c.req.json<{ method?: string; id?: number; params?: any }>();
    const { method, id } = payload;

    if (method === "server/discover") {
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          serverInfo: { name: "mock-big", version: "1.0.0" }
        }
      });
    }

    if (method === "tools/list") {
      const tools = Array.from({ length: 8 }, (_, i) => ({
        name: `big_tool_${i + 1}`,
        description: `Big tool ${i + 1}`,
        inputSchema: {
          type: "object",
          properties: { param_a: { type: "string" } },
          required: ["param_a"]
        }
      }));
      return c.json({
        jsonrpc: "2.0",
        id,
        result: { resultType: "complete", tools, ttlMs: 0, cacheScope: "public" }
      });
    }

    return c.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  });

  return app;
}

describe("MCP Feature Compliance Test Suite", () => {
  let mockServer: any;
  let tempConfigDir: string;
  let toolconnectorServer: McpServer;
  let client: Client;

  before(async () => {
    // 1. Start Upstream Server
    const app = createMockUpstreamServer();
    mockServer = serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: PORT
    });

    // 2. Set up Config & State Manager
    tempConfigDir = await mkdtemp(path.join(tmpdir(), "tc-compliance-"));
    const logger = new Logger("debug");
    const stateManager = new ConnectorStateManager(logger);
    await stateManager.init(tempConfigDir, "");

    // 3. Set up clients and registered tools bridge
    // Mock OAuth 2.1 AS for the device-grant E2E (login = fully logged in).
    mockAs = await startMockOauthAs(MOCK_AS_PORT);

    const externalClient = new ExternalMcpClient(logger);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    toolconnectorServer = new McpServer({ name: "toolconnector-compliance", version: "0.1.0" });
    // Set up search config & registry for registerAllTools
    const { loadSearchConfig } = await import("../src/search-config.js");
    const { createSearchEngine } = await import("../src/search-engines.js");
    const { SearchRegistry } = await import("../src/search-engines.js");
    const { DEFAULT_SCHEMA } = await import("../src/schema-cache.js");

    const searchConfig = loadSearchConfig({}, tempConfigDir);
    const registry = new SearchRegistry();
    for (const c of searchConfig.engines) {
      if (c.enabled !== false) {
        registry.register(createSearchEngine(c, DEFAULT_SCHEMA, logger));
      }
    }

    registerAllTools(
      toolconnectorServer,
      stateManager,
      registry,
      externalClient,
      tempConfigDir,
      logger,
      undefined,
      // onRefreshSearchConfig: API-key re-pull (unused in these tests).
      async () => false,
      // onOAuthLogin: the post-login config re-pull. Simulated success so the
      // device-grant E2E below can assert the full "login = configured" path.
      async () => true
    );

    await toolconnectorServer.connect(serverTransport);
    client = new Client({ name: "mock-compliance-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  after(async () => {
    await client.close();
    await toolconnectorServer.close();
    mockServer.close();
    await mockAs.close().catch(() => {});
    await rm(tempConfigDir, { recursive: true, force: true });
  });

  // --- 1. Version Negotiation & Fallback ---

  test("negotiate modern 2026-07-28 protocol via server/discover", async () => {
    modernDiscoverCount = 0;
    const res = await client.callTool({
      name: "mcp_server",
      arguments: { target: MODERN_URL, method: "tools/list" }
    });
    assert(modernDiscoverCount === 1, "Expected exactly 1 modern discovery probe request");
    assert(JSON.stringify(res).includes("elicit_tool"), "Expected elicit_tool in inspected tools list");
  });

  test("negotiate legacy 2025-11-25 protocol via initialize fallback", async () => {
    legacyDiscoverCount = 0;
    legacyInitializeCount = 0;
    const res = await client.callTool({
      name: "mcp_server",
      arguments: { target: LEGACY_URL, method: "tools/list" }
    });
    assert(legacyDiscoverCount === 1, "Expected exactly 1 legacy discovery probe request (fail)");
    assert(legacyInitializeCount === 1, "Expected exactly 1 legacy initialize request (fallback)");
    assert(JSON.stringify(res).includes("legacy_tool"), "Expected legacy_tool in inspected tools list");
  });

  // --- 2. Response Caching ---

  test("listTools caching honours the server's ttlMs", async () => {
    mcpCache.clear();
    modernListCount = 0;

    // Call 1: hits server
    await client.callTool({
      name: "mcp_server",
      arguments: { target: MODERN_URL, method: "tools/list" }
    });
    assert(modernListCount === 1, "First listTools call must hit the mock server");

    // Call 2: hits cache
    await client.callTool({
      name: "mcp_server",
      arguments: { target: MODERN_URL, method: "tools/list" }
    });
    assert(modernListCount === 1, "Second listTools call must be answered from cache, not mock server");

    // Wait for TTL (100ms) to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Call 3: cache expired, hits server
    await client.callTool({
      name: "mcp_server",
      arguments: { target: MODERN_URL, method: "tools/list" }
    });
    assert((modernListCount as number) === 2, "Third listTools call after TTL expiration must hit mock server again");
  });

  // --- 3. Elicitation / Multi Round-Trip (MRTR) ---

  test("mcp_server tools/call handles resultType input_required and retries with inputs", async () => {
    elicitCallCount = 0;
    lastInputResponses = null;
    lastRequestState = null;

    // Round 1: Call without elicitation responses
    const res1 = await client.callTool({
      name: "mcp_server",
      arguments: {
        target: MODERN_URL,
        method: "tools/call",
        params: { name: "elicit_tool", arguments: {} }
      }
    });

    const body1 = JSON.parse((res1 as any).content[0].text);
    assert(body1.result.resultType === "input_required", "Expected input_required result type");
    assert(body1.result.requestState === "opaque_compliance_state", "Expected requestState from server");
    assert(body1.result.inputRequests?.user_email, "Expected inputRequests definition");
    assert(elicitCallCount === 1, "Upstream mock server must receive exactly 1 call");

    // Round 2: Call back with inputResponses and requestState
    const res2 = await client.callTool({
      name: "mcp_server",
      arguments: {
        target: MODERN_URL,
        method: "tools/call",
        params: {
          name: "elicit_tool",
          arguments: {},
          requestState: body1.result.requestState,
          inputResponses: { user_email: "compliance@test.com" }
        }
      }
    });

    const body2 = JSON.parse((res2 as any).content[0].text);
    assert(!body2.result.resultType || body2.result.resultType === "complete", "Expected complete result type");
    assert(body2.result.content[0].text === "Elicitation Successful", "Expected successful message");
    assert((elicitCallCount as number) === 2, "Upstream mock server must receive a second call on retry");
    assert(lastRequestState === "opaque_compliance_state", "Expected requestState passed to upstream server");
    assert(lastInputResponses?.user_email === "compliance@test.com", "Expected inputResponses passed to upstream server");
  });

  // --- 4. Tasks Extension ---

  test("mcp_server tasks/* methods propagate get, update, cancel calls", async () => {
    taskActions = [];
    lastTaskParams = null;

    // Get
    const resGet = await client.callTool({
      name: "mcp_server",
      arguments: {
        target: MODERN_URL,
        method: "tasks/get",
        params: { taskId: "test_task_123" }
      }
    });
    const bodyGet = JSON.parse((resGet as any).content[0].text);
    assert(bodyGet.result.status === "running" && bodyGet.result.progress === 0.5, "Expected task status running (0.5)");

    // Update
    const resUpdate = await client.callTool({
      name: "mcp_server",
      arguments: {
        target: MODERN_URL,
        method: "tasks/update",
        params: { taskId: "test_task_123", progress_override: 0.9 }
      }
    });
    const bodyUpdate = JSON.parse((resUpdate as any).content[0].text);
    assert(bodyUpdate.result.status === "running" && bodyUpdate.result.progress === 0.9, "Expected task status running (0.9)");
    assert(lastTaskParams?.progress_override === 0.9, "Expected update payload passed flat on params");

    // Cancel
    const resCancel = await client.callTool({
      name: "mcp_server",
      arguments: {
        target: MODERN_URL,
        method: "tasks/cancel",
        params: { taskId: "test_task_123" }
      }
    });
    const bodyCancel = JSON.parse((resCancel as any).content[0].text);
    assert(bodyCancel.result.status === "cancelled", "Expected task status cancelled");

    assert(taskActions.length === 3, "Expected 3 total task operations executed");
    assert(taskActions[0] === "get", "First operation should be get");
    assert(taskActions[1] === "update", "Second operation should be update");
    assert(taskActions[2] === "cancel", "Third operation should be cancel");
  });

  // --- 5. Error Code Classifications ---

  test("mcp_server tools/call maps -32602 to resource_not_found", async () => {
    const res = await client.callTool({
      name: "mcp_server",
      arguments: {
        target: MODERN_URL,
        method: "tools/call",
        params: { name: "error_tool", arguments: { error_type: "invalid_params" } }
      }
    });
    assert(res.isError === true, "Expected tool execution to report error");
    const structErr = JSON.parse((res as any).content[0].text);
    assert(structErr.error_code === "resource_not_found", `Expected resource_not_found, got: ${structErr.error_code}`);
  });

  test("mcp_server tools/call maps -32020 to header_mismatch", async () => {
    const res = await client.callTool({
      name: "mcp_server",
      arguments: {
        target: MODERN_URL,
        method: "tools/call",
        params: { name: "error_tool", arguments: { error_type: "header_mismatch" } }
      }
    });
    assert(res.isError === true, "Expected tool execution to report error");
    const structErr = JSON.parse((res as any).content[0].text);
    assert(structErr.error_code === "header_mismatch", `Expected header_mismatch, got: ${structErr.error_code}`);
  });

  test("mcp_server tools/call maps -32022 to unsupported_protocol_version", async () => {
    const res = await client.callTool({
      name: "mcp_server",
      arguments: {
        target: MODERN_URL,
        method: "tools/call",
        params: { name: "error_tool", arguments: { error_type: "unsupported_version" } }
      }
    });
    assert(res.isError === true, "Expected tool execution to report error");
    const structErr = JSON.parse((res as any).content[0].text);
    assert(structErr.error_code === "unsupported_protocol_version", `Expected unsupported_protocol_version, got: ${structErr.error_code}`);
  });

  // --- 6. Generic Passthrough ---

  test("mcp_server blocks protocol plumbing methods (initialize, ping, notifications/*)", async () => {
    modernDiscoverCount = 0;

    const resInit = await client.callTool({
      name: "mcp_server",
      arguments: { target: MODERN_URL, method: "initialize", params: {} }
    });
    assert(resInit.isError === true, "Expected initialize to be rejected");
    const errInit = JSON.parse((resInit as any).content[0].text);
    assert(errInit.error_code === "execution_failed", "Expected structured error");
    assert(errInit.reason.includes("protocol plumbing"), "Expected reason to explain the block");

    const resPing = await client.callTool({
      name: "mcp_server",
      arguments: { target: MODERN_URL, method: "ping" }
    });
    assert(resPing.isError === true, "Expected ping to be rejected");

    const resNotif = await client.callTool({
      name: "mcp_server",
      arguments: { target: MODERN_URL, method: "notifications/initialized" }
    });
    assert(resNotif.isError === true, "Expected notifications/* to be rejected");

    assert(modernDiscoverCount === 0, "Blocked methods must never reach the upstream server");
  });

  test("mcp_server forwards unknown app-level methods raw (custom/echo)", async () => {
    const res = await client.callTool({
      name: "mcp_server",
      arguments: {
        target: MODERN_URL,
        method: "custom/echo",
        params: { value: 42 }
      }
    });
    assert(res.isError !== true, "Expected custom/echo to succeed");
    const body = JSON.parse((res as any).content[0].text);
    assert(body.method === "custom/echo", "Expected method echoed in envelope");
    assert(body.result.echoed === 42, `Expected raw result echoed, got: ${JSON.stringify(body.result)}`);
  });

  test("mcp_server transparently summarizes tools/list when more than 6 tools", async () => {
    const res = await client.callTool({
      name: "mcp_server",
      arguments: { target: BIG_URL, method: "tools/list" }
    });
    assert(res.isError !== true, "Expected tools/list to succeed");
    const body = JSON.parse((res as any).content[0].text);
    assert(body.summarized === true, "Expected summarized flag");
    assert(body.result.tools.length === 8, "Expected 8 summarized tools");
    assert(typeof body.result.tools[0].param_hint === "string", "Expected param_hint on summarized tools");
    assert(body.result.tools[0].input_schema === undefined, "Expected input_schema stripped in summary");
    assert(body.result.tools[0].param_hint.includes("(required)"), "Expected required marker in param_hint");
  });

  test("mcp_server missing method is rejected by the schema", async () => {
    const res = await client.callTool({
      name: "mcp_server",
      arguments: { target: MODERN_URL }
    });
    assert(res.isError === true, "Expected missing method to error");
    const text = (res as any).content[0].text;
    assert(text.includes("method"), "Expected error text to mention method");
  });

  // --- manage_auth action surface ---

  test("manage_auth offers every action regardless of auth state", async () => {
    // The action enum is STATIC (6 OAuth 2.1 actions): hosts cache tool
    // schemas and many ignore tools/list_changed, so any state-derived enum
    // goes stale by construction. The legacy API-key device-flow actions
    // (start_device_flow / poll_device_flow) were removed.
    const { tools } = await client.listTools();
    const manageAuth = tools.find((t) => t.name === "manage_auth");
    assert(manageAuth, "Expected manage_auth to be registered");

    const action = (manageAuth.inputSchema as any).properties.action;
    const allowed: string[] = action.enum;
    for (const expected of [
      "status",
      "logout",
      "oauth_status",
      "oauth_logout",
      "start_oauth",
      "complete_oauth",
    ]) {
      assert(
        allowed.includes(expected),
        `Expected '${expected}' in manage_auth action enum, got: ${allowed.join(", ")}`
      );
    }
    for (const removed of ["start_device_flow", "poll_device_flow"]) {
      assert(
        !allowed.includes(removed),
        `Legacy action '${removed}' must no longer be offered`
      );
    }
  });

  test("oauth_logout on a session with no stored tokens is a clean no-op", async () => {
    // The handler must stay total now that the action is always reachable.
    const res = await client.callTool({
      name: "manage_auth",
      arguments: { action: "oauth_logout" }
    });
    assert(res.isError !== true, "Expected oauth_logout to succeed with an empty store");
    const text = (res as any).content[0].text;
    assert(
      text.includes("No OAuth connections") || text.includes("Removed"),
      `Expected a clear no-op message, got: ${text}`
    );
  });

  // --- OAuth 2.1 end-to-end (RFC 8628 device grant) ---
  // Regression lock for the migration goal: a login made THROUGH the
  // connector is a full login — unified state, credential domain, and the
  // account search-config re-pull all fire.

  test("OAuth device-grant login flips unified state and applies config", async () => {
    // Precondition: anonymous before the flow.
    let res = await client.callTool({
      name: "manage_auth",
      arguments: { action: "status" },
    });
    let status = JSON.parse((res as any).content[0].text);
    assert.equal(status.authenticated, false, "precondition: anonymous before login");

    // 1. start_oauth → device grant against the mock AS.
    res = await client.callTool({
      name: "manage_auth",
      arguments: { action: "start_oauth", target: `${mockAs.baseUrl}/mcp` },
    });
    assert(res.isError !== true, `start_oauth failed: ${(res as any).content[0].text}`);
    const startText = (res as any).content[0].text as string;
    assert.match(startText, /Open this URL in a browser/, "device-grant instructions returned");

    // 2. Extract the user code and approve it (browser stand-in). The mock
    // AS advertises verification_uri_complete, so the code rides in the URL
    // (?code=…); a bare verification_uri would carry a separate Code: line.
    const codeMatch = startText.match(/code=([A-Z0-9-]+)/) ?? startText.match(/Code:\s*([A-Z0-9-]+)/);
    assert.ok(codeMatch, `user code not found in instructions: ${startText}`);
    assert.ok(mockAs.approveDeviceGrant(codeMatch[1]), "device grant approved");

    // 3. The connector's background poller (1s cadence against the mock)
    // completes the exchange and flips the unified state.
    const deadline = Date.now() + 15_000;
    do {
      await new Promise((r) => setTimeout(r, 500));
      res = await client.callTool({
        name: "manage_auth",
        arguments: { action: "status" },
      });
      status = JSON.parse((res as any).content[0].text);
    } while (status.authenticated !== true && Date.now() < deadline);

    assert.equal(status.authenticated, true, "OAuth login = authenticated (unified state)");
    assert.equal(status.credential, "oauth_token", "credential domain is oauth_token");
    assert.equal(status.cloud_verified, true, "config re-pull ran with the OAuth token");
    assert.equal(status.search_config_source, "remote", "remote search config applied");

    // 4. oauth_status lists the stored connection.
    res = await client.callTool({
      name: "manage_auth",
      arguments: { action: "oauth_status" },
    });
    const oauthStatus = JSON.parse((res as any).content[0].text);
    assert.ok(oauthStatus.oauth_connections.length >= 1, "stored OAuth connection listed");
    assert.equal(oauthStatus.oauth_connections[0].target, `${mockAs.baseUrl}/mcp`);
  });

  test("logout clears BOTH credential domains", async () => {
    const res = await client.callTool({
      name: "manage_auth",
      arguments: { action: "logout" },
    });
    assert(res.isError !== true, `logout failed: ${(res as any).content[0].text}`);
    assert.match((res as any).content[0].text, /API key and OAuth tokens cleared/);

    // No OAuth entries survive logout.
    const entries = await new OAuthStore(tempConfigDir).allEntries();
    assert.equal(entries.length, 0, "OAuth store empty after logout");

    const statusRes = await client.callTool({
      name: "manage_auth",
      arguments: { action: "status" },
    });
    const parsed = JSON.parse((statusRes as any).content[0].text);
    assert.equal(parsed.authenticated, false, "back to anonymous");
  });
});

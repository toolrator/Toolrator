/**
 * Toolconnector E2E Test Suite
 *
 * Runs using the native node:test runner and standard asserts.
 * Spins up the infrastructure in-process:
 *   1. Mock MCP Server (external upstream target)
 *   2. Mock Auth Simulator (device flow)
 *
 * Exercises target resolution, structured-error classification, external tool
 * execution, device-flow authentication, and favorites. Toolconnector connects
 * directly to external MCP servers and authenticates against the configured
 * upstream backend (the same contract toolpanel implements).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { serve } from "@hono/node-server";

// Toolconnector modules under test
import { Logger } from "../src/config.js";
import { ConnectorStateManager, schemaTimestamps } from "../src/state.js";
import { AuthClient } from "../src/auth-client.js";
import { ExternalMcpClient } from "../src/external-client.js";
import * as descriptions from "../src/descriptions.js";
import * as favorites from "../src/favorites.js";
import { resolveTarget, resolveTargetAsync } from "../src/target-resolver.js";
import { classifyUpstreamError } from "../src/errors.js";

// Mock auth server
import { startMockAuthServer } from "./mock-auth-sim.js";

// ============================================================================
// Configuration Constants
// ============================================================================

const UPSTREAM_PORT = 29321;
const AUTH_PORT = 29310;
const USER_ACTIVE_TOKEN = "tc-test-user-key";

// ============================================================================
// Mock MCP Server (minimal external upstream)
// ============================================================================

function createMockUpstreamApp(): Hono {
  const app = new Hono();

  app.post("/mcp", async (c) => {
    const payload = await c.req.json<{ method?: string; id?: number; params?: any }>();

    if (payload.method === "initialize") {
      const sessionId = `sess-${Math.random().toString(36).substring(2, 10)}`;
      c.header("Mcp-Session-Id", sessionId);
      c.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
      return c.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "Mock-Upstream", version: "1.0.0" },
        },
      });
    }

    if (payload.method === "notifications/initialized") {
      return c.json({ jsonrpc: "2.0", result: null });
    }

    if (payload.method === "tools/list") {
      return c.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echoes input",
              inputSchema: {
                type: "object",
                properties: {
                  hello: { type: "string" },
                  verbose: { type: "boolean" },
                },
              },
            },
          ],
        },
      });
    }

    if (payload.method === "tools/call") {
      const name = payload.params?.name;
      if (name === "echo") {
        const authHeader = c.req.header("Authorization");
        return c.json({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            content: [{
              type: "text",
              text: `Echo: ${JSON.stringify(payload.params?.arguments ?? {})}${authHeader ? ` [Auth: ${authHeader}]` : ""}`
            }],
          },
        });
      }
      return c.json({
        jsonrpc: "2.0",
        id: payload.id,
        error: { code: -32601, message: `Tool not found: ${name}` },
      });
    }

    return c.json({
      jsonrpc: "2.0",
      id: payload.id,
      error: { code: -32601, message: `Method not found: ${payload.method}` },
    });
  });

  return app;
}

// ============================================================================
// Main Suite
// ============================================================================

describe("Toolconnector E2E Test Suite", () => {
  let upstreamServer: any;
  let authSim: any;
  let tempConfigDir: string;

  let logger: Logger;
  let stateManager: ConnectorStateManager;
  let authClient: AuthClient;
  let externalClient: ExternalMcpClient;

  let deviceCode = "";
  let userCode = "";

  before(async () => {
    // 1. Mock Upstream MCP Server
    const upstreamApp = createMockUpstreamApp();
    upstreamServer = serve({
      fetch: upstreamApp.fetch,
      hostname: "127.0.0.1",
      port: UPSTREAM_PORT,
    });

    // 2. Mock Auth Simulator (upstream auth / device flow)
    authSim = await startMockAuthServer(AUTH_PORT, USER_ACTIVE_TOKEN);

    // Create temp dir for credential storage
    tempConfigDir = await mkdtemp(path.join(tmpdir(), "tc-test-"));

    // Create Toolconnector Components
    logger = new Logger("debug");
    stateManager = new ConnectorStateManager(logger);
    authClient = new AuthClient(authSim.baseUrl, authSim.baseUrl, logger);
    externalClient = new ExternalMcpClient(logger);

    // Initialize as anonymous (no env key, no saved creds)
    await stateManager.init(tempConfigDir, "");
  });

  after(async () => {
    try {
      await rm(tempConfigDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    await new Promise<void>((res, rej) => upstreamServer.close((e?: Error) => e ? rej(e) : res()));
    await authSim.close();
  });

  // =========================================================================
  // 1. Target Resolver Tests
  // =========================================================================

  test("resolveTarget returns external for http/https URLs", () => {
    const res = resolveTarget("http://127.0.0.1:8080/mcp");
    assert(res.kind === "direct_http", "Expected direct_http kind");
    assert(res.url === "http://127.0.0.1:8080/mcp", "Expected URL match");
    assert(res.trustLevel === "external_connection", "Expected external_connection");
  });

  test("resolveTargetAsync auto-resolves Smithery registry URLs to deploymentUrl", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          deploymentUrl: "https://calculator-mcp-test--aitutor3.run.tools",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const res = await resolveTargetAsync(
      "https://registry.smithery.ai/servers/AITutor3/calculator-mcp-test",
      mockFetch as any,
    );
    assert(res.kind === "direct_http");
    assert(res.url === "https://calculator-mcp-test--aitutor3.run.tools");
    assert(res.originalTarget === "https://registry.smithery.ai/servers/AITutor3/calculator-mcp-test");
  });

  // =========================================================================
  // 2. Structured Errors Tests
  // =========================================================================

  test("classifyUpstreamError returns correct error types", () => {
    const e401 = classifyUpstreamError(401, "unauthorized", { target: "x" });
    assert(e401.error_code === "auth_required", "401 should map to auth_required");

    const e404 = classifyUpstreamError(404, "not found", { target: "x" });
    assert(e404.error_code === "server_not_found", "404 should map to server_not_found");
  });

  // =========================================================================
  // 3. External Tool Execution
  // =========================================================================

  test("execute tool on external MCP server succeeds", async () => {
    const upstreamUrl = `http://127.0.0.1:${UPSTREAM_PORT}/mcp`;
    const result = await externalClient.callTool(upstreamUrl, "echo", { hello: "world" });
    const content = result as { content: { type: string; text: string }[] };
    assert(content.content[0].text.includes("world"), "Expected echo content");
  });

  test("execute tool on external MCP server with custom headers forwards headers", async () => {
    const upstreamUrl = `http://127.0.0.1:${UPSTREAM_PORT}/mcp`;
    const result = await externalClient.callTool(
      upstreamUrl,
      "echo",
      { hello: "world" },
      undefined,
      undefined,
      { Authorization: "Bearer test-secret-token" },
    );
    const content = result as { content: { type: string; text: string }[] };
    assert(content.content[0].text.includes("[Auth: Bearer test-secret-token]"), "Expected echoed auth header");
  });

  test("schemaTimestamps starts in sync so no false warning is triggered", () => {
    assert(schemaTimestamps.lastUpdated <= schemaTimestamps.lastFetched, "Initial state should not be outdated");
  });

  test("account starts anonymous", () => {
    const state = stateManager.getState();
    assert(state.authState === "anonymous", `Expected anonymous, got ${state.authState}`);
  });

  test("mcp_server description shows anonymous", () => {
    const desc = descriptions.describeMcpServer(stateManager.getState());
    assert(desc.includes("anonymous mode"), `Expected anonymous info in: ${desc}`);
  });

  // =========================================================================
  // 4. Device Flow Authentication
  // =========================================================================

  test("startDeviceFlow returns codes and verification URL", async () => {
    const flow = await authClient.startDeviceFlow();
    assert(flow.device_code, "Expected device_code");
    assert(flow.user_code === "TEST-1234", `Expected user code TEST-1234, got: ${flow.user_code}`);
    assert(flow.verification_uri.includes("/device"), "Expected verification URI");

    deviceCode = flow.device_code;
    userCode = flow.user_code;
    stateManager.beginDeviceFlow(deviceCode, userCode, flow.verification_uri, flow.expires_in);
  });

  test("auth state is device_flow_pending", () => {
    const state = stateManager.getState();
    assert(state.authState === "device_flow_pending", "Expected device_flow_pending");
    assert(state.userCode === "TEST-1234", "Expected userCode saved");
  });

  test("polling pending device flow returns pending status", async () => {
    const status = await authClient.pollDeviceFlow(deviceCode);
    assert(status.status === "pending", `Expected pending status, got: ${status.status}`);
  });

  test("confirm device flow via simulator success", async () => {
    const res = await fetch(`${authSim.baseUrl}/api/auth/device/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });
    assert(res.ok, "Expected confirmation response to be OK");
    const json = await res.json() as { success: boolean };
    assert(json.success === true, "Expected success: true");
  });

  test("polling confirmed device flow returns success and API key", async () => {
    const status = await authClient.pollDeviceFlow(deviceCode);
    assert(status.status === "success", "Expected success status");
    assert(status.api_key === USER_ACTIVE_TOKEN, "Expected active api key");
    assert(status.email === "test@example.com", "Expected email address");

    authClient.setApiKey(status.api_key!);
    await stateManager.completeAuthentication(
      tempConfigDir,
      status.api_key!,
      status.email || "",
    );
  });

  test("auth state is now authenticated", () => {
    const state = stateManager.getState();
    assert(state.authState === "authenticated", "Expected state to be authenticated");
    assert(state.email === "test@example.com", "Expected email");
  });

  // =========================================================================
  // 5. Favorites & Bookmark Operations
  // =========================================================================

  test("addFavorite bookmarks an external MCP server with notes", async () => {
    const upstreamUrl = `http://127.0.0.1:${UPSTREAM_PORT}/mcp`;
    await favorites.addFavorite(tempConfigDir, upstreamUrl, "Awesome server", logger);
    const list = await favorites.loadFavorites(tempConfigDir, logger);
    assert(list.length === 1, "Expected 1 favorite");
    assert(list[0].mcpNameOrUrl === upstreamUrl, "Expected name match");
    assert(list[0].notes === "Awesome server", "Expected notes match");
  });

  test("error classifies with injected memory_note on failure", () => {
    const e = classifyUpstreamError(500, "internal error", {
      target: `http://127.0.0.1:${UPSTREAM_PORT}/mcp`,
      memory_note: "Awesome server",
    });
    assert(e.memory_note === "Awesome server", "Expected memory_note to be injected");
  });

  test("removeFavorite deletes bookmark", async () => {
    const upstreamUrl = `http://127.0.0.1:${UPSTREAM_PORT}/mcp`;
    const removed = await favorites.removeFavorite(tempConfigDir, upstreamUrl, logger);
    assert(removed === true, "Expected true");
    const list = await favorites.loadFavorites(tempConfigDir, logger);
    assert(list.length === 0, "Expected 0 favorites left");
  });

  // =========================================================================
  // 6. Logout
  // =========================================================================

  test("logout returns to anonymous mode", async () => {
    authClient.clearApiKey();
    await stateManager.logout(tempConfigDir);
    const state = stateManager.getState();
    assert(state.authState === "anonymous", "Expected authState to be anonymous");
  });
});

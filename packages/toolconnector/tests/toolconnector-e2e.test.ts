/**
 * Toolconnector E2E Test Suite
 *
 * Runs using the native node:test runner and standard asserts.
 * Spins up the infrastructure in-process:
 *   1. Mock MCP Server (external upstream target)
 *
 * Exercises target resolution, structured-error classification, external tool
 * execution, and the unified credential state model (API key / OAuth token).
 * Interactive login is OAuth 2.1 (oauth-client.test.ts covers it against a
 * mock AS); this suite covers the API-key domain and state transitions.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";

import { Hono } from "hono";
import { serve } from "@hono/node-server";

// Toolconnector modules under test
import { Logger } from "../src/config.js";
import { ConnectorStateManager, schemaTimestamps } from "../src/state.js";
import { ExternalMcpClient } from "../src/mcp-client.js";
import * as descriptions from "../src/descriptions.js";
import { resolveTarget, resolveTargetAsync } from "../src/mcp-client.js";
import { classifyUpstreamError } from "../src/errors.js";

// ============================================================================
// Configuration Constants
// ============================================================================

const UPSTREAM_PORT = 29321;
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
  let tempConfigDir: string;

  let logger: Logger;
  let stateManager: ConnectorStateManager;
  let externalClient: ExternalMcpClient;

  before(async () => {
    // 1. Mock Upstream MCP Server
    const upstreamApp = createMockUpstreamApp();
    upstreamServer = serve({
      fetch: upstreamApp.fetch,
      hostname: "127.0.0.1",
      port: UPSTREAM_PORT,
    });

    // Create temp dir for credential storage
    tempConfigDir = await mkdtemp(path.join(tmpdir(), "tc-test-"));

    // Create Toolconnector Components
    logger = new Logger("debug");
    stateManager = new ConnectorStateManager(logger);
    externalClient = new ExternalMcpClient(logger);

    // Initialize as anonymous (no env key, no saved creds)
    await stateManager.init(tempConfigDir, "");
  });

  after(async () => {
    try {
      await rm(tempConfigDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    await new Promise<void>((res, rej) => upstreamServer.close((e?: Error) => e ? rej(e) : res()));
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
  // 4. Unified Credential State (API-key domain; OAuth is covered against the
  // mock AS in mcp-features-compliance.test.ts and oauth-client.test.ts)
  // =========================================================================

  test("API-key login marks authenticated with the api_key domain", async () => {
    // Seed the API-key credential the way a real install holds one: a
    // credentials.json in the config dir, then a boot read. This is the actual
    // production path (ConnectorStateManager.init, Priority 2) — since the
    // legacy device flow was removed, nothing in the connector *writes* this
    // file any more, so the boot read is the only way an API key is adopted.
    await writeFile(
      join(tempConfigDir, "credentials.json"),
      JSON.stringify({
        api_key: USER_ACTIVE_TOKEN,
        email: "test@example.com",
        saved_at: new Date().toISOString(),
      }),
      "utf-8",
    );
    await stateManager.init(tempConfigDir, "");

    const state = stateManager.getState();
    assert(state.authState === "authenticated", "Expected state to be authenticated");
    assert(state.credentialType === "api_key", "Expected api_key domain");
    assert(state.email === "test@example.com", "Expected email");
  });

  test("describeManageAuth reflects the api_key domain", () => {
    const desc = descriptions.describeManageAuth(stateManager.getState());
    assert(desc.includes("Logged in as test@example.com"), `Expected key-domain text in: ${desc}`);
    assert(!desc.includes("start_device_flow"), "legacy action must not appear");
  });

  test("boot init from stored OAuth tokens marks authenticated (unified state)", async () => {
    // Fresh state manager over a config dir holding an OAuth entry only.
    const oauthDir = await mkdtemp(path.join(tmpdir(), "tc-oauthboot-"));
    try {
      await writeFile(
        join(oauthDir, "oauth-tokens.json"),
        // Store file shape: { entries: OAuthEntry[] } (see OAuthStore.allEntries).
        JSON.stringify({
          entries: [
            {
              issuer: "https://as.example.com",
            target: "https://as.example.com/mcp",
            clientId: "https://toolrator.org/.well-known/oauth-client/toolconnector.json",
            tokens: { access_token: "at_test", refresh_token: "rt_test", scope: "profile:read" },
            savedAt: new Date().toISOString(),
            },
          ],
        }),
        "utf-8",
      );

      const bootManager = new ConnectorStateManager(logger);
      await bootManager.init(oauthDir, "");
      const state = bootManager.getState();
      assert(state.authState === "authenticated", "OAuth-only boot must be authenticated");
      assert(state.credentialType === "oauth_token", "Expected oauth_token domain");
    } finally {
      await rm(oauthDir, { recursive: true, force: true });
    }
  });

  test("boot init from CONNECTOR_API_KEY env still wins (Priority 1)", async () => {
    const envManager = new ConnectorStateManager(logger);
    await envManager.init(tempConfigDir, "sk-env-key");
    const state = envManager.getState();
    assert(state.authState === "authenticated", "env key authenticates");
    assert(state.credentialType === "api_key", "Expected api_key domain");
  });

  // =========================================================================
  // 5. Logout
  // =========================================================================

  test("logout returns to anonymous mode", async () => {
    await stateManager.logout(tempConfigDir);
    const state = stateManager.getState();
    assert(state.authState === "anonymous", "Expected authState to be anonymous");
  });
});

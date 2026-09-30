import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerAllTools } from "../src/tools.js";
import { ConnectorStateManager } from "../src/state.js";
import { ExternalMcpClient } from "../src/mcp-client.js";
import { Logger } from "../src/config.js";
import { SearchRegistry } from "../src/search-engines.js";

/**
 * `manage_auth action="status"` must re-pull the remote search-engine config
 * whenever the connector holds a usable credential — not only when an API key
 * is present.
 *
 * Regression: authState tracks ONLY the API key, so the refresh was gated on
 * `authState === "authenticated" && apiKey`. In an OAuth-only session (the
 * normal case after `start_oauth`) that never held, so status never refreshed
 * and changes made at toolrator.org/mcp after login never reached the connector
 * — even though the tool's own description promised they would.
 */

const ISSUER = "http://127.0.0.1:3000";
const ACCESS_TOKEN = "stored-oauth-access-token";

/** Boot a connector over an in-memory transport, with the config hooks wired. */
async function bootConnector(
  configDir: string,
  hooks: {
    onRefreshSearchConfig?: (apiKey?: string) => Promise<boolean>;
    onOAuthLogin?: (accessToken: string) => Promise<boolean>;
  },
) {
  const logger = new Logger("error");
  const stateManager = new ConnectorStateManager(logger);
  // No API key: this is the OAuth-only session under test.
  await stateManager.init(configDir, "");

  const externalClient = new ExternalMcpClient(logger, configDir);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "toolconnector-status-test", version: "0.1.0" });

  registerAllTools(
    server,
    stateManager,
    new SearchRegistry(),
    externalClient,
    configDir,
    logger,
    undefined,
    hooks.onRefreshSearchConfig,
    hooks.onOAuthLogin,
  );

  await server.connect(serverTransport);
  const client = new Client({ name: "status-test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server, stateManager };
}

async function seedOAuthEntry(configDir: string, accessToken: string | null) {
  const entries = accessToken
    ? [
        {
          issuer: ISSUER,
          target: `${ISSUER}/mcp`,
          clientId: "https://toolrator.org/.well-known/oauth-client/toolconnector.json",
          clientInformation: { client_id: "https://toolrator.org/.well-known/oauth-client/toolconnector.json" },
          tokens: { access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: "engines:read" },
          expiresAt: Date.now() + 3_600_000,
          savedAt: new Date().toISOString(),
        },
      ]
    : [];
  await writeFile(path.join(configDir, "oauth-tokens.json"), JSON.stringify({ entries }), "utf8");
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "tc-oauth-status-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("status re-pulls with the stored OAuth token when there is no API key", async () => {
  await withTempDir(async (dir) => {
    await seedOAuthEntry(dir, ACCESS_TOKEN);

    const seen: { apiKey?: string; oauthToken?: string } = {};
    const { client, server } = await bootConnector(dir, {
      onRefreshSearchConfig: async (apiKey) => {
        seen.apiKey = apiKey;
        return true;
      },
      onOAuthLogin: async (accessToken) => {
        seen.oauthToken = accessToken;
        return true;
      },
    });

    try {
      const res = await client.callTool({ name: "manage_auth", arguments: { action: "status" } });
      assert.notEqual(res.isError, true, "status should not error");

      assert.equal(
        seen.oauthToken,
        ACCESS_TOKEN,
        "status must refresh using the stored OAuth access token"
      );
      assert.equal(seen.apiKey, undefined, "no API key exists in this session");

      const payload = JSON.parse((res as any).content[0].text);
      assert.equal(payload.authenticated, true, "OAuth-only session is authenticated (unified state)");
      assert.equal(payload.credential, "oauth_token", "status must report the OAuth domain");
      assert.equal(payload.cloud_verified, true, "refresh outcome must be reported");
      assert.equal(payload.search_config_source, "remote");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("status does not attempt a refresh when no credential is stored", async () => {
  await withTempDir(async (dir) => {
    await seedOAuthEntry(dir, null);

    let called = 0;
    const { client, server } = await bootConnector(dir, {
      onRefreshSearchConfig: async () => {
        called++;
        return true;
      },
      onOAuthLogin: async () => {
        called++;
        return true;
      },
    });

    try {
      const res = await client.callTool({ name: "manage_auth", arguments: { action: "status" } });
      assert.notEqual(res.isError, true);
      assert.equal(called, 0, "no credential means no refresh attempt");

      const payload = JSON.parse((res as any).content[0].text);
      assert.equal(payload.authenticated, false);
      assert.equal(payload.cloud_verified, undefined, "nothing was verified");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("a failing OAuth refresh is reported, not thrown", async () => {
  await withTempDir(async (dir) => {
    await seedOAuthEntry(dir, ACCESS_TOKEN);

    const { client, server } = await bootConnector(dir, {
      onOAuthLogin: async () => {
        throw new Error("upstream unreachable");
      },
    });

    try {
      const res = await client.callTool({ name: "manage_auth", arguments: { action: "status" } });
      assert.notEqual(res.isError, true, "status must still answer when the refresh throws");
      const payload = JSON.parse((res as any).content[0].text);
      assert.equal(payload.cloud_verified, false, "failure is surfaced in the payload");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

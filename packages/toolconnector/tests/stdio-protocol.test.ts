import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createConnectorServer } from "../src/index.js";
import { installInitializeNegotiation } from "../src/protocol.js";

test("connector stdio server supports stateless 2026 discovery", async (t) => {
  const server = createConnectorServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stdio = serveStdio(() => server, { transport: serverTransport });
  t.after(() => stdio.close());
  await clientTransport.start();
  const response = new Promise<unknown>((resolve) => { clientTransport.onmessage = resolve; });
  await clientTransport.send({
    jsonrpc: "2.0", id: 1, method: "server/discover",
    params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    } },
  });
  const message = await response as { result?: { supportedVersions: string[]; resultType: string }; error?: unknown };
  assert.equal(message.error, undefined);
  assert.equal(message.result?.resultType, "complete");
  assert.ok(message.result?.supportedVersions.includes("2026-07-28"));
});

test("connector stdio server retains legacy 2025 initialization", async (t) => {
  const server = createConnectorServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stdio = serveStdio(() => server, { transport: serverTransport });
  t.after(() => stdio.close());
  await clientTransport.start();
  const response = new Promise<unknown>((resolve) => { clientTransport.onmessage = resolve; });
  await clientTransport.send({
    jsonrpc: "2.0", id: 2, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-regression", version: "1.0.0" } },
  });
  const message = await response as { result?: { protocolVersion: string }; error?: unknown };
  assert.equal(message.error, undefined);
  assert.equal(message.result?.protocolVersion, "2025-11-25");
});

test("connector stdio server negotiates modern versions through legacy initialize", async (t) => {
  const server = createConnectorServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stdio = serveStdio(() => server, { transport: serverTransport });
  t.after(() => stdio.close());
  // Same wiring as main(): negotiation shim on the served transport.
  installInitializeNegotiation(serverTransport, { name: "toolconnector", version: "0.0.0-test" });
  await clientTransport.start();
  const response = new Promise<unknown>((resolve) => { clientTransport.onmessage = resolve; });
  // Claim-less `initialize` requesting a modern revision — exactly what a
  // 2026-07-28-only IDE sends. It must NOT be answered with 2025-11-25.
  await clientTransport.send({
    jsonrpc: "2.0", id: 3, method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "modern-ide", version: "1.0.0" } },
  });
  const message = await response as {
    result?: { protocolVersion?: string; resultType?: string; _meta?: Record<string, { name?: string }> };
    error?: unknown;
  };
  assert.equal(message.error, undefined);
  assert.equal(message.result?.protocolVersion, "2026-07-28");
  assert.equal(message.result?.resultType, "complete");
  assert.equal(message.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "toolconnector");
});

test("initialize with an unknown version keeps the server-chosen fallback", async (t) => {
  const server = createConnectorServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stdio = serveStdio(() => server, { transport: serverTransport });
  t.after(() => stdio.close());
  installInitializeNegotiation(serverTransport, { name: "toolconnector", version: "0.0.0-test" });
  await clientTransport.start();
  const response = new Promise<unknown>((resolve) => { clientTransport.onmessage = resolve; });
  await clientTransport.send({
    jsonrpc: "2.0", id: 4, method: "initialize",
    params: { protocolVersion: "1900-01-01", capabilities: {}, clientInfo: { name: "old-client", version: "1.0.0" } },
  });
  const message = await response as { result?: { protocolVersion: string }; error?: unknown };
  assert.equal(message.error, undefined);
  // Unknown revisions must never be advertised as supported.
  assert.equal(message.result?.protocolVersion, "2025-11-25");
});

for (const revision of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
  test(`a client restricted to ${revision} initializes, lists and calls a tool`, async (t) => {
    const server = createConnectorServer();
    server.registerTool("echo", { inputSchema: { value: z.string() } }, async ({ value }) => ({
      content: [{ type: "text" as const, text: value }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const stdio = serveStdio(() => server, { transport: serverTransport });
    installInitializeNegotiation(serverTransport, { name: "toolconnector", version: "test" });
    const client = new Client({ name: "restricted-client", version: "1" }, {
      supportedProtocolVersions: [revision], versionNegotiation: { mode: "legacy" }, capabilities: {},
    });
    t.after(async () => { await client.close(); await stdio.close(); });
    await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools[0].name, "echo");
    const result = await client.callTool({ name: "echo", arguments: { value: "working" } });
    assert.deepEqual(result.content, [{ type: "text", text: "working" }]);
  });
}

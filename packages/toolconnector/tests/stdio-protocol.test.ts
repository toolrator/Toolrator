import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createConnectorServer } from "../src/index.js";

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/client";
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

test("initialize with an unsupported legacy version keeps the server-chosen fallback", async (t) => {
  const server = createConnectorServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stdio = serveStdio(() => server, { transport: serverTransport });
  t.after(() => stdio.close());
  installInitializeNegotiation(serverTransport, { name: "toolconnector", version: "0.0.0-test" });
  await clientTransport.start();
  const response = new Promise<unknown>((resolve) => { clientTransport.onmessage = resolve; });
  await clientTransport.send({
    jsonrpc: "2.0", id: 4, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old-client", version: "1.0.0" } },
  });
  const message = await response as { result?: { protocolVersion: string }; error?: unknown };
  assert.equal(message.error, undefined);
  // 2025-06-18 is not supported — the SDK's fallback (2025-11-25) stands.
  assert.equal(message.result?.protocolVersion, "2025-11-25");
});

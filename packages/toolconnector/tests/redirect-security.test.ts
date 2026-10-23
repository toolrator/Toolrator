import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type RequestListener } from "node:http";
import { connectMcpClient } from "../src/mcp-client.js";
import { fetchWithTimeout } from "../src/oauth-client.js";
import { Logger } from "../src/config.js";

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

for (const status of [307, 308]) {
  test(`MCP transports do not forward custom credentials across a ${status} redirect`, async (t) => {
    let leakedRequests = 0;
    let originalRequests = 0;
    const target = await listen((_req, res) => { leakedRequests++; res.end("unexpected"); });
    const origin = await listen((req, res) => {
      originalRequests++;
      assert.equal(req.headers["x-api-key"], "test-secret");
      res.writeHead(status, { Location: `${target.url}/capture` }).end();
    });
    t.after(async () => { await close(origin.server); await close(target.server); });
    await assert.rejects(connectMcpClient(`${origin.url}/mcp`, new Logger("error"), {
      headers: { "X-API-Key": "test-secret" },
      // Exercise the real custom fetch wrapper used for side-channel headers.
      onResponseHeaders: () => {},
    }));
    assert.ok(originalRequests > 0);
    assert.equal(leakedRequests, 0);
  });

  test(`OAuth POST does not replay refresh-token or PKCE bodies through a ${status} redirect`, async (t) => {
    let leakedRequests = 0;
    let originalRequests = 0;
    const target = await listen((_req, res) => { leakedRequests++; res.end("unexpected"); });
    const origin = await listen((_req, res) => {
      originalRequests++;
      res.writeHead(status, { Location: `${target.url}/capture` }).end();
    });
    t.after(async () => { await close(origin.server); await close(target.server); });
    await assert.rejects(fetchWithTimeout(`${origin.url}/token`, {
      method: "POST", body: "refresh_token=test-refresh&code_verifier=test-verifier",
    }, 2_000));
    assert.equal(originalRequests, 1);
    assert.equal(leakedRequests, 0);
  });
}

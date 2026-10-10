import { test } from "node:test";
import assert from "node:assert/strict";
import { TelemetryClient, telemetryEnabledFromEnv, type TelemetryOptions } from "../src/telemetry.js";

const quiet = { warn: () => {} };

function makeClient(
  fetchImpl: typeof fetch,
  opts: Partial<TelemetryOptions> = {},
): TelemetryClient {
  return new TelemetryClient({
    endpoint: "https://example.test/api/usage/events",
    enabled: true,
    version: "0.0.0-test",
    fetchImpl,
    logger: quiet,
    flushIntervalMs: 3_600_000,
    ...opts,
  });
}

test("telemetry kill switch parsing", () => {
  assert.equal(telemetryEnabledFromEnv(undefined), true);
  assert.equal(telemetryEnabledFromEnv(""), true);
  assert.equal(telemetryEnabledFromEnv("on"), true);
  assert.equal(telemetryEnabledFromEnv("off"), false);
  assert.equal(telemetryEnabledFromEnv("FALSE"), false);
  assert.equal(telemetryEnabledFromEnv("0"), false);
  assert.equal(telemetryEnabledFromEnv(" no "), false);
});

test("records mcp_server targets and search engines only, with ok flags", async (t) => {
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  };
  const client = makeClient(fetchImpl);
  t.after(() => client.stop());

  client.recordFromToolCall("mcp_server", { target: "https://a.example/mcp", method: "tools/call" }, { content: [] });
  client.recordFromToolCall("search_mcp_ecosystem", { engine: "toolhub-default", arguments: { query: "secret" } }, { content: [], isError: true });
  client.recordFromToolCall("manage_auth", { action: "status" }, { content: [] });
  await client.flush();

  assert.equal(bodies.length, 1);
  const events = (bodies[0] as { events: Array<Record<string, unknown>> }).events;
  assert.deepEqual(
    events.map((e) => ({ name: e.name, action: e.action, ok: e.ok })),
    [
      { name: "https://a.example/mcp", action: "call", ok: true },
      { name: "toolhub-default", action: "search", ok: false },
    ],
  );
  assert.equal(events[0].v, "0.0.0-test");
  assert.equal(client.pending, 0);
});

test("privacy: wire events carry only name, action, ok, v", async (t) => {
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  };
  const client = makeClient(fetchImpl, { maxBatch: 10 });
  t.after(() => client.stop());

  client.recordFromToolCall(
    "mcp_server",
    { target: "https://a.example/mcp", params: { name: "do_secret_thing", arguments: { ssn: "123" } }, headers: { Authorization: "Bearer sekret" } },
    { content: [{ type: "text", text: "private output" }] },
  );
  await client.flush();

  const events = (bodies[0] as { events: Array<Record<string, unknown>> }).events;
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), ["action", "name", "ok", "v"]);
  }
});

test("queue is bounded and drops the oldest events", (t) => {
  const fetchImpl: typeof fetch = async () => new Response("{}", { status: 200 });
  const client = makeClient(fetchImpl, { maxQueue: 3, maxBatch: 100 });
  t.after(() => client.stop());
  for (let i = 0; i < 5; i++) {
    client.record({ name: `n${i}`, action: "call", ok: true });
  }
  assert.equal(client.pending, 3);
});

test("disabled client records nothing", async (t) => {
  let called = 0;
  const fetchImpl: typeof fetch = async () => {
    called += 1;
    return new Response("{}", { status: 200 });
  };
  const client = makeClient(fetchImpl, { enabled: false });
  t.after(() => client.stop());
  client.recordFromToolCall("mcp_server", { target: "https://a.example/mcp" }, {});
  await client.flush();
  assert.equal(client.pending, 0);
  assert.equal(called, 0);
});

test("failed flush drops the batch without throwing", async (t) => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("network down");
  };
  const client = makeClient(fetchImpl);
  t.after(() => client.stop());
  client.record({ name: "x", action: "call", ok: true });
  await client.flush();
  assert.equal(client.pending, 0);
});

test("invalid events are dropped, not sent", async (t) => {
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  };
  const client = makeClient(fetchImpl, { maxBatch: 10 });
  t.after(() => client.stop());
  client.record({ name: "", action: "call", ok: true });
  client.record({ name: "x", action: "search", ok: true });
  await client.flush();
  const events = (bodies[0] as { events: Array<Record<string, unknown>> }).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "x");
});

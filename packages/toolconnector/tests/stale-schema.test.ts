import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  isSchemaStale,
  markClientRefreshed,
  registerCurrentSchema,
  getCurrentSchemaJson,
  alreadyInformed,
  markInformed,
  buildStaleErrorAppendix,
  buildStaleSuccessNotice,
  informedToolCount,
} from "../src/stale-schema.js";
import { schemaTimestamps } from "../src/state.js";

function setStale(stale: boolean) {
  if (stale) {
    // Keep timestamps monotonic: bump lastUpdated clearly past lastFetched.
    schemaTimestamps.lastFetched = 1_000;
    schemaTimestamps.lastUpdated = 2_000;
  } else {
    schemaTimestamps.lastFetched = 3_000;
    schemaTimestamps.lastUpdated = 2_000;
  }
}

const exampleSchema = { type: "object", properties: { action: { type: "string" } }, required: ["action"] };

beforeEach(() => {
  markClientRefreshed();
  setStale(false);
});

test("isSchemaStale: false when client fetched after the last update", () => {
  assert.equal(isSchemaStale(), false);
});

test("isSchemaStale: true when server updated after the client's last fetch", () => {
  setStale(true);
  assert.equal(isSchemaStale(), true);
});

test("markClientRefreshed clears staleness and the informed set", () => {
  setStale(true);
  markInformed("some_tool");
  assert.equal(informedToolCount(), 1);
  markClientRefreshed();
  assert.equal(isSchemaStale(), false);
  assert.equal(informedToolCount(), 0);
});

test("registerCurrentSchema accepts zod schemas and renders JSON Schema", () => {
  registerCurrentSchema("tool_a", z.object({ action: z.enum(["x", "y"]) }));
  const json = getCurrentSchemaJson("tool_a");
  assert.ok(json);
  assert.equal((json as any).type, "object");
  assert.ok((json as any).properties.action);
});

test("registerCurrentSchema ignores non-zod values", () => {
  registerCurrentSchema("tool_b", { not: "a schema" });
  assert.equal(getCurrentSchemaJson("tool_b"), null);
});

test("getCurrentSchemaJson returns null for unregistered tools", () => {
  assert.equal(getCurrentSchemaJson("never_registered"), null);
});

test("buildStaleErrorAppendix explains the cause, echoes args, embeds the current schema, and tells the model what to do", () => {
  const out = buildStaleErrorAppendix("my_tool", { action: "old_value" }, exampleSchema);
  assert.ok(out.includes('tool "my_tool"'), "mentions the tool");
  assert.ok(out.includes("OUTDATED schema"), "names the outdated schema");
  assert.ok(out.includes("notifications/tools/list_changed"), "references the notification");
  assert.ok(out.includes(JSON.stringify({ action: "old_value" })), "echoes sent arguments");
  assert.ok(out.includes('"required":["action"]') || out.includes('"required": ["action"]'), "embeds the schema");
  assert.ok(out.includes("Retry the call"), "instructs a retry");
  assert.ok(out.includes("tell the user"), "tells the model to inform the user");
});

test("buildStaleErrorAppendix works without sent arguments and without a schema", () => {
  const noArgs = buildStaleErrorAppendix("t", undefined, exampleSchema);
  assert.ok(!noArgs.includes("Arguments you sent"));
  const noSchema = buildStaleErrorAppendix("t", undefined, null);
  assert.ok(noSchema.includes("current schema unavailable"));
});

test("buildStaleSuccessNotice: emitted once per tool, then suppressed", () => {
  const first = buildStaleSuccessNotice("tool_x", exampleSchema);
  assert.ok(first);
  assert.ok(first.includes('tool "tool_x"'));
  assert.ok(first.includes(JSON.stringify(exampleSchema).slice(0, 20)));
  assert.equal(buildStaleSuccessNotice("tool_x", exampleSchema), null);
  // A different tool still gets its own notice.
  assert.ok(buildStaleSuccessNotice("tool_y", exampleSchema));
});

test("alreadyInformed / markInformed track state", () => {
  assert.equal(alreadyInformed("tool_z"), false);
  markInformed("tool_z");
  assert.equal(alreadyInformed("tool_z"), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { MeiliSearchAdapter } from "../src/adapters/meilisearch.js";
import type { SearchDocument } from "../src/adapters/types.js";

function mockAdapter(failAction?: string) {
  const adapter = new MeiliSearchAdapter({
    url: "http://localhost:7700",
    searchKey: "",
    adminKey: "",
    indexName: "mcp_servers",
  });
  const actions: string[] = [];
  const tasks = new Map<number, string>();
  let nextTask = 1;
  const task = (action: string) => {
    actions.push(action);
    const taskUid = nextTask++;
    tasks.set(taskUid, action);
    return { taskUid };
  };
  const adminClient = {
    createIndex: (name: string) => task(`create:${name}`),
    deleteIndex: (name: string) => task(`delete:${name}`),
    swapIndexes: () => task("swap"),
    waitForTask: async (uid: number) => ({
      status: tasks.get(uid)?.startsWith(failAction ?? "\u0000") ? "failed" : "succeeded",
      error: { message: "simulated task failure" },
    }),
    index: (name: string) => ({
      updateSettings: () => task(`settings:${name}`),
      addDocuments: () => task(`documents:${name}`),
      deleteDocuments: () => task(`deleteDocuments:${name}`),
    }),
  };
  Object.assign(adapter, { adminClient });
  return { adapter, actions };
}

const document = {
  id: "placeholder",
  mcp_name: "example/server",
  display_name: "Example",
  description: "Example server",
} as SearchDocument;

test("failed staged indexing leaves live Meilisearch indexes untouched", async () => {
  const { adapter, actions } = mockAdapter("documents:");
  await assert.rejects(() => adapter.replaceAll([document], []), /simulated task failure/);
  assert.equal(actions.includes("swap"), false);
  assert.equal(actions.some((action) => action === "delete:mcp_servers" || action === "delete:mcp_tools"), false);
  assert.equal(actions.filter((action) => action.startsWith("delete:")).length, 2);
});

test("successful staged indexing swaps both indexes before cleanup", async () => {
  const { adapter, actions } = mockAdapter();
  await adapter.replaceAll([document], []);
  const swapAt = actions.indexOf("swap");
  assert.ok(swapAt > 0);
  assert.ok(actions.slice(0, swapAt).some((action) => action.startsWith("documents:")));
  assert.ok(actions.slice(swapAt + 1).every((action) => action.startsWith("delete:")));
});

test("failed delete task is surfaced instead of treated as unsupported filter", async () => {
  const { adapter, actions } = mockAdapter("deleteDocuments:");
  await assert.rejects(() => adapter.removeToolsByServer("example/server"), /simulated task failure/);
  assert.equal(actions.length, 1);
});

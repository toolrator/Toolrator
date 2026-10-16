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

function mockSearchAdapter(search: (call: number) => Promise<unknown>) {
  const adapter = new MeiliSearchAdapter({
    url: "http://localhost:7700",
    searchKey: "",
    adminKey: "",
    indexName: "mcp_servers",
  });
  let calls = 0;
  const fakeIndex = {
    search: async () => {
      calls += 1;
      return search(calls);
    },
  };
  Object.assign(adapter, { searchClient: { index: () => fakeIndex } });
  return { adapter, calls: () => calls };
}

test("transient Meilisearch timeouts are retried before failing a search", async () => {
  const { adapter, calls } = mockSearchAdapter((call) => {
    if (call < 3) {
      throw Object.assign(new Error("408: Request Timeout"), { httpStatus: 408 });
    }
    return Promise.resolve({ hits: [], estimatedTotalHits: 0 });
  });
  const result = await adapter.search("query");
  assert.equal(calls(), 3);
  assert.equal(result.total, 0);
});

test("non-transient search errors are not retried", async () => {
  const { adapter, calls } = mockSearchAdapter(() => {
    throw Object.assign(new Error("invalid filter"), { httpStatus: 400 });
  });
  await assert.rejects(() => adapter.search("query"), /invalid filter/);
  assert.equal(calls(), 1);
});

// ---------------------------------------------------------------------------
// Listings (getIndexList / getAllDocuments) — pagination, retry, coalescing
// ---------------------------------------------------------------------------

function mockListingAdapter(
  pages: Array<Array<Record<string, unknown>>> | ((call: number) => Array<Record<string, unknown>>),
) {
  const adapter = new MeiliSearchAdapter({
    url: "http://localhost:7700",
    searchKey: "",
    adminKey: "",
    indexName: "mcp_servers",
  });
  const calls: Array<Record<string, unknown>> = [];
  const fakeIndex = {
    getDocuments: (params: Record<string, unknown>) => {
      calls.push(params);
      const page = typeof pages === "function" ? pages(calls.length) : (pages[calls.length - 1] ?? []);
      return Promise.resolve({ results: page });
    },
  };
  Object.assign(adapter, { adminClient: { index: () => fakeIndex } });
  return { adapter, calls: () => calls };
}

test("getIndexList pages until exhausted and projects only listing fields", async () => {
  const { adapter, calls } = mockListingAdapter([
    [
      { id: "a", mcp_name: "mock/a", updated_at: "t1", content_hash: "h1", has_vector: true },
      { id: "b", mcp_name: "mock/b", updated_at: "t2", content_hash: "h2" },
    ],
    [{ id: "c", mcp_name: "mock/c", updated_at: "t3", content_hash: "h3", _vectors: {} }],
    [],
  ]);
  const list = await adapter.getIndexList();
  assert.equal(calls().length, 3);
  assert.equal(calls()[0].limit, 5000);
  assert.deepEqual(calls()[0].fields, ["id", "mcp_name", "updated_at", "content_hash", "has_vector"]);
  assert.deepEqual(list, [
    { id: "mock/a", updated_at: "t1", content_hash: "h1", has_vector: true },
    { id: "mock/b", updated_at: "t2", content_hash: "h2", has_vector: false },
    { id: "mock/c", updated_at: "t3", content_hash: "h3", has_vector: true },
  ]);
});

test("transient listing failures are retried before failing getIndexList", async () => {
  const { adapter, calls } = mockListingAdapter((call) => {
    if (call === 1) throw Object.assign(new Error("408: Request Timeout"), { httpStatus: 408 });
    if (call === 2) return [{ id: "a", mcp_name: "mock/a", updated_at: "t1", content_hash: "h1" }];
    return [];
  });
  const list = await adapter.getIndexList();
  assert.equal(calls().length, 3);
  assert.equal(list.length, 1);
});

test("non-transient listing errors are not retried", async () => {
  const { adapter, calls } = mockListingAdapter(() => {
    throw Object.assign(new Error("invalid request"), { httpStatus: 400 });
  });
  await assert.rejects(() => adapter.getIndexList(), /invalid request/);
  assert.equal(calls().length, 1);
});

test("concurrent getIndexList calls share one backend scan", async () => {
  const entry = { id: "a", mcp_name: "mock/a", updated_at: "t1", content_hash: "h1" };
  const { adapter, calls } = mockListingAdapter((call) => {
    if (call === 1 || call === 3) return [entry];
    return [];
  });
  const [first, second] = await Promise.all([adapter.getIndexList(), adapter.getIndexList()]);
  assert.equal(calls().length, 2); // one scan (page + empty terminator), not two
  assert.deepEqual(first, second);
  await adapter.getIndexList();
  assert.equal(calls().length, 4); // a later call re-scans
});

test("getAllDocuments exports in memory-bounded pages without projection", async () => {
  const { adapter, calls } = mockListingAdapter([[{ id: "a", mcp_name: "mock/a" }], []]);
  const docs = await adapter.getAllDocuments();
  assert.equal(calls()[0].limit, 1000);
  assert.equal(calls()[0].fields, undefined);
  assert.equal(docs.length, 1);
});

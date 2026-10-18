import { test } from "node:test";
import assert from "node:assert/strict";
import { MeiliSearchAdapter } from "../src/adapters/meilisearch.js";
import type { SearchDocument, ToolDocument } from "../src/adapters/types.js";

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

// ---------------------------------------------------------------------------
// userProvided embedder opt-out — Meilisearch rejects the WHOLE batch with
// `vector_embedding_error` if any document lacks a usable `_vectors.default`.
// Every document write path must therefore send `_vectors.default: null` for
// documents without vectors (prod incident 2026-10-18: incremental sync
// wiped server tool docs because their unembedded tail poisoned the batch).
// ---------------------------------------------------------------------------

function mockCaptureAdapter() {
  const adapter = new MeiliSearchAdapter({
    url: "http://localhost:7700",
    searchKey: "",
    adminKey: "",
    indexName: "mcp_servers",
    toolIndexName: "mcp_tools",
    toolIndexEnabled: true,
  });
  const tasks = new Map<number, string>();
  let nextTask = 1;
  const task = (action: string) => {
    const taskUid = nextTask++;
    tasks.set(taskUid, action);
    return { taskUid };
  };
  const captured: Array<{ index: string; documents: Array<Record<string, unknown>> }> = [];
  const adminClient = {
    createIndex: (name: string) => task(`create:${name}`),
    deleteIndex: (name: string) => task(`delete:${name}`),
    swapIndexes: () => task("swap"),
    waitForTask: async (uid: number) => ({ status: tasks.has(uid) ? "succeeded" : "failed", error: null }),
    index: (name: string) => ({
      updateSettings: () => task(`settings:${name}`),
      addDocuments: (documents: Array<Record<string, unknown>>) => {
        captured.push({ index: name, documents });
        return task(`documents:${name}`);
      },
      deleteDocuments: () => task(`deleteDocuments:${name}`),
    }),
  };
  Object.assign(adapter, { adminClient });
  return { adapter, captured };
}

function toolDoc(id: string, vectors?: number[]): ToolDocument {
  return {
    id,
    server_mcp_name: "example/server",
    server_display_name: "Example",
    tool_name: id,
    tool_description: `Tool ${id}`,
    compact_schema: "{}",
    tags: [],
    ...(vectors ? { _vectors: { default: vectors } } : {}),
  };
}

test("indexTools opts documents without vectors out of the userProvided embedder", async () => {
  const { adapter, captured } = mockCaptureAdapter();
  await adapter.indexTools([toolDoc("t1", [0.1, 0.2, 0.3]), toolDoc("t2")]);
  assert.equal(captured.length, 1);
  const [withVector, withoutVector] = captured[0].documents as Array<{ _vectors: Record<string, unknown> }>;
  assert.deepEqual(withVector._vectors, { default: [0.1, 0.2, 0.3] });
  assert.equal(withoutVector._vectors.default, null);
});

test("the vector opt-out preserves other embedder keys", async () => {
  const { adapter, captured } = mockCaptureAdapter();
  const doc: ToolDocument = { ...toolDoc("t3"), _vectors: { mini: [1, 2] } };
  await adapter.indexTools([doc]);
  const [sent] = captured[0].documents as Array<{ _vectors: Record<string, unknown> }>;
  assert.deepEqual(sent._vectors, { mini: [1, 2], default: null });
});

test("server writes carry the same vector opt-out", async () => {
  const { adapter, captured } = mockCaptureAdapter();
  const doc = { id: "placeholder", mcp_name: "example/server", display_name: "Example" } as SearchDocument;
  await adapter.index([doc]);
  assert.equal(captured.length, 1);
  const [sent] = captured[0].documents as Array<{ _vectors: Record<string, unknown> }>;
  assert.equal(sent._vectors.default, null);
});

test("staged replaceAll writes carry the vector opt-out", async () => {
  const { adapter, captured } = mockCaptureAdapter();
  await adapter.replaceAll(
    [{ id: "placeholder", mcp_name: "example/server", display_name: "Example" } as SearchDocument],
    [toolDoc("t1"), toolDoc("t2", [0.1])],
  );
  const staged = captured.filter((entry) => entry.index.includes("_stage_"));
  assert.equal(staged.length, 2);
  const serverDocs = staged.find((entry) => entry.index.startsWith("mcp_servers_stage"))!.documents as Array<{ _vectors: Record<string, unknown> }>;
  const toolDocs = staged.find((entry) => entry.index.startsWith("mcp_tools_stage"))!.documents as Array<{ _vectors: Record<string, unknown> }>;
  assert.equal(serverDocs[0]._vectors.default, null);
  assert.equal(toolDocs[0]._vectors.default, null);
  assert.deepEqual(toolDocs[1]._vectors.default, [0.1]);
});

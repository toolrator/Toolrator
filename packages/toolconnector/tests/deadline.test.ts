import { test } from "node:test";
import assert from "node:assert/strict";
import { withDeadline } from "../src/deadline.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("withDeadline returns the promise value when it settles before the deadline", async () => {
  const result = await withDeadline(sleep(20).then(() => "ok"), Date.now() + 2000);
  assert.equal(result, "ok");
});

test("withDeadline returns null when the deadline passes first", async () => {
  const slow = sleep(500).then(() => "too late");
  const result = await withDeadline(slow, Date.now() + 50);
  assert.equal(result, null);
  // The underlying promise still completes in the background; give it a
  // moment so the process exits cleanly without dangling timers.
  await sleep(550);
});

test("withDeadline returns null immediately for an already-expired deadline", async () => {
  const started = Date.now();
  const result = await withDeadline(sleep(100).then(() => "x"), Date.now() - 1);
  assert.equal(result, null);
  assert.ok(Date.now() - started < 50, "must not wait when the deadline is in the past");
  await sleep(120);
});

test("withDeadline passes through rejections that occur before the deadline", async () => {
  await assert.rejects(
    withDeadline(sleep(10).then(() => Promise.reject(new Error("boom"))), Date.now() + 2000),
    /boom/,
  );
});

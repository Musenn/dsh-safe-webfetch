import assert from "node:assert/strict";
import test from "node:test";
import { Semaphore } from "../lib/semaphore.js";

test("concurrency is bounded and queued work resumes", async () => {
  const semaphore = new Semaphore(1);
  const releaseFirst = await semaphore.acquire();
  let entered = false;
  const second = semaphore.acquire().then((release) => {
    entered = true;
    release();
  });
  await Promise.resolve();
  assert.equal(entered, false);
  releaseFirst();
  await second;
  assert.equal(entered, true);
});

test("an aborted queued request is removed", async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const queued = semaphore.acquire(controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(queued, /cancelled/);
  release();
  assert.equal(semaphore.active, 0);
});

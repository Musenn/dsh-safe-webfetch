import assert from "node:assert/strict";
import test from "node:test";
import { SafeLocalFetchProvider } from "../lib/provider.js";

const config = {
  maxUrlLength: 2048,
  maxResponseBytes: 1024,
  maxBodyChars: 800,
  timeoutMs: 1000,
  maxRedirects: 2,
  maxConcurrency: 2,
  minReadableChars: 50,
  allowVpnFakeIp: false,
  userAgent: "dsh-safe-webfetch-test",
};

function fakeAgentFactory(records) {
  return (lookup) => ({
    lookup,
    async close() { records.closed += 1; },
  });
}

test("transport is pinned to the validated DNS answer", async () => {
  const records = { closed: 0, address: null };
  const provider = new SafeLocalFetchProvider(config, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    createAgent: fakeAgentFactory(records),
    fetch: async (_url, options) => {
      await new Promise((resolve, reject) => options.dispatcher.lookup("example.com", { all: true }, (error, addresses) => error ? reject(error) : (records.address = addresses[0].address, resolve())));
      return new Response("<html><body><h1>Example</h1><p>Public content with enough text for local extraction.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  const result = await provider.fetch({ url: "https://example.com/page" });
  assert.equal(records.address, "93.184.216.34");
  assert.equal(records.closed, 1);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.kind, "html");
  assert.match(result.body.content, /Public content/);
});

test("cross-origin redirects are not followed", async () => {
  let calls = 0;
  const records = { closed: 0 };
  const provider = new SafeLocalFetchProvider(config, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    createAgent: fakeAgentFactory(records),
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "https://other.example.com/path" } });
    },
  });
  await assert.rejects(provider.fetch({ url: "https://example.com/start" }), { code: "WEB_REDIRECT_BLOCKED" });
  assert.equal(calls, 1);
});

test("declared oversized responses fail before body processing", async () => {
  const records = { closed: 0 };
  const provider = new SafeLocalFetchProvider(config, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    createAgent: fakeAgentFactory(records),
    fetch: async () => new Response("small", { status: 200, headers: { "content-type": "text/plain", "content-length": "2048" } }),
  });
  await assert.rejects(provider.fetch({ url: "https://example.com/large" }), { code: "WEB_FETCH_TOO_LARGE" });
});

test("an already-aborted caller never reaches DNS or transport", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const provider = new SafeLocalFetchProvider(config, {
    lookup: async () => assert.fail("unexpected DNS"),
    fetch: async () => assert.fail("unexpected request"),
  });
  await assert.rejects(provider.fetch({ url: "https://example.com" }, controller.signal), { code: "WEB_ABORTED" });
});

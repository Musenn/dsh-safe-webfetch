import assert from "node:assert/strict";
import test from "node:test";
import { extractReadableHtml } from "../lib/extract.js";

test("Readability keeps the article and drops page chrome and active content", () => {
  const paragraphs = Array.from({ length: 8 }, (_, index) => `<p>Paragraph ${index + 1} contains substantial reporting text for the local extraction pipeline.</p>`).join("");
  const html = `<!doctype html><html><head><title>Report</title><script>bad()</script></head><body><nav>Navigation</nav><main><article><h1>Local report</h1>${paragraphs}<a href="/details">Details</a><button onclick="bad()">Run</button></article></main><footer>Footer</footer></body></html>`;
  const result = extractReadableHtml(html, "https://example.com/news/item", { minReadableChars: 100 });
  assert.equal(result.extracted, true);
  assert.match(result.content, /Local report/);
  assert.match(result.content, /https:\/\/example\.com\/details/);
  assert.doesNotMatch(result.content, /<script|onclick=|<button/i);
  assert.doesNotMatch(result.content, /Navigation/);
});

test("small static pages remain usable when Readability has no article", () => {
  const result = extractReadableHtml("<html><body><h1>Hello</h1><p>Short page.</p></body></html>", "https://example.com", { minReadableChars: 200 });
  assert.equal(result.extracted, false);
  assert.match(result.content, /Short page/);
});

test("JavaScript shells receive a browser fallback hint", () => {
  const result = extractReadableHtml('<html><body><div id="__next"></div><script src="/app.js"></script></body></html>', "https://example.com/app", { minReadableChars: 180 });
  assert.equal(result.browserRecommended, true);
  assert.match(result.content, /browser_open/);
  assert.doesNotMatch(result.content, /<script/i);
});

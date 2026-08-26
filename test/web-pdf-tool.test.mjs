import assert from "node:assert/strict";
import test from "node:test";
import { applyWebPdfTool, positiveUniquePages, renderValue } from "../lib/web-pdf-tool.js";
import { renderPdfPages } from "../lib/pdf.js";
import { textPdf } from "./pdf-fixture.mjs";

const config = {
  maxPdfBytes: 100_000,
  maxPdfPages: 20,
  maxVisualPdfPages: 4,
  maxPdfConcurrency: 2,
  pdfTimeoutMs: 15_000,
  pdfToolTimeoutMs: 20_000,
  workerMemoryMb: 128,
  renderMaxPixels: 1_000_000,
  renderScale: 1.5,
  jpegQuality: 85,
};

function harness({ imageCapable = true } = {}) {
  let definition;
  let prompt;
  let fetches = 0;
  const attachments = {
    imageLimits: { mediaTypes: ["image/jpeg"] },
    async saveImages(inputs) {
      return inputs.map((input, index) => ({
        attachmentId: `sha256:test-${index}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 100,
        height: 100,
        name: input.name,
      }));
    },
  };
  const context = {
    tools: { register(value) { definition = value; } },
    systemPrompt: { section(value) { prompt = value; } },
    get(name) {
      if (name === "attachments") return attachments;
      if (name === "llm") return { resolveModelInfo: async () => ({ inputModalities: imageCapable ? ["text", "image"] : ["text"] }) };
      return undefined;
    },
  };
  const provider = {
    async fetchResource() {
      fetches += 1;
      return { url: "https://example.com/report.pdf", statusCode: 200, bytes: await textPdf(["Visual page"]), truncated: false };
    },
    pdfProcessor: { renderPages: (bytes, pages, signal) => renderPdfPages(bytes, pages, config, signal) },
  };
  applyWebPdfTool(context, config, provider);
  const exec = {
    signal: new AbortController().signal,
    agent: {
      options: { provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" },
      session: { requestHeader() { return undefined; } },
    },
  };
  return { definition, prompt, exec, fetches: () => fetches };
}

test("page arguments are positive, unique, and bounded", () => {
  assert.deepEqual(positiveUniquePages([3, 1, 3], 4), [3, 1]);
  assert.deepEqual(positiveUniquePages(undefined, 4), []);
  assert.throws(() => positiveUniquePages([0], 4), /positive integers/);
  assert.throws(() => positiveUniquePages([1, 2, 3, 4, 5], 4), /at most 4/);
});

test("web_pdf renders selected pages and emits durable image blocks", async () => {
  const setup = harness();
  assert.match(setup.prompt.text, /web_fetch first/);
  const value = await setup.definition.execute({ url: "https://example.com/report.pdf", pages: [1] }, setup.exec);
  assert.equal(value.pageCount, 1);
  assert.equal(value.pages.length, 1);
  assert.equal(value.pages[0].image.mediaType, "image/jpeg");
  const blocks = setup.definition.output.render({}, value);
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[1].type, "image");
  assert.equal(blocks[1].attachment.attachmentId, "sha256:test-0");
});

test("text-only routes are rejected before PDF download", async () => {
  const setup = harness({ imageCapable: false });
  await assert.rejects(setup.definition.execute({ url: "https://example.com/report.pdf", pages: [1] }, setup.exec), /does not declare image input/);
  assert.equal(setup.fetches(), 0);
});

test("rendered tool values preserve page order", () => {
  const value = {
    url: "https://example.com/report.pdf",
    pageCount: 4,
    pages: [
      { page: 3, image: { attachmentId: "a" } },
      { page: 1, image: { attachmentId: "b" } },
    ],
  };
  const blocks = renderValue(value);
  assert.match(blocks[0].text, /3, 1/);
  assert.deepEqual(blocks.slice(1).map((block) => block.attachment.attachmentId), ["a", "b"]);
});

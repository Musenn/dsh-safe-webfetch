import assert from "node:assert/strict";
import test from "node:test";
import { assertPdfBytes, extractPdfText, hasPdfSignature, PdfProcessor, renderPdfPages } from "../lib/pdf.js";
import { imagePdf, textPdf } from "./pdf-fixture.mjs";

const options = {
  maxPdfPages: 20,
  maxBodyChars: 20_000,
  maxVisualPdfPages: 4,
  maxPdfConcurrency: 2,
  pdfTimeoutMs: 15_000,
  workerMemoryMb: 128,
  renderMaxPixels: 1_000_000,
  renderScale: 1.5,
  jpegQuality: 85,
};

test("extracts local PDF text with stable page markers", async () => {
  const bytes = await textPdf(["Alpha page content", "Beta page content"]);
  assert.equal(hasPdfSignature(bytes), true);
  const result = await extractPdfText(bytes, options);
  assert.equal(result.pageCount, 2);
  assert.equal(result.textPages, 2);
  assert.match(result.content, /\[Page 1\][\s\S]*Alpha page content/);
  assert.match(result.content, /\[Page 2\][\s\S]*Beta page content/);
});

test("image-only PDFs recommend visual inspection", async () => {
  const result = await extractPdfText(await imagePdf(), options);
  assert.equal(result.pageCount, 1);
  assert.equal(result.textPages, 0);
  assert.match(result.content, /No extractable text was found/);
  assert.match(result.content, /web_pdf/);
});

test("renders only requested pages into bounded JPEGs", async () => {
  const result = await renderPdfPages(await textPdf(["One", "Two", "Three"]), [2], options);
  assert.equal(result.pageCount, 3);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].page, 2);
  assert.equal(result.pages[0].data[0], 0xff);
  assert.equal(result.pages[0].data[1], 0xd8);
  assert.ok(result.pages[0].width * result.pages[0].height <= options.renderMaxPixels + 3000);
});

test("visual rendering defaults to the first three pages", async () => {
  const result = await renderPdfPages(await textPdf(["One", "Two", "Three", "Four"]), [], options);
  assert.deepEqual(result.pages.map((page) => page.page), [1, 2, 3]);
});

test("rejects malformed files, page overflow, and out-of-range pages", async () => {
  assert.throws(() => assertPdfBytes(new TextEncoder().encode("not a pdf")), { code: "WEB_PDF_INVALID" });
  await assert.rejects(extractPdfText(await textPdf(["One", "Two"]), { ...options, maxPdfPages: 1 }), { code: "WEB_PDF_TOO_MANY_PAGES" });
  await assert.rejects(renderPdfPages(await textPdf(["One"]), [2], options), { code: "WEB_PDF_PAGE_OUT_OF_RANGE" });
});

test("normalizes cancellation while waiting for PDF capacity", async () => {
  const processor = new PdfProcessor({ ...options, maxPdfConcurrency: 1 });
  const release = await processor.semaphore.acquire();
  const controller = new AbortController();
  const pending = processor.extractText(await textPdf(["Queued"]), controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, { code: "WEB_ABORTED" });
  release();
});

import { parentPort, workerData } from "node:worker_threads";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

function errorCode(error) {
  if (error?.name === "PasswordException") return "WEB_PDF_ENCRYPTED";
  if (error?.name === "InvalidPDFException" || error?.name === "MissingPDFException") return "WEB_PDF_INVALID";
  return workerData.task === "render" ? "WEB_PDF_RENDER_FAILED" : "WEB_PDF_PARSE_FAILED";
}

function textFromItems(items) {
  const lines = [];
  let line = [];
  for (const item of items) {
    if (typeof item?.str !== "string") continue;
    const value = item.str.replace(/\s+/g, " ").trim();
    if (value) line.push(value);
    if (item.hasEOL && line.length > 0) {
      lines.push(line.join(" "));
      line = [];
    }
  }
  if (line.length > 0) lines.push(line.join(" "));
  return lines.join("\n").trim();
}

async function extractText(document, maxChars) {
  const sections = [];
  let textPages = 0;
  let processedPages = 0;
  let used = 0;
  let truncated = false;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent({ disableNormalization: false });
    processedPages += 1;
    const pageText = textFromItems(content.items);
    if (pageText.length > 0) textPages += 1;
    const heading = `[Page ${pageNumber}]\n`;
    const remaining = maxChars - used;
    if (remaining <= heading.length) {
      truncated = true;
      break;
    }
    const section = `${heading}${pageText || "(No extractable text on this page.)"}`;
    const clipped = section.slice(0, remaining);
    sections.push(clipped);
    used += clipped.length + 2;
    if (clipped.length < section.length) {
      truncated = true;
      break;
    }
  }
  return { sections, textPages, processedPages, truncated };
}

async function renderPages(document, pages, options) {
  const rendered = [];
  for (const pageNumber of pages) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
      const error = new Error(`PDF page ${pageNumber} is outside the document's 1-${document.numPages} page range`);
      error.code = "WEB_PDF_PAGE_OUT_OF_RANGE";
      throw error;
    }
    const page = await document.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const basePixels = Math.max(1, base.width * base.height);
    const scale = Math.min(options.renderScale, Math.sqrt(options.renderMaxPixels / basePixels));
    const viewport = page.getViewport({ scale: Math.max(scale, 0.05) });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const encoded = Uint8Array.from(canvas.toBuffer("image/jpeg", options.jpegQuality));
    rendered.push({ page: pageNumber, width, height, data: encoded });
  }
  return rendered;
}

async function main() {
  const loadingTask = getDocument({
    data: new Uint8Array(workerData.bytes),
    disableWorker: true,
    disableAutoFetch: true,
    disableStream: true,
    isEvalSupported: false,
    useSystemFonts: true,
    stopAtErrors: true,
  });
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > workerData.maxPdfPages) {
      const error = new Error(`PDF page count ${document.numPages} exceeds the allowed range of 1-${workerData.maxPdfPages}`);
      error.code = "WEB_PDF_TOO_MANY_PAGES";
      throw error;
    }
    if (workerData.task === "extract") {
      const extracted = await extractText(document, workerData.maxBodyChars);
      return { pageCount: document.numPages, ...extracted };
    }
    if (workerData.task === "render") {
      const pages = workerData.pages.length > 0
        ? workerData.pages
        : Array.from({ length: Math.min(3, document.numPages, workerData.maxVisualPdfPages) }, (_value, index) => index + 1);
      if (pages.length > workerData.maxVisualPdfPages) {
        const error = new Error(`a visual PDF request may render at most ${workerData.maxVisualPdfPages} pages`);
        error.code = "WEB_PDF_TOO_MANY_VISUAL_PAGES";
        throw error;
      }
      const rendered = await renderPages(document, pages, workerData);
      return { pageCount: document.numPages, pages: rendered };
    }
    const error = new Error("unknown PDF worker operation");
    error.code = "WEB_PDF_INVALID_OPERATION";
    throw error;
  } finally {
    await loadingTask.destroy();
  }
}

try {
  const result = await main();
  const transfer = result.pages?.map((page) => page.data.buffer) ?? [];
  parentPort.postMessage({ ok: true, result }, transfer);
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      code: error?.code ?? errorCode(error),
      message: String(error?.message ?? error).slice(0, 500),
    },
  });
}

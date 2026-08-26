import { Worker } from "node:worker_threads";
import { Semaphore } from "./semaphore.js";

export class PdfError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "PdfError";
    this.code = code;
  }
}

export function hasPdfSignature(bytes) {
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  return prefix.includes("%PDF-");
}

export function assertPdfBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || !hasPdfSignature(bytes)) {
    throw new PdfError("response does not contain a valid PDF signature", "WEB_PDF_INVALID");
  }
}

function runWorker(task, bytes, options, signal) {
  if (signal?.aborted) throw new PdfError("PDF processing aborted", "WEB_ABORTED", { cause: signal.reason });
  const input = bytes.slice();
  const worker = new Worker(new URL("./pdf-worker.js", import.meta.url), {
    workerData: { task, bytes: input, ...options },
    transferList: [input.buffer],
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: options.workerMemoryMb,
      maxYoungGenerationSizeMb: Math.min(64, Math.max(16, Math.floor(options.workerMemoryMb / 4))),
      stackSizeMb: 8,
    },
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      void worker.terminate();
      reject(new PdfError("PDF processing aborted", "WEB_ABORTED", { cause: signal.reason }));
    });
    const timer = setTimeout(() => finish(() => {
      void worker.terminate();
      reject(new PdfError(`PDF ${task} timed out`, "WEB_PDF_TIMEOUT"));
    }), options.pdfTimeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    worker.once("message", (message) => finish(() => {
      void worker.terminate();
      if (message?.ok) resolve(message.result);
      else reject(new PdfError(message?.error?.message ?? `PDF ${task} failed`, message?.error?.code ?? "WEB_PDF_PROCESSING_FAILED"));
    }));
    worker.once("error", (error) => finish(() => reject(new PdfError(`PDF worker failed: ${error.message}`, "WEB_PDF_WORKER_FAILED", { cause: error }))));
    worker.once("exit", (code) => {
      if (settled || code === 0) return;
      finish(() => reject(new PdfError(`PDF worker exited with code ${code}`, "WEB_PDF_WORKER_FAILED")));
    });
  });
}

export async function extractPdfText(bytes, options, signal) {
  assertPdfBytes(bytes);
  const result = await runWorker("extract", bytes, options, signal);
  const coverage = result.processedPages === result.pageCount
    ? `${result.textPages} page(s) with extractable text`
    : `${result.textPages} of ${result.processedPages} processed page(s) with extractable text`;
  const header = `PDF document: ${result.pageCount} page(s), ${coverage}.`;
  const note = result.textPages === 0
    ? "No extractable text was found in the processed pages. Use web_pdf to inspect selected pages visually with an image-capable model."
    : "Use web_pdf for pages whose charts, formulas, scans, or layout require visual inspection.";
  return {
    ...result,
    content: `${header}\n${note}\n\n${result.sections.join("\n\n")}`.trim(),
  };
}

export async function renderPdfPages(bytes, pages, options, signal) {
  assertPdfBytes(bytes);
  return runWorker("render", bytes, { ...options, pages }, signal);
}

export class PdfProcessor {
  constructor(options) {
    this.options = options;
    this.semaphore = new Semaphore(options.maxPdfConcurrency);
  }

  async acquire(signal) {
    try {
      return await this.semaphore.acquire(signal);
    } catch (cause) {
      throw new PdfError("PDF processing aborted", "WEB_ABORTED", { cause });
    }
  }

  async extractText(bytes, signal) {
    const release = await this.acquire(signal);
    try {
      return await extractPdfText(bytes, this.options, signal);
    } finally {
      release();
    }
  }

  async renderPages(bytes, pages, signal) {
    const release = await this.acquire(signal);
    try {
      return await renderPdfPages(bytes, pages, this.options, signal);
    } finally {
      release();
    }
  }
}

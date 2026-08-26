import z from "@deepseek-ai/schemastery";
import { SafeLocalFetchProvider } from "./provider.js";
import { applyWebPdfTool } from "./web-pdf-tool.js";

export const name = "dsh-safe-webfetch";
export const inject = ["web", "tools", "systemPrompt"];

export const Config = z.object({
  maxUrlLength: z.number().default(2048),
  maxResponseBytes: z.number().default(5_000_000),
  maxPdfBytes: z.number().default(25_000_000),
  maxBodyChars: z.number().default(160_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  maxConcurrency: z.number().default(4),
  minReadableChars: z.number().default(180),
  maxPdfPages: z.number().default(300),
  maxVisualPdfPages: z.number().default(8),
  maxPdfConcurrency: z.number().default(2),
  pdfTimeoutMs: z.number().default(90_000),
  pdfToolTimeoutMs: z.number().default(120_000),
  workerMemoryMb: z.number().default(256),
  renderMaxPixels: z.number().default(2_000_000),
  renderScale: z.number().default(1.5),
  jpegQuality: z.number().default(85),
  allowVpnFakeIp: z.boolean().default(false),
  userAgent: z.string().default("dsh-safe-webfetch/0.2.0"),
});

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`dsh-safe-webfetch: ${name} must be a positive integer`);
}

export function apply(context, config) {
  for (const key of [
    "maxUrlLength",
    "maxResponseBytes",
    "maxPdfBytes",
    "maxBodyChars",
    "timeoutMs",
    "maxConcurrency",
    "minReadableChars",
    "maxPdfPages",
    "maxVisualPdfPages",
    "maxPdfConcurrency",
    "pdfTimeoutMs",
    "pdfToolTimeoutMs",
    "workerMemoryMb",
    "renderMaxPixels",
    "jpegQuality",
  ]) positiveInteger(key, config[key]);
  if (!Number.isInteger(config.maxRedirects) || config.maxRedirects < 0) {
    throw new Error("dsh-safe-webfetch: maxRedirects must be a non-negative integer");
  }
  if (!Number.isFinite(config.renderScale) || config.renderScale <= 0) {
    throw new Error("dsh-safe-webfetch: renderScale must be a positive finite number");
  }
  if (config.jpegQuality > 100) throw new Error("dsh-safe-webfetch: jpegQuality must be at most 100");
  if (config.maxVisualPdfPages > config.maxPdfPages) {
    throw new Error("dsh-safe-webfetch: maxVisualPdfPages must not exceed maxPdfPages");
  }

  const provider = new SafeLocalFetchProvider(config);
  context.web.registerFetchProvider(provider);
  context.inject(["attachments"], (imageContext) => applyWebPdfTool(imageContext, config, provider));
}

export { SafeLocalFetchProvider } from "./provider.js";
export { extractReadableHtml } from "./extract.js";
export { extractPdfText, hasPdfSignature, PdfProcessor, renderPdfPages } from "./pdf.js";
export { isPublicAddress, isVpnFakeIp, resolveSafeTarget, validateUrl } from "./policy.js";

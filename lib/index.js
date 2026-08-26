import z from "@deepseek-ai/schemastery";
import { SafeLocalFetchProvider } from "./provider.js";

export const name = "dsh-safe-webfetch";
export const inject = ["web"];

export const Config = z.object({
  maxUrlLength: z.number().default(2048),
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(160_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  maxConcurrency: z.number().default(4),
  minReadableChars: z.number().default(180),
  allowVpnFakeIp: z.boolean().default(false),
  userAgent: z.string().default("dsh-safe-webfetch/0.1.0"),
});

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`dsh-safe-webfetch: ${name} must be a positive integer`);
}

export function apply(context, config) {
  for (const key of ["maxUrlLength", "maxResponseBytes", "maxBodyChars", "timeoutMs", "maxConcurrency", "minReadableChars"]) {
    positiveInteger(key, config[key]);
  }
  if (!Number.isInteger(config.maxRedirects) || config.maxRedirects < 0) {
    throw new Error("dsh-safe-webfetch: maxRedirects must be a non-negative integer");
  }
  context.web.registerFetchProvider(new SafeLocalFetchProvider(config));
}

export { SafeLocalFetchProvider } from "./provider.js";
export { extractReadableHtml } from "./extract.js";
export { isPublicAddress, isVpnFakeIp, resolveSafeTarget, validateUrl } from "./policy.js";

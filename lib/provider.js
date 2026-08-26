import { Agent, fetch as undiciFetch } from "undici";
import { WebError } from "@deepseek-ai/dsh-web";
import { extractReadableHtml } from "./extract.js";
import { hasPdfSignature, PdfError, PdfProcessor } from "./pdf.js";
import { PolicyError, pinnedLookup, resolveSafeTarget, sameOrigin, validateUrl } from "./policy.js";
import { Semaphore } from "./semaphore.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function deadline(parent, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(parent.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("web fetch timed out"));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function mimeOf(contentType) {
  return (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
}

function isPdfLikeMime(contentType) {
  const mime = mimeOf(contentType);
  return mime === "application/pdf" || mime === "application/octet-stream";
}

function contentKind(contentType, bytes) {
  const mime = mimeOf(contentType);
  if (mime === "application/pdf" || hasPdfSignature(bytes)) return "pdf";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
  if (!mime) {
    const prefix = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
    if (prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.startsWith("<head") || prefix.startsWith("<body")) return "html";
    if (!bytes.includes(0)) return "text";
  }
  return undefined;
}

function decoderFor(contentType) {
  const match = /;\s*charset\s*=\s*"?([^";]+)/i.exec(contentType ?? "");
  try {
    return new TextDecoder(match?.[1]?.trim() || "utf-8");
  } catch (cause) {
    throw new WebError(`unsupported charset ${match?.[1]}`, "WEB_UNSUPPORTED_CONTENT_TYPE", { cause });
  }
}

async function readCapped(response, maxBytes) {
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new WebError(`response exceeds ${maxBytes} bytes`, "WEB_FETCH_TOO_LARGE");
  }
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total += Math.max(remaining, 0);
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

function asWebError(error, signal, timedOut) {
  if (error instanceof WebError) return error;
  if (error instanceof PolicyError || error instanceof PdfError) return new WebError(error.message, error.code, { cause: error });
  if (timedOut()) return new WebError("web fetch timed out", "WEB_FETCH_TIMEOUT", { cause: error });
  if (signal.aborted) return new WebError("web fetch aborted", "WEB_ABORTED", { cause: error });
  return new WebError(`web fetch failed: ${String(error?.message ?? error)}`, "WEB_PROVIDER_ERROR", { cause: error });
}

export class SafeLocalFetchProvider {
  id = "safe-local";

  constructor(config, dependencies = {}) {
    this.config = config;
    this.lookup = dependencies.lookup;
    this.request = dependencies.fetch ?? undiciFetch;
    this.createAgent = dependencies.createAgent ?? ((lookup) => new Agent({ connect: { lookup } }));
    this.semaphore = new Semaphore(config.maxConcurrency);
    this.pdfProcessor = dependencies.pdfProcessor ?? new PdfProcessor(config);
  }

  available() {
    return true;
  }

  async fetch(request, parentSignal) {
    try {
      const resource = await this.fetchResource(request.url, parentSignal, {
        maxBytes: (contentType) => isPdfLikeMime(contentType) ? this.config.maxPdfBytes : this.config.maxResponseBytes,
        accept: "text/html,application/xhtml+xml,application/pdf,text/*;q=0.9,application/json;q=0.8,application/xml;q=0.8",
      });
      const kind = contentKind(resource.contentType, resource.bytes);
      if (!kind) throw new WebError(`unsupported content type ${resource.contentType ?? "unknown"}`, "WEB_UNSUPPORTED_CONTENT_TYPE");

      if (kind === "pdf") {
        if (resource.truncated) throw new WebError(`PDF exceeds ${this.config.maxPdfBytes} bytes`, "WEB_FETCH_TOO_LARGE");
        const parsed = await this.pdfProcessor.extractText(resource.bytes, parentSignal);
        return {
          url: resource.url,
          statusCode: resource.statusCode,
          body: { kind: "text", content: parsed.content },
          truncated: parsed.truncated,
        };
      }

      const decoded = decoderFor(resource.contentType).decode(resource.bytes);
      const charTruncated = decoded.length > this.config.maxBodyChars;
      const content = decoded.slice(0, this.config.maxBodyChars);
      const body = kind === "html"
        ? { kind: "html", content: extractReadableHtml(content, resource.url, { minReadableChars: this.config.minReadableChars, statusCode: resource.statusCode }).content }
        : { kind: "text", content };
      return {
        url: resource.url,
        statusCode: resource.statusCode,
        body,
        truncated: resource.truncated || charTruncated,
      };
    } catch (error) {
      if (error instanceof WebError) throw error;
      if (error instanceof PdfError) throw new WebError(error.message, error.code, { cause: error });
      throw error;
    }
  }

  async fetchResource(input, parentSignal, options = {}) {
    const d = deadline(parentSignal, this.config.timeoutMs);
    let release;
    try {
      release = await this.semaphore.acquire(d.signal);
      return await this.followAndReadResource(input, d.signal, options);
    } catch (error) {
      throw asWebError(error, d.signal, d.timedOut);
    } finally {
      release?.();
      d.dispose();
    }
  }

  async followAndReadResource(input, signal, options) {
    let current = validateUrl(input, this.config.maxUrlLength);
    for (let redirectCount = 0; ; redirectCount += 1) {
      const resolution = await resolveSafeTarget(current, {
        lookup: this.lookup,
        allowVpnFakeIp: this.config.allowVpnFakeIp,
      });
      const agent = this.createAgent(pinnedLookup(resolution));
      try {
        const response = await this.request(current, {
          method: "GET",
          redirect: "manual",
          dispatcher: agent,
          signal,
          headers: {
            "user-agent": this.config.userAgent,
            accept: options.accept ?? "*/*",
          },
        });

        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirectCount >= this.config.maxRedirects) {
            await response.body?.cancel();
            throw new WebError(`exceeded ${this.config.maxRedirects} redirects`, "WEB_REDIRECT_BLOCKED");
          }
          const location = response.headers.get("location");
          if (!location) {
            await response.body?.cancel();
            throw new WebError("redirect response has no Location header", "WEB_PROVIDER_ERROR");
          }
          const target = validateUrl(new URL(location, current).toString(), this.config.maxUrlLength);
          if (!sameOrigin(target, current)) {
            await response.body?.cancel();
            throw new WebError(`cross-origin redirect to ${target.origin} requires a new web_fetch call`, "WEB_REDIRECT_BLOCKED");
          }
          await response.body?.cancel();
          current = target;
          continue;
        }

        const contentType = response.headers.get("content-type");
        const maxBytes = typeof options.maxBytes === "function"
          ? options.maxBytes(contentType)
          : (options.maxBytes ?? this.config.maxResponseBytes);
        const body = await readCapped(response, maxBytes);
        return {
          url: current.toString(),
          statusCode: response.status,
          contentType,
          bytes: body.bytes,
          truncated: body.truncated,
        };
      } finally {
        await agent.close?.().catch(() => {});
      }
    }
  }
}

export { contentKind, isPdfLikeMime };

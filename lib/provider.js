import { Agent, fetch as undiciFetch } from "undici";
import { WebError } from "@deepseek-ai/dsh-web";
import { extractReadableHtml } from "./extract.js";
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

function contentKind(contentType, bytes) {
  const mime = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
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
  const declared = Number(response.headers.get("content-length"));
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
  if (error instanceof PolicyError) return new WebError(error.message, error.code, { cause: error });
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
  }

  available() {
    return true;
  }

  async fetch(request, parentSignal) {
    const d = deadline(parentSignal, this.config.timeoutMs);
    let release;
    try {
      release = await this.semaphore.acquire(d.signal);
      return await this.followAndRead(request.url, d.signal);
    } catch (error) {
      throw asWebError(error, d.signal, d.timedOut);
    } finally {
      release?.();
      d.dispose();
    }
  }

  async followAndRead(input, signal) {
    let current = validateUrl(input, this.config.maxUrlLength);
    for (let redirectCount = 0; ; redirectCount += 1) {
      const resolution = await resolveSafeTarget(current, {
        lookup: this.lookup,
        allowVpnFakeIp: this.config.allowVpnFakeIp,
      });
      const agent = this.createAgent(pinnedLookup(resolution));
      let response;
      try {
        response = await this.request(current, {
          method: "GET",
          redirect: "manual",
          dispatcher: agent,
          signal,
          headers: {
            "user-agent": this.config.userAgent,
            accept: "text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,application/xml;q=0.8",
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

        const { bytes, truncated: byteTruncated } = await readCapped(response, this.config.maxResponseBytes);
        const contentType = response.headers.get("content-type");
        const kind = contentKind(contentType, bytes);
        if (!kind) throw new WebError(`unsupported content type ${contentType ?? "unknown"}`, "WEB_UNSUPPORTED_CONTENT_TYPE");
        const decoded = decoderFor(contentType).decode(bytes);
        const charTruncated = decoded.length > this.config.maxBodyChars;
        const content = decoded.slice(0, this.config.maxBodyChars);
        const body = kind === "html"
          ? { kind: "html", content: extractReadableHtml(content, current.toString(), { minReadableChars: this.config.minReadableChars, statusCode: response.status }).content }
          : { kind: "text", content };
        return {
          url: current.toString(),
          statusCode: response.status,
          body,
          truncated: byteTruncated || charTruncated,
        };
      } finally {
        await agent.close?.().catch(() => {});
      }
    }
  }
}

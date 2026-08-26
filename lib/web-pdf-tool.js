import { defineTool } from "@deepseek-ai/dsh-tools";
import { PdfError } from "./pdf.js";

function positiveUniquePages(value, maxPages) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("pages must be an array of positive page numbers");
  const pages = [...new Set(value)];
  if (pages.some((page) => !Number.isInteger(page) || page < 1)) throw new Error("pages must contain only positive integers");
  if (pages.length > maxPages) throw new Error(`pages may contain at most ${maxPages} entries`);
  return pages;
}

async function assertImageRoute(context, exec) {
  const routed = exec.agent?.session.requestHeader()?.config;
  const provider = routed?.provider ?? exec.agent?.options.provider;
  const model = routed?.model ?? exec.agent?.options.model;
  const llm = context.get("llm");
  if (!provider || !model || !llm) throw new Error("web_pdf requires a resolvable image-capable model route");
  const info = await llm.resolveModelInfo(provider, model, exec.signal);
  if (!info.inputModalities?.includes("image")) {
    throw new Error(`model "${model}" does not declare image input; switch to deepseek-v4-flash-vision-exp before using web_pdf`);
  }
}

function imageSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: true,
    properties: {
      attachmentId: { type: "string", required: true },
      mediaType: { type: "string", enum: ["image/jpeg"], required: true },
      bytes: { type: "integer", required: true },
      width: { type: "integer", required: true },
      height: { type: "integer", required: true },
      name: { type: "string" },
      originalDimensions: {
        type: "object",
        additionalProperties: false,
        properties: {
          width: { type: "integer", required: true },
          height: { type: "integer", required: true },
        },
      },
    },
  };
}

function renderValue(value) {
  const blocks = [{
    type: "text",
    text: `<source>${value.url}</source>\n<type>pdf-pages</type>\n<document-pages>${value.pageCount}</document-pages>\n<rendered-pages>${value.pages.map((entry) => entry.page).join(", ")}</rendered-pages>`,
  }];
  for (const entry of value.pages) blocks.push({ type: "image", attachment: entry.image });
  return blocks;
}

export function applyWebPdfTool(context, config, provider) {
  context.systemPrompt.section({
    name: "tool:web_pdf",
    order: 112,
    text: `Use web_fetch first for a PDF's extractable text. Use web_pdf only to inspect scans, charts, formulas, tables, or layout on selected pages. It renders at most ${config.maxVisualPdfPages} pages locally and requires an image-capable model.`,
  });
  context.tools.register(defineTool({
    name: "web_pdf",
    description: `Render selected pages of a public PDF URL locally and return them as images. Defaults to the first three pages and accepts at most ${config.maxVisualPdfPages} pages. Use web_fetch first for text. Requires an image-capable model.`,
    parameters: {
      url: { type: "string", required: true, description: "Public HTTP(S) PDF URL." },
      pages: { type: "array", items: { type: "integer" }, description: "Optional 1-based page numbers. Defaults to the first three pages." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          pageCount: { type: "integer", required: true },
          pages: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                page: { type: "integer", required: true },
                image: imageSchema(),
              },
            },
          },
        },
      },
      render: (_args, value) => renderValue(value),
    },
    timeoutMs: config.pdfToolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof args.url !== "string" || args.url.trim().length === 0) throw new Error("url must be a non-empty string");
      const pages = positiveUniquePages(args.pages, config.maxVisualPdfPages);
      const attachments = context.get("attachments");
      if (!attachments) throw new Error("web_pdf requires the DSH attachment service");
      if (!attachments.imageLimits.mediaTypes.includes("image/jpeg")) throw new Error("this deployment does not accept JPEG attachments");
      await assertImageRoute(context, exec);
      const resource = await provider.fetchResource(args.url, exec.signal, {
        maxBytes: config.maxPdfBytes,
        accept: "application/pdf",
      });
      if (resource.statusCode < 200 || resource.statusCode >= 300) {
        throw new Error(`PDF request returned HTTP ${resource.statusCode}`);
      }
      if (resource.truncated) throw new PdfError(`PDF exceeds ${config.maxPdfBytes} bytes`, "WEB_FETCH_TOO_LARGE");
      const rendered = await provider.pdfProcessor.renderPages(resource.bytes, pages, exec.signal);
      const inputs = rendered.pages.map((page) => ({ data: page.data, mediaType: "image/jpeg", name: `pdf-page-${page.page}.jpg` }));
      const refs = await attachments.saveImages(inputs);
      return {
        url: resource.url,
        pageCount: rendered.pageCount,
        pages: rendered.pages.map((page, index) => ({ page: page.page, image: refs[index] })),
      };
    },
    presentCall(args) {
      const pages = Array.isArray(args.pages) && args.pages.length > 0 ? ` pages ${args.pages.join(", ")}` : " first pages";
      return { card: "web", kind: "fetch", title: `Render PDF${pages}`, url: args.url };
    },
  }));
}

export { positiveUniquePages, renderValue };

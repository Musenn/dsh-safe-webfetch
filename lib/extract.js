import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const REMOVE_SELECTORS = "script,style,noscript,iframe,object,embed,form,input,button,template";
const DYNAMIC_MARKERS = [
  "id=\"__next\"",
  "id='__next'",
  "id=\"root\"",
  "id='root'",
  "enable javascript",
  "just a moment",
  "cf-chl-",
  "captcha",
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cleanDocument(document, baseUrl) {
  for (const node of document.querySelectorAll(REMOVE_SELECTORS)) node.remove();
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "srcdoc") element.removeAttribute(attribute.name);
    }
    for (const name of ["href", "src", "poster"]) {
      const value = element.getAttribute(name);
      if (!value) continue;
      try {
        const resolved = new URL(value, baseUrl);
        if (resolved.protocol === "http:" || resolved.protocol === "https:") element.setAttribute(name, resolved.toString());
        else element.removeAttribute(name);
      } catch {
        element.removeAttribute(name);
      }
    }
    element.removeAttribute("srcset");
  }
  return document;
}

function visibleLength(document) {
  return (document.body?.textContent ?? document.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function browserNote(html, textLength, statusCode) {
  const lower = html.toLowerCase();
  const challenge = statusCode === 401 || statusCode === 403 || statusCode === 429 || statusCode === 503
    || DYNAMIC_MARKERS.some((marker) => lower.includes(marker));
  if (!challenge || textLength >= 1200) return "";
  return "<aside><strong>Browser fallback:</strong> This response appears to require JavaScript, authentication, or challenge handling. Use browser_open followed by browser_content for the same URL.</aside>";
}

export function extractReadableHtml(html, url, options = {}) {
  const minReadableChars = options.minReadableChars ?? 180;
  const statusCode = options.statusCode ?? 200;
  const source = parseHTML(html).document;
  const sourceLength = visibleLength(source);
  const note = browserNote(html, sourceLength, statusCode);

  let article;
  try {
    const readable = parseHTML(`<base href="${escapeHtml(url)}">${html}`).document;
    article = new Readability(readable, { charThreshold: minReadableChars }).parse();
  } catch {
    article = null;
  }

  if (article?.content && (article.textContent ?? "").trim().length >= minReadableChars) {
    const articleDocument = cleanDocument(parseHTML(`<html><body>${article.content}</body></html>`).document, url);
    const metadata = [article.byline, article.siteName].filter(Boolean).map(escapeHtml).join(" · ");
    const header = `<header><h1>${escapeHtml(article.title || source.title || url)}</h1>${metadata ? `<p>${metadata}</p>` : ""}</header>`;
    return {
      content: `<article>${note}${header}${articleDocument.body?.innerHTML ?? article.content}</article>`,
      extracted: true,
      browserRecommended: note.length > 0,
    };
  }

  const cleaned = cleanDocument(source, url);
  const body = cleaned.body?.innerHTML ?? cleaned.documentElement?.innerHTML ?? html;
  return {
    content: `<article>${note}${body}</article>`,
    extracted: false,
    browserRecommended: note.length > 0,
  };
}

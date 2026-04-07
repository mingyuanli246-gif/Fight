import {
  NOTE_MATH_SELECTOR,
  readMathLatexFromElement,
} from "./mathSerialization";

const KNOWN_RICH_TEXT_ROOT_PATTERN =
  /^<(p|h1|h2|ul|ol|li|blockquote)(\s|>)/i;
const KNOWN_RICH_TEXT_INLINE_PATTERN = /<(strong|u|br)\b|<\/(strong|u)>/i;
const KNOWN_RICH_TEXT_MATH_PATTERN = /^<(span|div)\b[^>]*data-note-math=/i;
const KNOWN_RICH_TEXT_IMAGE_PATTERN = /^<img\b[^>]*data-note-image=/i;
const SEARCHABLE_BLOCK_SELECTOR =
  "h1, h2, h3, h4, h5, h6, p, li, blockquote, [data-note-math='block']";
const NOTE_IMAGE_SELECTOR = "img[data-note-image='true']";
const EMPTY_EDITOR_DOCUMENT_HTML = "<p></p>";

function createHtmlDocument(content: string) {
  return new DOMParser().parseFromString(content, "text/html");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeMathElements(document: Document) {
  const mathElements = Array.from(
    document.body.querySelectorAll(NOTE_MATH_SELECTOR),
  );

  for (const element of mathElements) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    const latex = readMathLatexFromElement(element);
    element.setAttribute("data-latex", latex);
    element.textContent = latex;
  }
}

function normalizeImageElements(document: Document) {
  const imageElements = Array.from(document.body.querySelectorAll(NOTE_IMAGE_SELECTOR));

  for (const element of imageElements) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    element.setAttribute("data-note-image", "true");

    if (!element.hasAttribute("alt")) {
      element.setAttribute("alt", "");
    }
  }
}

function hasContentfulImage(document: Document) {
  return document.body.querySelector(NOTE_IMAGE_SELECTOR) !== null;
}

function looksLikeStoredRichTextHtml(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  return (
    KNOWN_RICH_TEXT_ROOT_PATTERN.test(trimmed) ||
    KNOWN_RICH_TEXT_INLINE_PATTERN.test(trimmed) ||
    KNOWN_RICH_TEXT_MATH_PATTERN.test(trimmed) ||
    KNOWN_RICH_TEXT_IMAGE_PATTERN.test(trimmed)
  );
}

function convertPlainTextToHtml(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n");

  if (!normalized.trim()) {
    return "";
  }

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => escapeHtml(line))
        .join("<br>"),
    )
    .map((paragraph) => `<p>${paragraph || "<br>"}</p>`)
    .join("");
}

export function normalizeEditorHtmlForStorage(html: string) {
  const trimmed = html.trim();

  if (!trimmed) {
    return "";
  }

  const document = createHtmlDocument(trimmed);
  normalizeMathElements(document);
  normalizeImageElements(document);
  const textContent = normalizeText(document.body.textContent ?? "");

  if (!textContent && !hasContentfulImage(document)) {
    return "";
  }

  return document.body.innerHTML.trim();
}

export function toEditorHtml(storedContent: string | null) {
  if (!storedContent) {
    return "";
  }

  if (looksLikeStoredRichTextHtml(storedContent)) {
    return normalizeEditorHtmlForStorage(storedContent);
  }

  return convertPlainTextToHtml(storedContent);
}

export function toEditorDocumentContent(storedContent: string | null) {
  const normalizedHtml = toEditorHtml(storedContent);
  return normalizedHtml || EMPTY_EDITOR_DOCUMENT_HTML;
}

// 当前搜索索引的权威提取实现位于 Rust command 中。
// 这里保留等价语义的前端辅助函数，供后续编辑器扩展和开发态调试复用。
export function extractIndexablePlainText(storedContent: string | null) {
  if (!storedContent) {
    return "";
  }

  if (!looksLikeStoredRichTextHtml(storedContent)) {
    return normalizeText(storedContent);
  }

  const document = createHtmlDocument(storedContent);
  normalizeMathElements(document);
  normalizeImageElements(document);
  const blockTexts = Array.from(
    document.body.querySelectorAll(SEARCHABLE_BLOCK_SELECTOR),
  )
    .map((element) => normalizeText(element.textContent ?? ""))
    .filter(Boolean);
  const imageAltTexts = Array.from(document.body.querySelectorAll(NOTE_IMAGE_SELECTOR))
    .map((element) =>
      element instanceof HTMLElement
        ? normalizeText(element.getAttribute("alt") ?? "")
        : "",
    )
    .filter(Boolean);
  const searchableTexts = [...blockTexts, ...imageAltTexts];

  if (searchableTexts.length > 0) {
    return searchableTexts.join("\n");
  }

  return normalizeText(document.body.textContent ?? "");
}

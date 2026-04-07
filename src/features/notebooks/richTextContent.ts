const KNOWN_RICH_TEXT_ROOT_PATTERN =
  /^<(p|h1|h2|ul|ol|li|blockquote)(\s|>)/i;
const KNOWN_RICH_TEXT_INLINE_PATTERN = /<(strong|u|br)\b|<\/(strong|u)>/i;
const SEARCHABLE_BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, li, blockquote";
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

function looksLikeStoredRichTextHtml(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  return (
    KNOWN_RICH_TEXT_ROOT_PATTERN.test(trimmed) ||
    KNOWN_RICH_TEXT_INLINE_PATTERN.test(trimmed)
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
  const textContent = normalizeText(document.body.textContent ?? "");

  if (!textContent) {
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

// 未来接入 FTS 时，不直接索引 HTML，而是先从当前存库内容中提取纯文本。
// 该函数保留段落/列表的换行边界，供后续搜索索引层复用。
export function extractIndexablePlainText(storedContent: string | null) {
  if (!storedContent) {
    return "";
  }

  if (!looksLikeStoredRichTextHtml(storedContent)) {
    return normalizeText(storedContent);
  }

  const document = createHtmlDocument(storedContent);
  const blockTexts = Array.from(
    document.body.querySelectorAll(SEARCHABLE_BLOCK_SELECTOR),
  )
    .map((element) => normalizeText(element.textContent ?? ""))
    .filter(Boolean);

  if (blockTexts.length > 0) {
    return blockTexts.join("\n");
  }

  return normalizeText(document.body.textContent ?? "");
}

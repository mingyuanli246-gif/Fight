export const EDITOR_FONT_FAMILY_NAMES = [
  "modernSans",
  "elegantSerif",
  "systemDefault",
  "sourceSans",
  "sourceSerif",
  "lxgwWenkai",
  "pingfangSans",
  "songtiReading",
] as const;

export type EditorFontFamilyName =
  (typeof EDITOR_FONT_FAMILY_NAMES)[number];

export const DEFAULT_EDITOR_FONT_FAMILY: EditorFontFamilyName = "modernSans";

export const EDITOR_FONT_FAMILY_STACKS: Record<
  EditorFontFamilyName,
  string
> = {
  modernSans:
    'Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif',
  elegantSerif:
    '"Source Han Serif SC", "Noto Serif SC", "Songti SC", "STSong", "SimSun", serif',
  systemDefault:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  sourceSans:
    '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  sourceSerif:
    '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
  lxgwWenkai: '"LXGW WenKai", "Kaiti SC", "KaiTi", serif',
  pingfangSans:
    '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  songtiReading: '"Songti SC", "SimSun", serif',
};

export const EDITOR_FONT_FAMILY_OPTIONS = [
  {
    value: "modernSans",
    label: "现代无衬线",
    description: "清晰克制，适合日常知识整理与长文阅读。",
  },
  {
    value: "elegantSerif",
    label: "优雅衬线体",
    description: "更接近教材与纸面阅读感，正文层次更稳。",
  },
  {
    value: "systemDefault",
    label: "系统默认",
    description: "贴近当前系统字体风格，兼顾中文稳定显示。",
  },
  {
    value: "sourceSans",
    label: "思源黑体",
    description: "开源黑体字栈，适合清晰稳定的中文界面与笔记正文。",
  },
  {
    value: "sourceSerif",
    label: "思源宋体",
    description: "开源宋体字栈，适合教材式阅读和长段文字。",
  },
  {
    value: "lxgwWenkai",
    label: "霞鹜文楷",
    description: "偏手写楷体气质，适合轻松的学习笔记。",
  },
  {
    value: "pingfangSans",
    label: "苹方黑体",
    description: "贴近 macOS 中文系统字体，清爽现代。",
  },
  {
    value: "songtiReading",
    label: "宋体阅读",
    description: "传统宋体阅读栈，适合安静的正文阅读。",
  },
] as const satisfies ReadonlyArray<{
  value: EditorFontFamilyName;
  label: string;
  description: string;
}>;

export function normalizeEditorFontFamily(
  value: unknown,
): EditorFontFamilyName {
  if (
    typeof value === "string" &&
    EDITOR_FONT_FAMILY_NAMES.includes(value as EditorFontFamilyName)
  ) {
    return value as EditorFontFamilyName;
  }

  return DEFAULT_EDITOR_FONT_FAMILY;
}

export function getEditorFontFamilyStack(value: EditorFontFamilyName) {
  return EDITOR_FONT_FAMILY_STACKS[normalizeEditorFontFamily(value)];
}

export function applyEditorFontFamilyPreference(value: EditorFontFamilyName) {
  if (typeof document === "undefined") {
    return;
  }

  const normalized = normalizeEditorFontFamily(value);
  document.documentElement.dataset.editorFontFamily = normalized;
  document.documentElement.style.setProperty(
    "--editor-font-family",
    getEditorFontFamilyStack(normalized),
  );
}

export const NOTE_EDITOR_PREVIEW_HTML = [
  "<h1>牛顿力学导论</h1>",
  "<p>运动学是力学的一个分支，研究物体运动状态随时间的变化。</p>",
].join("");

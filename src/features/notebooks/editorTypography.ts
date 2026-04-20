export const EDITOR_FONT_FAMILY_NAMES = [
  "modernSans",
  "elegantSerif",
  "systemDefault",
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
  "<p>运动学是力学的一个分支，研究物体的运动状态随时间的变化，而不涉及引起这种运动的力。在这一章节中，我们主要关注位移、速度和加速度。位移是矢量，表示位置的变化；速度是位移对时间的变化率，而加速度则是速度对时间的变化率。</p>",
  "<h2>匀变速直线运动</h2>",
  "<p>对于匀变速直线运动，我们可以通过一系列经典公式来描述物体的轨迹。将正文排版控制在稳定行长内，可以明显降低长段阅读疲劳，也更接近教材与笔记的密度感。</p>",
  "<ul><li>位移与时间的关系需要保持清晰推导。</li><li>速度与加速度的定义要在同一阅读节奏内展开。</li></ul>",
].join("");

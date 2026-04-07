export type MarkdownShortcutId =
  | "heading-1"
  | "heading-2"
  | "bullet-list-dash"
  | "bullet-list-asterisk"
  | "ordered-list-1";

export type ReservedEditorShortcutId = "latex-block-future";

interface BaseShortcutDescriptor<Id extends string, Kind extends string> {
  id: Id;
  kind: Kind;
  label: string;
  trigger: string;
  find: RegExp;
  enabled: boolean;
  description: string;
}

export interface HeadingMarkdownShortcutDescriptor
  extends BaseShortcutDescriptor<MarkdownShortcutId, "heading"> {
  level: 1 | 2;
}

export interface BulletListMarkdownShortcutDescriptor
  extends BaseShortcutDescriptor<MarkdownShortcutId, "bulletList"> {
  marker: "-" | "*";
}

export interface OrderedListMarkdownShortcutDescriptor
  extends BaseShortcutDescriptor<MarkdownShortcutId, "orderedList"> {
  start: 1;
}

export type MarkdownShortcutDescriptor =
  | HeadingMarkdownShortcutDescriptor
  | BulletListMarkdownShortcutDescriptor
  | OrderedListMarkdownShortcutDescriptor;

export interface ReservedEditorShortcutDescriptor
  extends BaseShortcutDescriptor<ReservedEditorShortcutId, "reserved"> {
  capability: "latex";
}

export const MARKDOWN_SHORTCUTS = [
  {
    id: "heading-1",
    kind: "heading",
    label: "一级标题",
    trigger: "# ",
    find: /^#\s$/,
    enabled: true,
    description: "在空段落起始处输入 # 空格，转换为一级标题。",
    level: 1,
  },
  {
    id: "heading-2",
    kind: "heading",
    label: "二级标题",
    trigger: "## ",
    find: /^##\s$/,
    enabled: true,
    description: "在空段落起始处输入 ## 空格，转换为二级标题。",
    level: 2,
  },
  {
    id: "bullet-list-dash",
    kind: "bulletList",
    label: "无序列表（短横线）",
    trigger: "- ",
    find: /^-\s$/,
    enabled: true,
    description: "在空段落起始处输入 - 空格，转换为无序列表。",
    marker: "-",
  },
  {
    id: "bullet-list-asterisk",
    kind: "bulletList",
    label: "无序列表（星号）",
    trigger: "* ",
    find: /^\*\s$/,
    enabled: true,
    description: "在空段落起始处输入 * 空格，转换为无序列表。",
    marker: "*",
  },
  {
    id: "ordered-list-1",
    kind: "orderedList",
    label: "有序列表",
    trigger: "1. ",
    find: /^1\.\s$/,
    enabled: true,
    description: "在空段落起始处输入 1. 空格，转换为从 1 开始的有序列表。",
    start: 1,
  },
] satisfies readonly MarkdownShortcutDescriptor[];

export const RESERVED_EDITOR_SHORTCUTS = [
  {
    id: "latex-block-future",
    kind: "reserved",
    capability: "latex",
    label: "LaTeX 块公式",
    trigger: "$$",
    find: /^\$\$$/,
    enabled: false,
    description: "后续阶段预留给 LaTeX 块公式的快捷输入。",
  },
] satisfies readonly ReservedEditorShortcutDescriptor[];

export const MARKDOWN_SHORTCUT_HINT =
  "支持 #、##、-、*、1. 等快捷输入。";

export function findMarkdownShortcut(
  inputText: string,
): MarkdownShortcutDescriptor | null {
  return (
    MARKDOWN_SHORTCUTS.find((shortcut) => shortcut.find.test(inputText)) ?? null
  );
}

export function findReservedEditorShortcut(
  inputText: string,
): ReservedEditorShortcutDescriptor | null {
  return (
    RESERVED_EDITOR_SHORTCUTS.find((shortcut) => shortcut.find.test(inputText)) ??
    null
  );
}

import type { Extensions } from "@tiptap/core";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { MarkdownShortcuts } from "./editorInputRules";
import { NoteImage } from "./imageNodes";
import { BlockMath, InlineMath, type EditorMathBridge } from "./mathNodes";
import { createTextTagExtensions } from "./textTags";

// 仅对白名单扩展启用输入规则，避免 StarterKit 默认更宽的 Markdown 规则进入 MVP。
export const NOTE_EDITOR_ENABLED_INPUT_RULES = ["markdownShortcuts"];

export interface NotebookEditorExtensionBridge {
  mathBridge: EditorMathBridge;
}

export function createNotebookEditorExtensions(
  bridge: NotebookEditorExtensionBridge,
): Extensions {
  return [
    StarterKit.configure({
      heading: {
        levels: [1, 2],
      },
    }),
    ...createTextTagExtensions(),
    Underline,
    TextAlign.configure({
      types: ["heading", "paragraph"],
      alignments: ["center"],
    }),
    NoteImage,
    InlineMath.configure({
      bridge: bridge.mathBridge,
    }),
    BlockMath.configure({
      bridge: bridge.mathBridge,
    }),
    MarkdownShortcuts,
  ];
}

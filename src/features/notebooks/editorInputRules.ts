import {
  Extension,
  textblockTypeInputRule,
  type InputRule,
  wrappingInputRule,
} from "@tiptap/core";
import type { NodeType } from "@tiptap/pm/model";
import {
  MARKDOWN_SHORTCUTS,
  type MarkdownShortcutDescriptor,
} from "./editorShortcuts";

function createMarkdownShortcutInputRule(
  shortcut: MarkdownShortcutDescriptor,
  nodeTypes: {
    heading: NodeType;
    bulletList: NodeType;
    orderedList: NodeType;
  },
): InputRule {
  switch (shortcut.kind) {
    case "heading":
      return textblockTypeInputRule({
        find: shortcut.find,
        type: nodeTypes.heading,
        getAttributes: {
          level: shortcut.level,
        },
      });
    case "bulletList":
      return wrappingInputRule({
        find: shortcut.find,
        type: nodeTypes.bulletList,
        // 第十一阶段只做显式输入转换，不在输入规则阶段追加相邻列表合并推断。
        joinPredicate: () => false,
      });
    case "orderedList":
      return wrappingInputRule({
        find: shortcut.find,
        type: nodeTypes.orderedList,
        getAttributes: {
          start: shortcut.start,
        },
        joinPredicate: () => false,
      });
  }
}

export const MarkdownShortcuts = Extension.create({
  name: "markdownShortcuts",

  addInputRules() {
    const heading = this.editor.schema.nodes.heading;
    const bulletList = this.editor.schema.nodes.bulletList;
    const orderedList = this.editor.schema.nodes.orderedList;

    if (!heading || !bulletList || !orderedList) {
      return [];
    }

    return MARKDOWN_SHORTCUTS.map((shortcut) =>
      createMarkdownShortcutInputRule(shortcut, {
        heading,
        bulletList,
        orderedList,
      }),
    );
  },
});

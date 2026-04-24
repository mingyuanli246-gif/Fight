import type { Editor } from "@tiptap/react";
import { normalizeManagedResourcePath } from "./editorResources";
import {
  findMarkdownShortcut,
  findReservedEditorShortcut,
  type MarkdownShortcutId,
  type ReservedEditorShortcutId,
} from "./editorShortcuts";
import {
  DEFAULT_NOTE_IMAGE_DISPLAY_SIZE,
  NOTE_IMAGE_NODE_NAME,
} from "./imageNodes";
import { validateMathLatex } from "./mathRender";
import {
  BLOCK_MATH_NODE_NAME,
  INLINE_MATH_NODE_NAME,
  type MathDisplayMode,
  type MathNodeName,
} from "./mathSerialization";

export interface ImageCommandHandledResult {
  status: "handled";
  capability: "images";
  resourcePath: string;
  alt: string;
  message: string;
}

export interface ImageCommandFailedResult {
  status: "failed";
  capability: "images";
  resourcePath: string;
  alt: string;
  message: string;
}

export type ImageCommandResult =
  | ImageCommandHandledResult
  | ImageCommandFailedResult;

export interface MathCommandHandledResult {
  status: "handled";
  capability: "latex";
  nodeType: MathNodeName;
  latex: string;
  message: string;
}

export interface MathCommandInvalidResult {
  status: "invalid";
  capability: "latex";
  nodeType: MathNodeName;
  latex: string;
  message: string;
}

export interface MathCommandFailedResult {
  status: "failed";
  capability: "latex";
  nodeType: MathNodeName;
  latex: string;
  message: string;
}

export type MathCommandResult =
  | MathCommandHandledResult
  | MathCommandInvalidResult
  | MathCommandFailedResult;

export interface MarkdownShortcutHandledResult {
  status: "handled";
  capability: "markdownShortcuts";
  shortcutId: MarkdownShortcutId;
  message: string;
}

export interface MarkdownShortcutReservedResult {
  status: "reserved";
  capability: "markdownShortcuts";
  shortcutId: ReservedEditorShortcutId;
  message: string;
}

export interface MarkdownShortcutUnsupportedResult {
  status: "unsupported";
  capability: "markdownShortcuts";
  inputText: string;
  message: string;
}

export type MarkdownShortcutCommandResult =
  | MarkdownShortcutHandledResult
  | MarkdownShortcutReservedResult
  | MarkdownShortcutUnsupportedResult;

export interface UpdateMathNodeLatexInput {
  position: number;
  nodeType: MathNodeName;
  latex: string;
}

function validateMathCommand(
  latex: string,
  displayMode: MathDisplayMode,
  nodeType: MathNodeName,
): MathCommandInvalidResult | null {
  const validationResult = validateMathLatex(latex, displayMode);

  if (validationResult.status === "valid") {
    return null;
  }

  return {
    status: "invalid",
    capability: "latex",
    nodeType,
    latex: validationResult.latex,
    message: validationResult.message,
  };
}

function toHandledMathResult(
  nodeType: MathNodeName,
  latex: string,
  message: string,
): MathCommandHandledResult {
  return {
    status: "handled",
    capability: "latex",
    nodeType,
    latex,
    message,
  };
}

export interface InsertNoteImageInput {
  resourcePath: string;
  alt?: string;
}

export function insertNoteImage(
  editor: Editor | null,
  input: InsertNoteImageInput,
): ImageCommandResult {
  let normalizedResourcePath: string;

  try {
    normalizedResourcePath = normalizeManagedResourcePath(input.resourcePath);
  } catch (error) {
    return {
      status: "failed",
      capability: "images",
      resourcePath: input.resourcePath,
      alt: input.alt?.trim() ?? "",
      message:
        error instanceof Error && error.message.trim()
          ? error.message
          : "图片资源路径无效。",
    };
  }

  const normalizedAlt = input.alt?.trim() ?? "";

  if (!editor) {
    return {
      status: "failed",
      capability: "images",
      resourcePath: normalizedResourcePath,
      alt: normalizedAlt,
      message: "编辑器尚未就绪，暂时无法插入图片。",
    };
  }

  const success = editor
    .chain()
    .focus()
    .insertContent([
      {
        type: NOTE_IMAGE_NODE_NAME,
        attrs: {
          resourcePath: normalizedResourcePath,
          alt: normalizedAlt,
          displaySize: DEFAULT_NOTE_IMAGE_DISPLAY_SIZE,
        },
      },
      {
        type: "paragraph",
      },
    ])
    .run();

  if (!success) {
    return {
      status: "failed",
      capability: "images",
      resourcePath: normalizedResourcePath,
      alt: normalizedAlt,
      message: "插入图片失败，请稍后重试。",
    };
  }

  return {
    status: "handled",
    capability: "images",
    resourcePath: normalizedResourcePath,
    alt: normalizedAlt,
    message: "图片已插入。",
  };
}

export function insertInlineMath(
  editor: Editor | null,
  latex: string,
): MathCommandResult {
  const validationError = validateMathCommand(
    latex,
    "inline",
    INLINE_MATH_NODE_NAME,
  );

  if (validationError) {
    return validationError;
  }

  if (!editor) {
    return {
      status: "failed",
      capability: "latex",
      nodeType: INLINE_MATH_NODE_NAME,
      latex,
      message: "编辑器尚未就绪，暂时无法插入行内公式。",
    };
  }

  const success = editor
    .chain()
    .focus()
    .insertContent({
      type: INLINE_MATH_NODE_NAME,
      attrs: { latex: latex.trim() },
    })
    .run();

  if (!success) {
    return {
      status: "failed",
      capability: "latex",
      nodeType: INLINE_MATH_NODE_NAME,
      latex: latex.trim(),
      message: "插入行内公式失败，请稍后重试。",
    };
  }

  return toHandledMathResult(
    INLINE_MATH_NODE_NAME,
    latex.trim(),
    "行内公式已插入。",
  );
}

export function insertBlockMath(
  editor: Editor | null,
  latex: string,
): MathCommandResult {
  const validationError = validateMathCommand(
    latex,
    "block",
    BLOCK_MATH_NODE_NAME,
  );

  if (validationError) {
    return validationError;
  }

  if (!editor) {
    return {
      status: "failed",
      capability: "latex",
      nodeType: BLOCK_MATH_NODE_NAME,
      latex,
      message: "编辑器尚未就绪，暂时无法插入块级公式。",
    };
  }

  const success = editor
    .chain()
    .focus()
    .insertContent([
      {
        type: BLOCK_MATH_NODE_NAME,
        attrs: { latex: latex.trim() },
      },
      {
        type: "paragraph",
      },
    ])
    .run();

  if (!success) {
    return {
      status: "failed",
      capability: "latex",
      nodeType: BLOCK_MATH_NODE_NAME,
      latex: latex.trim(),
      message: "插入块级公式失败，请稍后重试。",
    };
  }

  return toHandledMathResult(
    BLOCK_MATH_NODE_NAME,
    latex.trim(),
    "块级公式已插入。",
  );
}

export function updateMathNodeLatex(
  editor: Editor | null,
  input: UpdateMathNodeLatexInput,
): MathCommandResult {
  const displayMode = input.nodeType === INLINE_MATH_NODE_NAME ? "inline" : "block";
  const validationError = validateMathCommand(
    input.latex,
    displayMode,
    input.nodeType,
  );

  if (validationError) {
    return validationError;
  }

  if (!editor) {
    return {
      status: "failed",
      capability: "latex",
      nodeType: input.nodeType,
      latex: input.latex,
      message: "编辑器尚未就绪，暂时无法更新公式。",
    };
  }

  const normalizedLatex = input.latex.trim();
  const success = editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      const targetNode = tr.doc.nodeAt(input.position);

      if (!targetNode || targetNode.type.name !== input.nodeType) {
        return false;
      }

      if (dispatch) {
        tr.setNodeMarkup(input.position, targetNode.type, {
          ...targetNode.attrs,
          latex: normalizedLatex,
        });
        dispatch(tr.scrollIntoView());
      }

      return true;
    })
    .run();

  if (!success) {
    return {
      status: "failed",
      capability: "latex",
      nodeType: input.nodeType,
      latex: normalizedLatex,
      message: "目标公式不存在或已变化，请取消后重试。",
    };
  }

  return toHandledMathResult(input.nodeType, normalizedLatex, "公式已更新。");
}

export function applyMarkdownShortcutRule(
  editor: Editor | null,
  inputText: string,
): MarkdownShortcutCommandResult {
  void editor;

  const matchedShortcut = findMarkdownShortcut(inputText);

  if (matchedShortcut !== null) {
    return {
      status: "handled",
      capability: "markdownShortcuts",
      shortcutId: matchedShortcut.id,
      message: `已识别 ${matchedShortcut.label} 快捷输入。`,
    };
  }

  const reservedShortcut = findReservedEditorShortcut(inputText);

  if (reservedShortcut !== null) {
    return {
      status: "reserved",
      capability: "markdownShortcuts",
      shortcutId: reservedShortcut.id,
      message: `${reservedShortcut.label} 快捷输入将在后续阶段启用。`,
    };
  }

  return {
    status: "unsupported",
    capability: "markdownShortcuts",
    inputText,
    message: "当前仅支持 #、##、-、*、1. 的 Markdown 快捷输入。",
  };
}

import { mergeAttributes, Node } from "@tiptap/core";
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import styles from "./NoteEditorSurface.module.css";
import { renderMathToHtml } from "./mathRender";
import {
  BLOCK_MATH_NODE_NAME,
  buildMathDataAttributes,
  getMathHtmlTag,
  INLINE_MATH_NODE_NAME,
  readMathLatexFromElement,
  sanitizeMathLatex,
  type MathDisplayMode,
  type MathNodeName,
} from "./mathSerialization";

export interface MathEditRequest {
  displayMode: MathDisplayMode;
  nodeType: MathNodeName;
  latex: string;
  position: number;
}

export interface MathRenderErrorPayload {
  displayMode: MathDisplayMode;
  nodeType: MathNodeName;
  latex: string;
  message: string;
}

export interface EditorMathBridge {
  onEditMathRequest: (request: MathEditRequest) => void;
  onMathRenderError?: (payload: MathRenderErrorPayload) => void;
}

interface MathNodeOptions {
  bridge: EditorMathBridge;
  HTMLAttributes: Record<string, string>;
}

function resolveNodePosition(
  getPos: NodeViewRendererProps["getPos"],
): number | null {
  if (typeof getPos !== "function") {
    return null;
  }

  const position = getPos();
  return typeof position === "number" ? position : null;
}

function renderMathNodeContent(
  container: HTMLElement,
  node: ProseMirrorNode,
  displayMode: MathDisplayMode,
  bridge: EditorMathBridge,
) {
  const latex = sanitizeMathLatex(String(node.attrs.latex ?? ""));
  container.setAttribute("title", "双击编辑公式");
  container.setAttribute("aria-label", `${displayMode === "inline" ? "行内" : "块级"}公式`);
  container.setAttribute("data-note-math-rendered", displayMode);
  container.setAttribute("data-note-math-source", latex);

  try {
    container.classList.remove(styles.mathNodeError);
    container.innerHTML = renderMathToHtml(latex, displayMode);
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : "公式渲染失败";

    bridge.onMathRenderError?.({
      displayMode,
      nodeType:
        displayMode === "inline" ? INLINE_MATH_NODE_NAME : BLOCK_MATH_NODE_NAME,
      latex,
      message,
    });

    container.innerHTML = "";
    container.classList.add(styles.mathNodeError);

    const errorTitle = document.createElement("span");
    errorTitle.className = styles.mathNodeErrorTitle;
    errorTitle.textContent = "公式渲染失败";

    const source = document.createElement("code");
    source.className = styles.mathNodeSource;
    source.textContent = latex || "(空公式)";

    const hint = document.createElement("span");
    hint.className = styles.mathNodeHint;
    hint.textContent = "双击编辑公式";

    container.append(errorTitle, source, hint);
  }
}

function createMathNodeView(
  props: NodeViewRendererProps,
  options: {
    displayMode: MathDisplayMode;
    bridge: EditorMathBridge;
  },
) {
  const tagName = getMathHtmlTag(options.displayMode);
  const dom = document.createElement(tagName);
  let currentNode = props.node;

  dom.contentEditable = "false";
  dom.classList.add(
    styles.mathNode,
    options.displayMode === "inline"
      ? styles.mathNodeInline
      : styles.mathNodeBlock,
  );

  function paint(node: ProseMirrorNode) {
    const latex = sanitizeMathLatex(String(node.attrs.latex ?? ""));
    const mathAttributes = buildMathDataAttributes(options.displayMode, latex);
    dom.setAttribute("data-note-math", mathAttributes["data-note-math"]);
    dom.setAttribute("data-latex", mathAttributes["data-latex"]);
    renderMathNodeContent(dom, node, options.displayMode, options.bridge);
  }

  function handleDoubleClick(event: Event) {
    event.preventDefault();
    event.stopPropagation();

    const position = resolveNodePosition(props.getPos);

    if (position === null) {
      return;
    }

    options.bridge.onEditMathRequest({
      displayMode: options.displayMode,
      nodeType:
        options.displayMode === "inline"
          ? INLINE_MATH_NODE_NAME
          : BLOCK_MATH_NODE_NAME,
      latex: sanitizeMathLatex(String(currentNode.attrs.latex ?? "")),
      position,
    });
  }

  dom.addEventListener("dblclick", handleDoubleClick);
  paint(currentNode);

  return {
    dom,
    update(updatedNode: ProseMirrorNode) {
      if (updatedNode.type !== currentNode.type) {
        return false;
      }

      currentNode = updatedNode;
      paint(updatedNode);
      return true;
    },
    selectNode() {
      dom.classList.add(styles.mathNodeSelected);
    },
    deselectNode() {
      dom.classList.remove(styles.mathNodeSelected);
    },
    ignoreMutation() {
      return true;
    },
    destroy() {
      dom.removeEventListener("dblclick", handleDoubleClick);
    },
  };
}

function createMathNode(config: {
  name: MathNodeName;
  displayMode: MathDisplayMode;
}) {
  const tagName = getMathHtmlTag(config.displayMode);

  return Node.create<MathNodeOptions>({
    name: config.name,

    group: config.displayMode === "inline" ? "inline" : "block",
    inline: config.displayMode === "inline",
    atom: true,
    selectable: true,

    addOptions() {
      return {
        bridge: {
          onEditMathRequest() {
            // 运行时由 NoteEditorPane 注入真实桥接。
          },
        },
        HTMLAttributes: {},
      };
    },

    addAttributes() {
      return {
        latex: {
          default: "",
          parseHTML: (element) => {
            if (!(element instanceof HTMLElement)) {
              return "";
            }

            return readMathLatexFromElement(element);
          },
          renderHTML: (attributes) => {
            const latex = sanitizeMathLatex(String(attributes.latex ?? ""));
            return buildMathDataAttributes(config.displayMode, latex);
          },
        },
      };
    },

    parseHTML() {
      return [
        {
          tag: `${tagName}[data-note-math="${config.displayMode}"]`,
          getAttrs: (element) => {
            if (!(element instanceof HTMLElement)) {
              return false;
            }

            return {
              latex: readMathLatexFromElement(element),
            };
          },
        },
      ];
    },

    renderHTML({ HTMLAttributes, node }) {
      const latex = sanitizeMathLatex(String(node.attrs.latex ?? ""));

      return [
        tagName,
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
        latex,
      ];
    },

    addNodeView() {
      return (props) =>
        createMathNodeView(props, {
          displayMode: config.displayMode,
          bridge: this.options.bridge,
        });
    },
  });
}

export const InlineMath = createMathNode({
  name: INLINE_MATH_NODE_NAME,
  displayMode: "inline",
});

export const BlockMath = createMathNode({
  name: BLOCK_MATH_NODE_NAME,
  displayMode: "block",
});

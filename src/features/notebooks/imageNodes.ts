import { mergeAttributes, Node } from "@tiptap/core";
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import {
  MISSING_RESOURCE_MESSAGE,
  resolveLocalResourcePath,
} from "./editorResources";
import styles from "./NoteEditorSurface.module.css";

export const NOTE_IMAGE_NODE_NAME = "noteImage";
const NOTE_IMAGE_ATTRIBUTE = "data-note-image";
const NOTE_IMAGE_RESOURCE_ATTRIBUTE = "data-resource-path";
const NOTE_IMAGE_DISPLAY_SIZE_ATTRIBUTE = "data-display-size";
const NOTE_IMAGE_WIDTH_PX_ATTRIBUTE = "data-width-px";
const MIN_NOTE_IMAGE_WIDTH_PX = 120;

export const NOTE_IMAGE_DISPLAY_SIZES = [
  "default",
  "small",
  "medium",
  "large",
] as const;

export type NoteImageDisplaySize =
  (typeof NOTE_IMAGE_DISPLAY_SIZES)[number];

export const DEFAULT_NOTE_IMAGE_DISPLAY_SIZE: NoteImageDisplaySize = "default";

export function normalizeNoteImageDisplaySize(
  value: unknown,
): NoteImageDisplaySize {
  if (
    typeof value === "string" &&
    NOTE_IMAGE_DISPLAY_SIZES.includes(value as NoteImageDisplaySize)
  ) {
    return value as NoteImageDisplaySize;
  }

  return DEFAULT_NOTE_IMAGE_DISPLAY_SIZE;
}

function normalizeNoteImageWidthPx(value: unknown) {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return Math.round(numericValue);
}

interface NoteImageNodeOptions {
  HTMLAttributes: Record<string, string>;
}

function createImageFallback(
  container: HTMLElement,
  title: string,
  detail: string,
) {
  container.innerHTML = "";
  container.classList.add(styles.noteImageFallback);

  const titleElement = document.createElement("strong");
  titleElement.className = styles.noteImageFallbackTitle;
  titleElement.textContent = title;

  const detailElement = document.createElement("span");
  detailElement.className = styles.noteImageFallbackText;
  detailElement.textContent = detail;

  container.append(titleElement, detailElement);
}

function createNoteImageNodeView(props: NodeViewRendererProps) {
  const dom = document.createElement("div");
  const frame = document.createElement("div");
  const mediaContainer = document.createElement("div");
  const resizeHandle = document.createElement("button");
  let currentNode = props.node;
  let renderVersion = 0;
  let isNodeSelected = false;
  let isUserActivatedSelection = false;
  let dragState:
    | {
        pointerId: number;
        startClientX: number;
        startWidth: number;
        maxWidth: number;
        latestWidth: number;
      }
    | null = null;

  dom.contentEditable = "false";
  dom.classList.add(styles.noteImageNode);
  frame.classList.add(styles.noteImageFrame);
  mediaContainer.classList.add(styles.noteImageMediaContainer);
  resizeHandle.type = "button";
  resizeHandle.classList.add(styles.noteImageResizeHandle);
  resizeHandle.setAttribute("aria-label", "调整图片大小");
  frame.append(mediaContainer, resizeHandle);
  dom.append(frame);

  function getEditorContentWidth() {
    const editorRoot = props.editor.view.dom;
    const rootStyles = window.getComputedStyle(editorRoot);
    const horizontalPadding =
      Number.parseFloat(rootStyles.paddingLeft) +
      Number.parseFloat(rootStyles.paddingRight);
    const contentWidth = editorRoot.clientWidth - horizontalPadding;

    return Math.max(MIN_NOTE_IMAGE_WIDTH_PX, contentWidth || frame.clientWidth);
  }

  function readFrameWidth() {
    const rectWidth = frame.getBoundingClientRect().width;

    if (rectWidth > 0) {
      return rectWidth;
    }

    const widthPx = normalizeNoteImageWidthPx(currentNode.attrs.widthPx);

    return widthPx ?? Math.min(getEditorContentWidth(), 560);
  }

  function setFrameWidth(widthPx: number | null) {
    if (widthPx === null) {
      frame.style.width = "";
      delete dom.dataset.noteImageWidthPx;
      return;
    }

    frame.style.width = `${widthPx}px`;
    dom.dataset.noteImageWidthPx = String(widthPx);
  }

  function syncFrameWidth(node: ProseMirrorNode) {
    setFrameWidth(normalizeNoteImageWidthPx(node.attrs.widthPx));
  }

  function syncSelectionStyle() {
    if (isNodeSelected && isUserActivatedSelection) {
      dom.classList.add(styles.noteImageSelected);
      return;
    }

    dom.classList.remove(styles.noteImageSelected);
  }

  function selectCurrentNode() {
    isUserActivatedSelection = true;
    const position = props.getPos();

    if (typeof position !== "number") {
      syncSelectionStyle();
      return;
    }

    const { state, dispatch } = props.editor.view;
    const selection = NodeSelection.create(state.doc, position);

    if (!selection.eq(state.selection)) {
      dispatch(state.tr.setSelection(selection));
    }

    isNodeSelected = true;
    syncSelectionStyle();
    props.editor.view.focus();
  }

  function clampWidth(widthPx: number, maxWidth: number) {
    return Math.round(
      Math.min(Math.max(widthPx, MIN_NOTE_IMAGE_WIDTH_PX), maxWidth),
    );
  }

  function commitWidth(widthPx: number) {
    const position = props.getPos();

    if (typeof position !== "number") {
      return;
    }

    const { state, dispatch } = props.editor.view;
    const nodeAtPosition = state.doc.nodeAt(position);

    if (!nodeAtPosition || nodeAtPosition.type !== currentNode.type) {
      return;
    }

    const normalizedWidth = normalizeNoteImageWidthPx(widthPx);
    const currentWidth = normalizeNoteImageWidthPx(nodeAtPosition.attrs.widthPx);

    if (normalizedWidth === null || normalizedWidth === currentWidth) {
      syncFrameWidth(nodeAtPosition);
      return;
    }

    const tr = state.tr.setNodeMarkup(position, undefined, {
      ...nodeAtPosition.attrs,
      widthPx: normalizedWidth,
    });

    dispatch(tr);
  }

  function handleResizeMove(event: PointerEvent) {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    event.preventDefault();

    const nextWidth = clampWidth(
      dragState.startWidth + event.clientX - dragState.startClientX,
      dragState.maxWidth,
    );

    dragState.latestWidth = nextWidth;
    setFrameWidth(nextWidth);
  }

  function finishResize(event: PointerEvent) {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    event.preventDefault();
    if (resizeHandle.hasPointerCapture(event.pointerId)) {
      resizeHandle.releasePointerCapture(event.pointerId);
    }

    const finalWidth = dragState.latestWidth;
    dragState = null;
    dom.classList.remove(styles.noteImageResizing);
    commitWidth(finalWidth);
  }

  function cancelResize(event: PointerEvent) {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    if (resizeHandle.hasPointerCapture(event.pointerId)) {
      resizeHandle.releasePointerCapture(event.pointerId);
    }
    dragState = null;
    dom.classList.remove(styles.noteImageResizing);
    syncFrameWidth(currentNode);
  }

  function preventNativeImageInteraction(event: Event) {
    event.preventDefault();
  }

  dom.addEventListener("pointerdown", (event) => {
    if (event.target === resizeHandle || event.button !== 0) {
      return;
    }

    event.preventDefault();
    selectCurrentNode();
  });

  dom.addEventListener("mousedown", (event) => {
    if (event.target !== resizeHandle) {
      event.preventDefault();
    }
  });

  resizeHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    selectCurrentNode();

    const maxWidth = getEditorContentWidth();
    const startWidth = clampWidth(readFrameWidth(), maxWidth);

    dragState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth,
      maxWidth,
      latestWidth: startWidth,
    };
    setFrameWidth(startWidth);
    dom.classList.add(styles.noteImageResizing);
    resizeHandle.setPointerCapture(event.pointerId);
  });

  resizeHandle.addEventListener("pointermove", handleResizeMove);
  resizeHandle.addEventListener("pointerup", finishResize);
  resizeHandle.addEventListener("pointercancel", cancelResize);

  function paint(node: ProseMirrorNode) {
    currentNode = node;
    renderVersion += 1;
    const currentVersion = renderVersion;
    const resourcePath = String(node.attrs.resourcePath ?? "");
    const alt = String(node.attrs.alt ?? "").trim();
    const displaySize = normalizeNoteImageDisplaySize(node.attrs.displaySize);

    dom.dataset.noteImageResourcePath = resourcePath;
    dom.dataset.noteImageDisplaySize = displaySize;
    syncFrameWidth(node);
    frame.classList.remove(styles.noteImageFrameError);
    mediaContainer.classList.remove(styles.noteImageFallback);
    mediaContainer.innerHTML = "";

    const loadingText = document.createElement("span");
    loadingText.className = styles.noteImageLoading;
    loadingText.textContent = "正在加载图片…";
    mediaContainer.append(loadingText);

    void resolveLocalResourcePath(resourcePath).then((result) => {
      if (currentVersion !== renderVersion) {
        return;
      }

      if (result.status !== "resolved") {
        console.error("[resources] 正文图片资源解析失败", {
          resourcePath,
          result,
        });
        frame.classList.add(styles.noteImageFrameError);
        createImageFallback(
          mediaContainer,
          "图片资源不可用",
          result.status === "invalid" ? result.message : MISSING_RESOURCE_MESSAGE,
        );
        return;
      }

      mediaContainer.innerHTML = "";
      mediaContainer.classList.remove(styles.noteImageFallback);
      const image = document.createElement("img");
      image.className = styles.noteImageElement;
      image.alt = alt || "笔记图片";
      image.src = result.assetUrl;
      image.loading = "lazy";
      image.decoding = "async";
      image.draggable = false;
      image.addEventListener("dragstart", preventNativeImageInteraction);
      image.addEventListener("mousedown", preventNativeImageInteraction);
      image.addEventListener("error", () => {
        if (currentVersion !== renderVersion) {
          return;
        }

        console.error("[resources] 正文图片加载失败", {
          resourcePath,
          assetUrl: result.assetUrl,
        });
        frame.classList.add(styles.noteImageFrameError);
        createImageFallback(mediaContainer, "图片资源不可用", MISSING_RESOURCE_MESSAGE);
      });

      mediaContainer.append(image);
    }).catch((error) => {
      if (currentVersion !== renderVersion) {
        return;
      }

      console.error("[resources] 正文图片渲染失败", {
        resourcePath,
        error,
      });
      frame.classList.add(styles.noteImageFrameError);
      createImageFallback(mediaContainer, "图片资源不可用", MISSING_RESOURCE_MESSAGE);
    });
  }

  paint(currentNode);

  return {
    dom,
    update(updatedNode: ProseMirrorNode) {
      if (updatedNode.type !== currentNode.type) {
        return false;
      }

      const nextResourcePath = String(updatedNode.attrs.resourcePath ?? "");
      const nextAlt = String(updatedNode.attrs.alt ?? "").trim();
      const nextDisplaySize = normalizeNoteImageDisplaySize(
        updatedNode.attrs.displaySize,
      );
      const nextWidthPx = normalizeNoteImageWidthPx(updatedNode.attrs.widthPx);
      const currentResourcePath = String(currentNode.attrs.resourcePath ?? "");

      currentNode = updatedNode;
      dom.dataset.noteImageResourcePath = nextResourcePath;
      dom.dataset.noteImageDisplaySize = nextDisplaySize;
      setFrameWidth(nextWidthPx);

      if (nextResourcePath === currentResourcePath) {
        const existingImage = mediaContainer.querySelector("img");

        if (existingImage instanceof HTMLImageElement) {
          existingImage.alt = nextAlt || "笔记图片";
        }

        return true;
      }

      paint(updatedNode);
      return true;
    },
    selectNode() {
      isNodeSelected = true;
      syncSelectionStyle();
    },
    deselectNode() {
      isNodeSelected = false;
      isUserActivatedSelection = false;
      syncSelectionStyle();
    },
    ignoreMutation() {
      return true;
    },
  };
}

export const NoteImage = Node.create<NoteImageNodeOptions>({
  name: NOTE_IMAGE_NODE_NAME,
  group: "block",
  atom: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      resourcePath: {
        default: "",
        parseHTML: (element) =>
          element instanceof HTMLElement
            ? element.getAttribute(NOTE_IMAGE_RESOURCE_ATTRIBUTE) ?? ""
            : "",
        renderHTML: (attributes) => ({
          [NOTE_IMAGE_RESOURCE_ATTRIBUTE]: String(attributes.resourcePath ?? ""),
        }),
      },
      alt: {
        default: "",
        parseHTML: (element) =>
          element instanceof HTMLElement ? element.getAttribute("alt") ?? "" : "",
        renderHTML: (attributes) => ({
          alt: String(attributes.alt ?? ""),
        }),
      },
      displaySize: {
        default: DEFAULT_NOTE_IMAGE_DISPLAY_SIZE,
        parseHTML: (element) =>
          normalizeNoteImageDisplaySize(
            element instanceof HTMLElement
              ? element.getAttribute(NOTE_IMAGE_DISPLAY_SIZE_ATTRIBUTE)
              : null,
          ),
        renderHTML: (attributes) => ({
          [NOTE_IMAGE_DISPLAY_SIZE_ATTRIBUTE]: normalizeNoteImageDisplaySize(
            attributes.displaySize,
          ),
        }),
      },
      widthPx: {
        default: null,
        parseHTML: (element) =>
          element instanceof HTMLElement
            ? normalizeNoteImageWidthPx(
                element.getAttribute(NOTE_IMAGE_WIDTH_PX_ATTRIBUTE),
              )
            : null,
        renderHTML: (attributes) => {
          const widthPx = normalizeNoteImageWidthPx(attributes.widthPx);

          return widthPx === null
            ? {}
            : { [NOTE_IMAGE_WIDTH_PX_ATTRIBUTE]: String(widthPx) };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `img[${NOTE_IMAGE_ATTRIBUTE}="true"]`,
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) {
            return false;
          }

          return {
            resourcePath: element.getAttribute(NOTE_IMAGE_RESOURCE_ATTRIBUTE) ?? "",
            alt: element.getAttribute("alt") ?? "",
            displaySize: normalizeNoteImageDisplaySize(
              element.getAttribute(NOTE_IMAGE_DISPLAY_SIZE_ATTRIBUTE),
            ),
            widthPx: normalizeNoteImageWidthPx(
              element.getAttribute(NOTE_IMAGE_WIDTH_PX_ATTRIBUTE),
            ),
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "img",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        [NOTE_IMAGE_ATTRIBUTE]: "true",
        [NOTE_IMAGE_RESOURCE_ATTRIBUTE]: String(node.attrs.resourcePath ?? ""),
        alt: String(node.attrs.alt ?? ""),
        [NOTE_IMAGE_DISPLAY_SIZE_ATTRIBUTE]: normalizeNoteImageDisplaySize(
          node.attrs.displaySize,
        ),
        ...(normalizeNoteImageWidthPx(node.attrs.widthPx) === null
          ? {}
          : {
              [NOTE_IMAGE_WIDTH_PX_ATTRIBUTE]: String(
                normalizeNoteImageWidthPx(node.attrs.widthPx),
              ),
            }),
      }),
    ];
  },

  addNodeView() {
    return (props) => createNoteImageNodeView(props);
  },
});

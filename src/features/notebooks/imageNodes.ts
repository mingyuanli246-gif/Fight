import { mergeAttributes, Node } from "@tiptap/core";
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  MISSING_RESOURCE_MESSAGE,
  resolveLocalResourcePath,
} from "./editorResources";
import styles from "./NotebookWorkspace.module.css";

export const NOTE_IMAGE_NODE_NAME = "noteImage";
const NOTE_IMAGE_ATTRIBUTE = "data-note-image";
const NOTE_IMAGE_RESOURCE_ATTRIBUTE = "data-resource-path";
const NOTE_IMAGE_DISPLAY_SIZE_ATTRIBUTE = "data-display-size";

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
  let currentNode = props.node;
  let renderVersion = 0;

  dom.contentEditable = "false";
  dom.classList.add(styles.noteImageNode);
  frame.classList.add(styles.noteImageFrame);
  dom.append(frame);

  function paint(node: ProseMirrorNode) {
    currentNode = node;
    renderVersion += 1;
    const currentVersion = renderVersion;
    const resourcePath = String(node.attrs.resourcePath ?? "");
    const alt = String(node.attrs.alt ?? "").trim();
    const displaySize = normalizeNoteImageDisplaySize(node.attrs.displaySize);

    dom.dataset.noteImageResourcePath = resourcePath;
    dom.dataset.noteImageDisplaySize = displaySize;
    frame.classList.remove(styles.noteImageFrameError);
    frame.classList.remove(styles.noteImageFallback);
    frame.innerHTML = "";

    const loadingText = document.createElement("span");
    loadingText.className = styles.noteImageLoading;
    loadingText.textContent = "正在加载图片…";
    frame.append(loadingText);

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
          frame,
          "图片资源不可用",
          result.status === "invalid" ? result.message : MISSING_RESOURCE_MESSAGE,
        );
        return;
      }

      frame.innerHTML = "";
      frame.classList.remove(styles.noteImageFallback);
      const image = document.createElement("img");
      image.className = styles.noteImageElement;
      image.alt = alt || "笔记图片";
      image.src = result.assetUrl;
      image.loading = "lazy";
      image.decoding = "async";
      image.draggable = false;
      image.addEventListener("error", () => {
        if (currentVersion !== renderVersion) {
          return;
        }

        console.error("[resources] 正文图片加载失败", {
          resourcePath,
          assetUrl: result.assetUrl,
        });
        frame.classList.add(styles.noteImageFrameError);
        createImageFallback(frame, "图片资源不可用", MISSING_RESOURCE_MESSAGE);
      });

      frame.append(image);
    }).catch((error) => {
      if (currentVersion !== renderVersion) {
        return;
      }

      console.error("[resources] 正文图片渲染失败", {
        resourcePath,
        error,
      });
      frame.classList.add(styles.noteImageFrameError);
      createImageFallback(frame, "图片资源不可用", MISSING_RESOURCE_MESSAGE);
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
      const currentResourcePath = String(currentNode.attrs.resourcePath ?? "");

      currentNode = updatedNode;
      dom.dataset.noteImageResourcePath = nextResourcePath;
      dom.dataset.noteImageDisplaySize = nextDisplaySize;

      if (nextResourcePath === currentResourcePath) {
        const existingImage = frame.querySelector("img");

        if (existingImage instanceof HTMLImageElement) {
          existingImage.alt = nextAlt || "笔记图片";
        }

        return true;
      }

      paint(updatedNode);
      return true;
    },
    selectNode() {
      dom.classList.add(styles.noteImageSelected);
    },
    deselectNode() {
      dom.classList.remove(styles.noteImageSelected);
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
      }),
    ];
  },

  addNodeView() {
    return (props) => createNoteImageNodeView(props);
  },
});

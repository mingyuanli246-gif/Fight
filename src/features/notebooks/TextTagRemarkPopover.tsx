import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
import type { Editor } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import type { TextTagInspectionState } from "./types";
import styles from "./TextTagRemarkPopover.module.css";

interface TextTagRemarkPopoverProps {
  editor: Editor | null;
  inspectionState: TextTagInspectionState;
  disabled: boolean;
  onRemarkChange: (value: string) => void;
}

const NOTE_TAG_SELECTOR = '[data-note-tag="true"]';
const BLOCK_TAG_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6";
const POPOVER_WIDTH = 336;
const POPOVER_GAP = 12;
const POPOVER_EDGE_PADDING = 12;

function createRectFromOccurrence(editor: Editor, from: number, to: number) {
  const start = editor.view.coordsAtPos(from);
  const end = editor.view.coordsAtPos(to);
  const left = Math.min(start.left, end.left);
  const right = Math.max(start.right, end.right);
  const top = Math.min(start.top, end.top);
  const bottom = Math.max(start.bottom, end.bottom);
  const width = Math.max(right - left, 1);
  const height = Math.max(bottom - top, 1);

  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width,
    height,
    toJSON() {
      return {
        x: left,
        y: top,
        left,
        top,
        right,
        bottom,
        width,
        height,
      };
    },
  } as DOMRect;
}

function createDomRect(
  left: number,
  top: number,
  width: number,
  height: number,
) {
  const right = left + width;
  const bottom = top + height;

  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width,
    height,
    toJSON() {
      return {
        x: left,
        y: top,
        left,
        top,
        right,
        bottom,
        width,
        height,
      };
    },
  } as DOMRect;
}

function getElementFromDomPosition(node: Node | null) {
  if (!node) {
    return null;
  }

  if (node instanceof HTMLElement) {
    return node;
  }

  return node.parentElement;
}

function getOccurrenceRange(editor: Editor, from: number, to: number) {
  try {
    const start = editor.view.domAtPos(from);
    const end = editor.view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    return null;
  }
}

function getOccurrenceTagElement(editor: Editor, from: number, to: number) {
  const range = getOccurrenceRange(editor, from, to);

  if (range) {
    const directCandidates = [
      getElementFromDomPosition(range.startContainer),
      getElementFromDomPosition(range.endContainer),
      getElementFromDomPosition(range.commonAncestorContainer),
    ];

    for (const candidate of directCandidates) {
      const tagElement = candidate?.closest(NOTE_TAG_SELECTOR);

      if (tagElement instanceof HTMLElement) {
        return tagElement;
      }
    }
  }

  return null;
}

function getScrollableAncestor(element: HTMLElement | null) {
  let current = element?.parentElement ?? null;

  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    const isScrollable =
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      current.scrollHeight > current.clientHeight + 1;

    if (isScrollable) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function intersectRects(a: DOMRect, b: DOMRect) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);

  if (right <= left || bottom <= top) {
    return null;
  }

  return createDomRect(left, top, right - left, bottom - top);
}

function getVisibleBoundaryRect(editorRoot: HTMLElement) {
  const rootRect = editorRoot.getBoundingClientRect();
  const scrollContainer = getScrollableAncestor(editorRoot);
  const viewportRect = scrollContainer?.getBoundingClientRect() ?? rootRect;

  return {
    rect: intersectRects(rootRect, viewportRect) ?? rootRect,
    scrollContainer,
  };
}

function getClosestBlockContainerRect(
  tagElement: HTMLElement,
  editorRoot: HTMLElement,
) {
  let current = tagElement.parentElement;

  while (current && current !== editorRoot) {
    if (current.matches(BLOCK_TAG_SELECTOR)) {
      return current.getBoundingClientRect();
    }

    const display = window.getComputedStyle(current).display;

    if (
      (display === "block" || display === "list-item") &&
      current.getBoundingClientRect().width > 0 &&
      current.getBoundingClientRect().height > 0
    ) {
      return current.getBoundingClientRect();
    }

    current = current.parentElement;
  }

  return tagElement.getBoundingClientRect();
}

function getFeedbackModeFromTagElement(tagElement: HTMLElement) {
  if (tagElement.querySelector(":scope > .textTagPulseA, :scope > .textTagPulseB")) {
    return "pulse";
  }

  if (
    tagElement.querySelector(":scope > .textTagLiquidSweep, :scope > .textTagLongSettle")
  ) {
    return "long";
  }

  return "pulse";
}

function groupVisualLineCenters(rects: DOMRect[], tolerance = 4) {
  const lineCenters: number[] = [];

  for (const rect of rects) {
    const centerY = (rect.top + rect.bottom) / 2;
    const matchedLine = lineCenters.some(
      (lineCenter) => Math.abs(lineCenter - centerY) <= tolerance,
    );

    if (!matchedLine) {
      lineCenters.push(centerY);
    }
  }

  return lineCenters;
}

function serializeRect(rect: DOMRect | null) {
  return rect
    ? {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }
    : null;
}

function serializeRects(rects: DOMRect[]) {
  return rects.map((rect) => serializeRect(rect));
}

function getOccurrenceRangeForDebug(
  editor: Editor,
  from: number,
  to: number,
) {
  try {
    const start = editor.view.domAtPos(from);
    const end = editor.view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return {
      range,
      rangeError: null,
    };
  } catch (error) {
    return {
      range: null,
      rangeError: error instanceof Error ? error.message : String(error),
    };
  }
}

function logTextTagPopoverDebug(params: {
  editor: Editor;
  occurrence: NonNullable<TextTagInspectionState["activeOccurrence"]>;
  tagElement: HTMLElement | null;
  editorRoot: HTMLElement;
  anchorRect: DOMRect;
  boundaryRect: DOMRect;
  preferredAnchorCenterX: number | null;
}) {
  const {
    editor,
    occurrence,
    tagElement,
    editorRoot,
    anchorRect,
    boundaryRect,
    preferredAnchorCenterX,
  } = params;
  const tagText = tagElement?.textContent ?? "";
  const tagClientRects = tagElement
    ? Array.from(tagElement.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      )
    : [];
  const { range, rangeError } = getOccurrenceRangeForDebug(
    editor,
    occurrence.from,
    occurrence.to,
  );
  const rangeText = range?.toString() ?? "";
  const rangeClientRects = range
    ? Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      )
    : [];
  const groupedLineCenters = groupVisualLineCenters(rangeClientRects);
  const groupedLineCount = groupedLineCenters.length;
  const isMultilineOccurrence = groupedLineCount > 1;
  const fallbackCenterX = anchorRect.left + anchorRect.width / 2;
  const editorRootRect = editorRoot.getBoundingClientRect();
  const editorRootCenterX = editorRootRect.left + editorRootRect.width / 2;
  const resolvedPreferredAnchorCenterX =
    isMultilineOccurrence && Number.isFinite(editorRootCenterX)
      ? editorRootCenterX
      : preferredAnchorCenterX;
  const anchorCenterX = resolvedPreferredAnchorCenterX ?? fallbackCenterX;
  const halfPopoverWidth = POPOVER_WIDTH / 2;
  const minCenter = boundaryRect.left + POPOVER_EDGE_PADDING + halfPopoverWidth;
  const maxCenter = boundaryRect.right - POPOVER_EDGE_PADDING - halfPopoverWidth;
  const finalAnchorCenterX =
    minCenter > maxCenter
      ? boundaryRect.left + boundaryRect.width / 2
      : clamp(anchorCenterX, minCenter, maxCenter);
  const anchorSource =
    !editorRoot
      ? "missing-editor-root-fallback"
      : rangeError
        ? "range-create-failed-fallback"
        : resolvedPreferredAnchorCenterX !== null && isMultilineOccurrence
          ? "multiline-range-editor-center"
          : tagClientRects.length <= 1
            ? "short-tag-fallback"
            : groupedLineCount <= 1
              ? "range-single-line-fallback"
              : "unknown-fallback";

  if (import.meta.env.DEV) {
    console.log("[text-tag-popover-debug]", {
      key: occurrence.key,
      from: occurrence.from,
      to: occurrence.to,
      blockId: occurrence.blockId,
      startOffset: occurrence.startOffset,
      endOffset: occurrence.endOffset,
      snippetText: occurrence.snippetText,
      snippetLength: occurrence.snippetText.length,
      tagText,
      tagTextLength: tagText.length,
      tagRect: serializeRect(tagElement?.getBoundingClientRect() ?? null),
      tagClientRects: serializeRects(tagClientRects),
      tagClientRectCount: tagClientRects.length,
      rangeCreated: range !== null,
      rangeError,
      rangeText,
      rangeTextLength: rangeText.length,
      rangeClientRects: serializeRects(rangeClientRects),
      rangeClientRectCount: rangeClientRects.length,
      groupedLineCenters,
      groupedLineCount,
      isMultilineOccurrence,
      fallbackCenterX,
      preferredAnchorCenterX: resolvedPreferredAnchorCenterX,
      finalAnchorCenterX,
      editorRootRect: serializeRect(editorRootRect),
      editorRootCenterX,
      anchorRect: serializeRect(anchorRect),
      boundaryRect: serializeRect(boundaryRect),
      anchorSource,
    });
  }

  return {
    preferredAnchorCenterX: resolvedPreferredAnchorCenterX,
  };
}

function getAnchorRect(
  editor: Editor,
  occurrence: NonNullable<TextTagInspectionState["activeOccurrence"]>,
) {
  const editorRoot = editor.view.dom as HTMLElement;
  const tagElement = getOccurrenceTagElement(editor, occurrence.from, occurrence.to);

  if (!tagElement) {
    const anchorRect = createRectFromOccurrence(editor, occurrence.from, occurrence.to);
    const boundaryRect = getVisibleBoundaryRect(editorRoot).rect;
    const debugAnchor = logTextTagPopoverDebug({
      editor,
      occurrence,
      tagElement: null,
      editorRoot,
      anchorRect,
      boundaryRect,
      preferredAnchorCenterX: null,
    });

    return {
      anchorRect,
      boundaryRect,
      scrollContainer: getScrollableAncestor(editorRoot),
      isVisible: true,
      anchorCenterX: debugAnchor.preferredAnchorCenterX,
    };
  }

  const feedbackMode = getFeedbackModeFromTagElement(tagElement);
  const anchorRect =
    feedbackMode === "pulse"
      ? tagElement.getBoundingClientRect()
      : getClosestBlockContainerRect(tagElement, editorRoot);
  const { rect: boundaryRect, scrollContainer } = getVisibleBoundaryRect(editorRoot);
  const isVisible = intersectRects(anchorRect, boundaryRect) !== null;
  const debugAnchor = logTextTagPopoverDebug({
    editor,
    occurrence,
    tagElement,
    editorRoot,
    anchorRect,
    boundaryRect,
    preferredAnchorCenterX: null,
  });

  return {
    anchorRect,
    boundaryRect,
    scrollContainer,
    isVisible,
    anchorCenterX: debugAnchor.preferredAnchorCenterX,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function createClampedReferenceRect(
  anchorRect: DOMRect,
  boundaryRect: DOMRect,
  preferredAnchorCenterX: number | null = null,
) {
  const anchorCenterX =
    preferredAnchorCenterX ?? anchorRect.left + anchorRect.width / 2;
  const halfPopoverWidth = POPOVER_WIDTH / 2;
  const minCenter = boundaryRect.left + POPOVER_EDGE_PADDING + halfPopoverWidth;
  const maxCenter = boundaryRect.right - POPOVER_EDGE_PADDING - halfPopoverWidth;
  const clampedCenterX =
    minCenter > maxCenter
      ? boundaryRect.left + boundaryRect.width / 2
      : clamp(anchorCenterX, minCenter, maxCenter);

  return createDomRect(clampedCenterX, anchorRect.top, 1, Math.max(anchorRect.height, 1));
}

export function TextTagRemarkPopover({
  editor,
  inspectionState,
  disabled,
  onRemarkChange,
}: TextTagRemarkPopoverProps) {
  const activeOccurrence = inspectionState.activeOccurrence;
  const baseOpen =
    editor !== null &&
    activeOccurrence !== null &&
    inspectionState.isPopoverOpen &&
    inspectionState.popoverAnchorKey === activeOccurrence.key;
  const [layoutVersion, setLayoutVersion] = useState(0);

  useEffect(() => {
    if (!baseOpen || !editor || !activeOccurrence) {
      return;
    }

    const editorRoot = editor.view.dom as HTMLElement;
    const scrollContainer = getScrollableAncestor(editorRoot);
    let frame = 0;
    const scheduleRefresh = () => {
      if (frame !== 0) {
        return;
      }

      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setLayoutVersion((current) => current + 1);
      });
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleRefresh();
          });

    resizeObserver?.observe(editorRoot);
    if (scrollContainer) {
      resizeObserver?.observe(scrollContainer);
      scrollContainer.addEventListener("scroll", scheduleRefresh, { passive: true });
    }
    window.addEventListener("resize", scheduleRefresh, { passive: true });

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }

      resizeObserver?.disconnect();
      if (scrollContainer) {
        scrollContainer.removeEventListener("scroll", scheduleRefresh);
      }
      window.removeEventListener("resize", scheduleRefresh);
    };
  }, [activeOccurrence, baseOpen, editor]);

  const anchorData = useMemo(() => {
    if (!editor || !activeOccurrence || !baseOpen) {
      return null;
    }

    return getAnchorRect(editor, activeOccurrence);
  }, [activeOccurrence, baseOpen, editor, layoutVersion]);
  const open = baseOpen && !!anchorData?.isVisible;

  const virtualReference = useMemo(() => {
    if (!editor || !anchorData || !open) {
      return null;
    }
    const preferredRect = createClampedReferenceRect(
      anchorData.anchorRect,
      anchorData.boundaryRect,
      anchorData.anchorCenterX,
    );

    return {
      contextElement: editor.view.dom as HTMLElement,
      getBoundingClientRect: () => preferredRect,
    };
  }, [anchorData, editor, open]);

  const { refs, floatingStyles } = useFloating({
    open,
    strategy: "fixed",
    placement: "bottom",
    middleware: [
      offset(POPOVER_GAP),
      flip({
        fallbackPlacements: ["top"],
        padding: POPOVER_EDGE_PADDING,
        boundary: anchorData?.scrollContainer ?? undefined,
      }),
      shift({
        padding: POPOVER_EDGE_PADDING,
        boundary: anchorData?.scrollContainer ?? undefined,
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    if (virtualReference) {
      refs.setPositionReference(virtualReference);
    }
  }, [refs, virtualReference]);

  if (!open || !activeOccurrence) {
    return null;
  }

  const remarkValue = activeOccurrence.remark ?? "";

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className={styles.popover}
        data-text-tag-remark-popover="true"
      >
        <div className={styles.header}>
          <p className={styles.title}>批注</p>
        </div>
        <textarea
          key={inspectionState.popoverAnchorKey ?? activeOccurrence.key}
          className={styles.textarea}
          value={remarkValue}
          onChange={(event) => {
            onRemarkChange(event.target.value);
          }}
          placeholder="添加批注或解释..."
          autoFocus
          disabled={disabled}
        />
      </div>
    </FloatingPortal>
  );
}

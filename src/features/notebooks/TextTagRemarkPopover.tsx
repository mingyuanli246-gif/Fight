import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
import type { Editor } from "@tiptap/react";
import { useEffect, useMemo } from "react";
import type { TextTagInspectionState } from "./types";
import styles from "./TextTagRemarkPopover.module.css";

interface TextTagRemarkPopoverProps {
  editor: Editor | null;
  inspectionState: TextTagInspectionState;
  disabled: boolean;
  onRemarkChange: (value: string) => void;
}

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

export function TextTagRemarkPopover({
  editor,
  inspectionState,
  disabled,
  onRemarkChange,
}: TextTagRemarkPopoverProps) {
  const activeOccurrence = inspectionState.activeOccurrence;
  const open =
    editor !== null &&
    activeOccurrence !== null &&
    inspectionState.isPopoverOpen &&
    inspectionState.popoverAnchorKey === activeOccurrence.key;

  const virtualReference = useMemo(() => {
    if (!editor || !activeOccurrence || !open) {
      return null;
    }

    return {
      contextElement: editor.view.dom as HTMLElement,
      getBoundingClientRect: () =>
        createRectFromOccurrence(editor, activeOccurrence.from, activeOccurrence.to),
    };
  }, [editor, activeOccurrence, open]);

  const { refs, floatingStyles } = useFloating({
    open,
    placement: "bottom",
    middleware: [
      offset(12),
      flip({
        fallbackPlacements: ["top", "bottom-start", "top"],
      }),
      shift({ padding: 12 }),
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

import { NoteTextTagManager } from "./NoteTextTagManager";
import {
  NoteReviewPlanManager,
  type NoteReviewPlanManagerRef,
} from "../review/NoteReviewPlanManager";
import type { RefObject } from "react";
import type { Note, TextTagPanelState } from "./types";
import { PanelCollapseIcon, PanelExpandIcon } from "./NotebookUiIcons";
import styles from "./NotebookWorkspaceShell.module.css";
import type { NoteEditorPaneRef } from "./NoteEditorPane";

interface NotebookRightPanelProps {
  note: Note | null;
  collapsed: boolean;
  disabled: boolean;
  noteEditorRef: RefObject<NoteEditorPaneRef | null>;
  textTagPanelState: TextTagPanelState;
  reviewManagerRef: RefObject<NoteReviewPlanManagerRef | null>;
  onToggleCollapsed: () => void;
  onError: (message: string) => void;
}

export function NotebookRightPanel({
  note,
  collapsed,
  disabled,
  noteEditorRef,
  textTagPanelState,
  reviewManagerRef,
  onToggleCollapsed,
  onError,
}: NotebookRightPanelProps) {
  if (collapsed) {
    return (
      <aside className={styles.detailRightCollapsed}>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.rightCollapsedButton}`}
          onClick={onToggleCollapsed}
          aria-label="展开右侧功能区"
        >
          <PanelExpandIcon className={styles.buttonIcon} />
        </button>
      </aside>
    );
  }

  return (
    <aside className={styles.detailRightPanel}>
      <header className={styles.detailRightPanelHeader}>
        <div>
          <h3 className={styles.detailRightPanelTitle}>功能区</h3>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onToggleCollapsed}
          aria-label="折叠右侧功能区"
        >
          <PanelCollapseIcon className={styles.buttonIcon} />
        </button>
      </header>

      <div className={styles.detailRightPanelBody}>
        {note ? (
          <>
            <NoteTextTagManager
              noteEditorRef={noteEditorRef}
              panelState={textTagPanelState}
              disabled={disabled}
              onError={onError}
            />
            <NoteReviewPlanManager
              ref={reviewManagerRef}
              noteId={note.id}
              disabled={disabled}
              onError={onError}
            />
          </>
        ) : (
          <p className={styles.panelPlaceholder}>
            选中文件后，这里会显示正文标签与复习计划。
          </p>
        )}
      </div>
    </aside>
  );
}

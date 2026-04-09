import { NoteTagManager } from "./NoteTagManager";
import { NoteReviewPlanManager } from "../review/NoteReviewPlanManager";
import type { Note } from "./types";
import { PanelCollapseIcon, PanelExpandIcon } from "./NotebookUiIcons";
import styles from "./NotebookWorkspaceShell.module.css";

interface NotebookRightPanelProps {
  note: Note | null;
  collapsed: boolean;
  disabled: boolean;
  onToggleCollapsed: () => void;
  onError: (message: string) => void;
}

export function NotebookRightPanel({
  note,
  collapsed,
  disabled,
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
            <NoteTagManager
              noteId={note.id}
              disabled={disabled}
              onError={onError}
            />
            <NoteReviewPlanManager
              noteId={note.id}
              disabled={disabled}
              onError={onError}
            />
          </>
        ) : (
          <p className={styles.panelPlaceholder}>
            选中文件后，这里会显示它的标签与复习计划。
          </p>
        )}
      </div>
    </aside>
  );
}

import type { RefObject } from "react";
import { NoteEditorPane, type NoteEditorPaneRef } from "./NoteEditorPane";
import { NotebookTreePane } from "./NotebookTreePane";
import { NotebookRightPanel } from "./NotebookRightPanel";
import type {
  Folder,
  Note,
  Notebook,
  NotebookHighlightRequest,
  SelectedEntity,
} from "./types";
import styles from "./NotebookWorkspaceShell.module.css";

interface NotebookDetailWorkspaceProps {
  notebook: Notebook | null;
  folders: Folder[];
  notes: Note[];
  selectedEntity: SelectedEntity | null;
  selectedNote: Note | null;
  activeFolderId: number | null;
  disabled: boolean;
  rightPanelCollapsed: boolean;
  highlightRequest: NotebookHighlightRequest | null;
  noteEditorRef: RefObject<NoteEditorPaneRef | null>;
  onReturnHome: () => void;
  onSelectEntity: (entity: SelectedEntity) => void;
  onCreateFolder: () => Promise<void>;
  onCreateNote: () => Promise<void>;
  onRenameFolder: (id: number, name: string) => Promise<void>;
  onRenameNote: (id: number, title: string) => Promise<void>;
  onToggleRightPanel: () => void;
  onNoteUpdated: (note: Note) => void;
  onError: (message: string) => void;
}

export function NotebookDetailWorkspace({
  notebook,
  folders,
  notes,
  selectedEntity,
  selectedNote,
  activeFolderId,
  disabled,
  rightPanelCollapsed,
  highlightRequest,
  noteEditorRef,
  onReturnHome,
  onSelectEntity,
  onCreateFolder,
  onCreateNote,
  onRenameFolder,
  onRenameNote,
  onToggleRightPanel,
  onNoteUpdated,
  onError,
}: NotebookDetailWorkspaceProps) {
  return (
    <div className={styles.detailShell}>
      <div
        className={`${styles.detailColumns} ${
          rightPanelCollapsed ? styles.detailColumnsCollapsed : ""
        }`}
      >
        <NotebookTreePane
          notebook={notebook}
          folders={folders}
          notes={notes}
          selectedEntity={selectedEntity}
          activeFolderId={activeFolderId}
          disabled={disabled}
          onReturnHome={onReturnHome}
          onSelectEntity={onSelectEntity}
          onCreateFolder={onCreateFolder}
          onCreateNote={onCreateNote}
          onRenameFolder={onRenameFolder}
          onRenameNote={onRenameNote}
        />

        <section className={styles.detailMain}>
          {notebook && selectedNote ? (
            <NoteEditorPane
              ref={noteEditorRef}
              notebook={notebook}
              note={selectedNote}
              folders={folders}
              disabled={disabled}
              highlightRequest={highlightRequest}
              onNoteUpdated={onNoteUpdated}
              onError={onError}
            />
          ) : (
            <section className={styles.detailEmptyPanel}>
              <header className={styles.detailEmptyPanelHeader} />
              <div className={styles.detailEmptyPanelBody}>
                <div className={styles.detailEmptyState}>
                  <h3 className={styles.homeEmptyTitle}>
                    {selectedEntity?.kind === "folder"
                      ? "当前已选中文件夹，请选择一个文件开始编辑"
                      : "请选择一个文件开始编辑"}
                  </h3>
                  <p className={styles.homeEmptyText}>
                    中间区域会展示当前文件的标题、路径、保存状态和正文内容。
                  </p>
                </div>
              </div>
            </section>
          )}
        </section>

        <NotebookRightPanel
          note={selectedNote}
          collapsed={rightPanelCollapsed}
          disabled={disabled}
          onToggleCollapsed={onToggleRightPanel}
          onError={onError}
        />
      </div>
    </div>
  );
}

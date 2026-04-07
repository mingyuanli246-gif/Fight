import { useState } from "react";
import type { Folder, Note, Notebook, SelectedEntity } from "./types";
import styles from "./NotebookWorkspace.module.css";

interface NotebookTreePaneProps {
  notebook: Notebook | null;
  folders: Folder[];
  notes: Note[];
  selectedEntity: SelectedEntity | null;
  activeFolderId: number | null;
  disabled: boolean;
  onSelectEntity: (entity: SelectedEntity) => void;
  onCreateFolder: (name: string) => Promise<void>;
  onCreateNote: (title: string) => Promise<void>;
}

export function NotebookTreePane({
  notebook,
  folders,
  notes,
  selectedEntity,
  activeFolderId,
  disabled,
  onSelectEntity,
  onCreateFolder,
  onCreateNote,
}: NotebookTreePaneProps) {
  const [creationKind, setCreationKind] = useState<"folder" | "note" | null>(
    null,
  );
  const [draftName, setDraftName] = useState("");

  const notesByFolder = new Map<number, Note[]>();

  notes.forEach((note) => {
    if (note.folderId === null) {
      return;
    }

    const current = notesByFolder.get(note.folderId) ?? [];
    current.push(note);
    notesByFolder.set(note.folderId, current);
  });

  const orphanNotes = notes.filter((note) => note.folderId === null);

  async function handleCreate() {
    try {
      if (creationKind === "folder") {
        await onCreateFolder(draftName);
      }

      if (creationKind === "note") {
        await onCreateNote(draftName);
      }

      setDraftName("");
      setCreationKind(null);
    } catch {
      // 错误信息由上层统一展示
    }
  }

  const canCreateNote = activeFolderId !== null;

  return (
    <section className={styles.panel}>
      <header className={styles.panelHeader}>
        <div>
          <h3 className={styles.panelTitle}>文件夹与文件</h3>
          <p className={styles.panelDescription}>
            {notebook ? `当前笔记本：${notebook.name}` : "先选择一个笔记本"}
          </p>
        </div>
        <div className={styles.panelActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setCreationKind("folder")}
            disabled={disabled || notebook === null}
          >
            新建文件夹
          </button>
          <button
            type="button"
            className={styles.actionButton}
            onClick={() => setCreationKind("note")}
            disabled={disabled || !canCreateNote}
          >
            新建文件
          </button>
        </div>
      </header>

      {creationKind ? (
        <div className={styles.createForm}>
          <input
            className={styles.input}
            value={draftName}
            onChange={(event) => setDraftName(event.currentTarget.value)}
            placeholder={creationKind === "folder" ? "输入文件夹名称" : "输入文件名称"}
            maxLength={120}
            autoFocus
          />
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                setDraftName("");
                setCreationKind(null);
              }}
              disabled={disabled}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.actionButton}
              onClick={handleCreate}
              disabled={disabled}
            >
              保存
            </button>
          </div>
        </div>
      ) : null}

      <div className={styles.panelBody}>
        {!notebook ? (
          <div className={styles.emptyState}>
            <strong>尚未选中笔记本</strong>
            <span>左侧选择一个笔记本后，这里会显示文件夹与文件树。</span>
          </div>
        ) : (
          <>
            {!canCreateNote ? (
              <p className={styles.inlineHint}>请先选择一个文件夹，再新建文件。</p>
            ) : null}

            {folders.length === 0 && orphanNotes.length === 0 ? (
              <div className={styles.emptyState}>
                <strong>当前笔记本还是空的</strong>
                <span>先创建一个文件夹，再在文件夹里建立文件。</span>
              </div>
            ) : (
              <div className={styles.treeContainer}>
                {folders.map((folder) => {
                  const folderNotes = notesByFolder.get(folder.id) ?? [];
                  const isFolderActive =
                    selectedEntity?.kind === "folder" && selectedEntity.id === folder.id;

                  return (
                    <section key={folder.id} className={styles.treeGroup}>
                      <button
                        type="button"
                        className={`${styles.treeItem} ${
                          isFolderActive ? styles.treeItemActive : ""
                        }`}
                        onClick={() =>
                          onSelectEntity({ kind: "folder", id: folder.id })
                        }
                        disabled={disabled}
                      >
                        <span className={styles.treeItemTitle}>文件夹 · {folder.name}</span>
                        <span className={styles.treeItemMeta}>
                          {folderNotes.length} 个文件
                        </span>
                      </button>

                      {folderNotes.length === 0 ? (
                        <div className={styles.treeEmpty}>
                          这个文件夹还没有文件，可以从顶部直接创建。
                        </div>
                      ) : (
                        <ul className={styles.noteList}>
                          {folderNotes.map((note) => {
                            const isNoteActive =
                              selectedEntity?.kind === "note" &&
                              selectedEntity.id === note.id;

                            return (
                              <li key={note.id}>
                                <button
                                  type="button"
                                  className={`${styles.noteItem} ${
                                    isNoteActive ? styles.noteItemActive : ""
                                  }`}
                                  onClick={() =>
                                    onSelectEntity({ kind: "note", id: note.id })
                                  }
                                  disabled={disabled}
                                >
                                  <span className={styles.noteItemTitle}>{note.title}</span>
                                  <span className={styles.noteItemMeta}>文件</span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  );
                })}

                {orphanNotes.length > 0 ? (
                  <section className={styles.treeGroup}>
                    <p className={styles.treeSectionLabel}>未归档笔记</p>
                    <ul className={styles.noteList}>
                      {orphanNotes.map((note) => {
                        const isNoteActive =
                          selectedEntity?.kind === "note" &&
                          selectedEntity.id === note.id;

                        return (
                          <li key={note.id}>
                            <button
                              type="button"
                              className={`${styles.noteItem} ${
                                isNoteActive ? styles.noteItemActive : ""
                              }`}
                              onClick={() =>
                                onSelectEntity({ kind: "note", id: note.id })
                              }
                              disabled={disabled}
                            >
                              <span className={styles.noteItemTitle}>{note.title}</span>
                              <span className={styles.noteItemMeta}>尚未归入文件夹</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

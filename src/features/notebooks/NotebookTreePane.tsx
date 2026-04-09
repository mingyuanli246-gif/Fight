import { useEffect, useMemo, useRef, useState } from "react";
import type { Folder, Note, Notebook, SelectedEntity } from "./types";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "./NotebookUiIcons";
import styles from "./NotebookWorkspaceShell.module.css";

interface RenameState {
  kind: "folder" | "note";
  id: number;
  value: string;
}

interface NotebookTreePaneProps {
  notebook: Notebook | null;
  folders: Folder[];
  notes: Note[];
  selectedEntity: SelectedEntity | null;
  activeFolderId: number | null;
  disabled: boolean;
  onReturnHome: () => void;
  onSelectEntity: (entity: SelectedEntity) => void;
  onCreateFolder: () => Promise<void>;
  onCreateNote: () => Promise<void>;
  onRenameFolder: (id: number, name: string) => Promise<void>;
  onRenameNote: (id: number, title: string) => Promise<void>;
}

function buildExpandedSet(folderIds: number[]) {
  return new Set(folderIds);
}

export function NotebookTreePane({
  notebook,
  folders,
  notes,
  selectedEntity,
  activeFolderId,
  disabled,
  onReturnHome,
  onSelectEntity,
  onCreateFolder,
  onCreateNote,
  onRenameFolder,
  onRenameNote,
}: NotebookTreePaneProps) {
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(
    () => buildExpandedSet([]),
  );
  const [renameState, setRenameState] = useState<RenameState | null>(null);
  const lastNotebookIdRef = useRef<number | null>(null);

  const notesByFolder = useMemo(() => {
    const grouped = new Map<number, Note[]>();

    for (const note of notes) {
      if (note.folderId === null) {
        continue;
      }

      const current = grouped.get(note.folderId) ?? [];
      current.push(note);
      grouped.set(note.folderId, current);
    }

    return grouped;
  }, [notes]);

  const orphanNotes = useMemo(
    () => notes.filter((note) => note.folderId === null),
    [notes],
  );

  useEffect(() => {
    if (!notebook) {
      setExpandedFolderIds(buildExpandedSet([]));
      setRenameState(null);
      lastNotebookIdRef.current = null;
      return;
    }

    const currentNotebookId = notebook.id;
    const didNotebookChange = lastNotebookIdRef.current !== currentNotebookId;
    lastNotebookIdRef.current = currentNotebookId;

    setExpandedFolderIds((current) => {
      if (didNotebookChange) {
        return buildExpandedSet(folders.map((folder) => folder.id));
      }

      const next = new Set<number>();

      for (const folder of folders) {
        if (current.has(folder.id)) {
          next.add(folder.id);
        }
      }

      return next;
    });
  }, [folders, notebook]);

  useEffect(() => {
    if (selectedEntity?.kind !== "note") {
      return;
    }

    const selectedNote = notes.find((note) => note.id === selectedEntity.id) ?? null;

    if (selectedNote?.folderId === null || selectedNote?.folderId === undefined) {
      return;
    }

    const parentFolderId = selectedNote.folderId;

    setExpandedFolderIds((current) => {
      if (current.has(parentFolderId)) {
        return current;
      }

      const next = new Set(current);
      next.add(parentFolderId);
      return next;
    });
  }, [notes, selectedEntity]);

  function toggleFolder(folderId: number) {
    setExpandedFolderIds((current) => {
      const next = new Set(current);

      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }

      return next;
    });
  }

  function startRename(kind: RenameState["kind"], id: number, value: string) {
    setRenameState({
      kind,
      id,
      value,
    });
  }

  function updateRenameValue(value: string) {
    setRenameState((current) =>
      current
        ? {
            ...current,
            value,
          }
        : current,
    );
  }

  function cancelRename() {
    setRenameState(null);
  }

  async function submitRename() {
    if (!renameState) {
      return;
    }

    try {
      if (renameState.kind === "folder") {
        await onRenameFolder(renameState.id, renameState.value);
      } else {
        await onRenameNote(renameState.id, renameState.value);
      }

      cancelRename();
    } catch {
      // 错误由上层统一展示
    }
  }

  const canCreateNote = activeFolderId !== null;

  return (
    <section className={styles.detailSidebar}>
      <header className={styles.treeHeader}>
        <div className={styles.treeHeaderTop}>
          <button
            type="button"
            className={styles.treeBackButton}
            onClick={onReturnHome}
            aria-label="返回笔记本首页"
          >
            <ArrowLeftIcon className={styles.buttonIcon} />
          </button>
          <h3 className={styles.treeTitle}>
            {notebook?.name ?? "笔记本工作区"}
          </h3>
        </div>
        <div className={styles.treeActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => {
              void onCreateFolder();
            }}
            disabled={disabled || notebook === null}
          >
            新建文件夹
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => {
              void onCreateNote();
            }}
            disabled={disabled || !canCreateNote}
          >
            新建文件
          </button>
        </div>
      </header>

      <div className={styles.treeBody}>
        {!notebook ? (
          <div className={styles.treeEmpty}>请选择一个笔记本后继续。</div>
        ) : folders.length === 0 && orphanNotes.length === 0 ? (
          <div className={styles.treeEmpty}>
            当前笔记本还没有内容。先创建一个文件夹，再在里面建立文件。
          </div>
        ) : (
          <ul className={styles.treeList}>
            {folders.map((folder) => {
              const folderNotes = notesByFolder.get(folder.id) ?? [];
              const isExpanded = expandedFolderIds.has(folder.id);
              const isActive =
                selectedEntity?.kind === "folder" && selectedEntity.id === folder.id;
              const isEditing =
                renameState?.kind === "folder" && renameState.id === folder.id;

              return (
                <li key={folder.id}>
                  {isEditing ? (
                    <div
                      className={`${styles.treeRow} ${styles.treeRowActive} ${styles.treeRowEditing}`}
                    >
                      <span className={styles.treeDisclosure}>
                        {isExpanded ? (
                          <ChevronDownIcon className={styles.treeRowIcon} />
                        ) : (
                          <ChevronRightIcon className={styles.treeRowIcon} />
                        )}
                      </span>
                      <span className={styles.treeLabelWrap}>
                        <div className={styles.inlineNameEditor}>
                          <input
                            type="text"
                            className={`${styles.inlineNameInput} ${styles.inlineNameInputCompact}`}
                            value={renameState.value}
                            onChange={(event) => updateRenameValue(event.currentTarget.value)}
                            autoFocus
                            onBlur={cancelRename}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void submitRename();
                              }

                              if (event.key === "Escape") {
                                cancelRename();
                              }
                            }}
                          />
                        </div>
                        <span className={styles.treeMeta}>{folderNotes.length} 个文件</span>
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={`${styles.treeRow} ${
                        isActive ? styles.treeRowActive : ""
                      }`}
                      onClick={() => {
                        toggleFolder(folder.id);
                        onSelectEntity({ kind: "folder", id: folder.id });
                      }}
                      disabled={disabled}
                    >
                      <span className={styles.treeDisclosure}>
                        {isExpanded ? (
                          <ChevronDownIcon className={styles.treeRowIcon} />
                        ) : (
                          <ChevronRightIcon className={styles.treeRowIcon} />
                        )}
                      </span>
                      <span className={styles.treeLabelWrap}>
                        <span
                          className={styles.treeLabel}
                          onDoubleClick={(event) => {
                            event.stopPropagation();
                            startRename("folder", folder.id, folder.name);
                          }}
                        >
                          {folder.name}
                        </span>
                        <span className={styles.treeMeta}>{folderNotes.length} 个文件</span>
                      </span>
                    </button>
                  )}

                  {isExpanded ? (
                    folderNotes.length > 0 ? (
                      <ul className={styles.treeNoteList}>
                        {folderNotes.map((note) => {
                          const isNoteActive =
                            selectedEntity?.kind === "note" &&
                            selectedEntity.id === note.id;
                          const isNoteEditing =
                            renameState?.kind === "note" && renameState.id === note.id;

                          return (
                            <li key={note.id}>
                              {isNoteEditing ? (
                                <div
                                  className={`${styles.treeNoteRow} ${styles.treeNoteRowActive} ${styles.treeNoteRowEditing}`}
                                >
                                  <span className={styles.treeLabelWrap}>
                                    <div className={styles.inlineNameEditor}>
                                      <input
                                        type="text"
                                        className={`${styles.inlineNameInput} ${styles.inlineNameInputCompact}`}
                                        value={renameState.value}
                                        onChange={(event) =>
                                          updateRenameValue(event.currentTarget.value)
                                        }
                                        autoFocus
                                        onBlur={cancelRename}
                                        onKeyDown={(event) => {
                                          if (event.key === "Enter") {
                                            event.preventDefault();
                                            void submitRename();
                                          }

                                          if (event.key === "Escape") {
                                            cancelRename();
                                          }
                                        }}
                                      />
                                    </div>
                                    <span className={styles.treeMeta}>文件</span>
                                  </span>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className={`${styles.treeNoteRow} ${
                                    isNoteActive ? styles.treeNoteRowActive : ""
                                  }`}
                                  onClick={() => {
                                    if (isNoteActive) {
                                      return;
                                    }

                                    onSelectEntity({ kind: "note", id: note.id });
                                  }}
                                  disabled={disabled}
                                >
                                  <span className={styles.treeLabelWrap}>
                                    <span
                                      className={styles.treeLabel}
                                      onDoubleClick={(event) => {
                                        event.stopPropagation();
                                        startRename("note", note.id, note.title);
                                      }}
                                    >
                                      {note.title}
                                    </span>
                                    <span className={styles.treeMeta}>文件</span>
                                  </span>
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className={styles.treeEmpty}>这个文件夹还没有文件。</div>
                    )
                  ) : null}
                </li>
              );
            })}

            {orphanNotes.length > 0 ? (
              <li>
                <div className={styles.treeEmpty}>未归档</div>
                <ul className={styles.treeNoteList}>
                  {orphanNotes.map((note) => {
                    const isNoteActive =
                      selectedEntity?.kind === "note" &&
                      selectedEntity.id === note.id;
                    const isNoteEditing =
                      renameState?.kind === "note" && renameState.id === note.id;

                    return (
                      <li key={note.id}>
                        {isNoteEditing ? (
                          <div
                            className={`${styles.treeNoteRow} ${styles.treeNoteRowActive} ${styles.treeNoteRowEditing}`}
                          >
                            <span className={styles.treeLabelWrap}>
                              <div className={styles.inlineNameEditor}>
                                <input
                                  type="text"
                                  className={`${styles.inlineNameInput} ${styles.inlineNameInputCompact}`}
                                  value={renameState.value}
                                  onChange={(event) =>
                                    updateRenameValue(event.currentTarget.value)
                                  }
                                  autoFocus
                                  onBlur={cancelRename}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      void submitRename();
                                    }

                                    if (event.key === "Escape") {
                                      cancelRename();
                                    }
                                  }}
                                />
                              </div>
                              <span className={styles.treeMeta}>尚未归入文件夹</span>
                            </span>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className={`${styles.treeNoteRow} ${
                              isNoteActive ? styles.treeNoteRowActive : ""
                            }`}
                            onClick={() => {
                              if (isNoteActive) {
                                return;
                              }

                              onSelectEntity({ kind: "note", id: note.id });
                            }}
                            disabled={disabled}
                          >
                            <span className={styles.treeLabelWrap}>
                              <span
                                className={styles.treeLabel}
                                onDoubleClick={(event) => {
                                  event.stopPropagation();
                                  startRename("note", note.id, note.title);
                                }}
                              >
                                {note.title}
                              </span>
                              <span className={styles.treeMeta}>尚未归入文件夹</span>
                            </span>
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </section>
  );
}

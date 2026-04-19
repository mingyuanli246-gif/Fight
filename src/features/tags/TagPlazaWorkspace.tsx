import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  createTag,
  deleteTag,
  listNotesByTag,
  listTagsWithCounts,
  renameTag,
} from "../notebooks/repository";
import type {
  NoteOpenTarget,
  TaggedNoteResult,
  TagWithCount,
} from "../notebooks/types";
import styles from "./TagPlazaWorkspace.module.css";

const MAX_TAG_NAME_LENGTH = 10;
const CONTEXT_MENU_WIDTH = 188;
const CONTEXT_MENU_HEIGHT = 128;
const CONTEXT_MENU_MARGIN = 12;

interface TagPlazaWorkspaceProps {
  onOpenNote: (target: NoteOpenTarget) => void;
}

interface ContextMenuState {
  tagId: number;
  x: number;
  y: number;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "标签操作失败，请稍后重试。";
}

function formatDate(value: string) {
  return new Date(value.replace(" ", "T")).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildPath(note: TaggedNoteResult) {
  return `${note.notebookName} / ${note.folderName ?? "未归类"}`;
}

function getValidatedTagName(rawValue: string) {
  const name = rawValue.trim();

  if (!name) {
    return {
      name,
      error: "标签名不能为空。",
    };
  }

  if (Array.from(name).length > MAX_TAG_NAME_LENGTH) {
    return {
      name,
      error: `标签名最多 ${MAX_TAG_NAME_LENGTH} 个字。`,
    };
  }

  return {
    name,
    error: null,
  };
}

function getClampedContextMenuPosition(x: number, y: number) {
  const maxX = window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN;
  const maxY = window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN;

  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(x, maxX)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(y, maxY)),
  };
}

export function TagPlazaWorkspace({ onOpenNote }: TagPlazaWorkspaceProps) {
  const [tags, setTags] = useState<TagWithCount[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const [taggedNotes, setTaggedNotes] = useState<TaggedNoteResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [isLoadingNotes, setIsLoadingNotes] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createValue, setCreateValue] = useState("");
  const [createDialogError, setCreateDialogError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingTagId, setRenamingTagId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteDialogTag, setDeleteDialogTag] = useState<TagWithCount | null>(null);
  const requestVersionRef = useRef(0);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const selectedTagIdRef = useRef<number | null>(null);

  const selectedTag =
    selectedTagId === null
      ? null
      : tags.find((tag) => tag.id === selectedTagId) ?? null;

  useEffect(() => {
    selectedTagIdRef.current = selectedTagId;
  }, [selectedTagId]);

  const refreshTags = useCallback(async (preferredTagId?: number | null) => {
    const nextTags = await listTagsWithCounts();
    setTags(nextTags);

    const nextSelectedTagId =
      preferredTagId === undefined
        ? nextTags.some((tag) => tag.id === selectedTagIdRef.current)
          ? selectedTagIdRef.current
          : (nextTags[0]?.id ?? null)
        : preferredTagId !== null &&
            nextTags.some((tag) => tag.id === preferredTagId)
          ? preferredTagId
          : (nextTags[0]?.id ?? null);

    setSelectedTagId(nextSelectedTagId);
    return nextSelectedTagId;
  }, []);

  function closeCreateDialog() {
    setIsCreateDialogOpen(false);
    setCreateValue("");
    setCreateDialogError(null);
  }

  function closeRenameEditor() {
    setRenamingTagId(null);
    setRenameValue("");
  }

  function handleSelectTag(tagId: number) {
    setErrorMessage(null);
    setSelectedTagId(tagId);
  }

  useEffect(() => {
    void (async () => {
      setErrorMessage(null);
      setIsInitializing(true);

      try {
        await refreshTags();
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
        setTags([]);
        setSelectedTagId(null);
        setTaggedNotes([]);
      } finally {
        setIsInitializing(false);
      }
    })();
  }, [refreshTags]);

  useEffect(() => {
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;

    if (selectedTagId === null) {
      setTaggedNotes([]);
      setIsLoadingNotes(false);
      return;
    }

    setIsLoadingNotes(true);

    void (async () => {
      try {
        const nextNotes = await listNotesByTag(selectedTagId);

        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTaggedNotes(nextNotes);
      } catch (error) {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTaggedNotes([]);
        setErrorMessage(getErrorMessage(error));
      } finally {
        if (requestVersion === requestVersionRef.current) {
          setIsLoadingNotes(false);
        }
      }
    })();
  }, [selectedTagId]);

  useEffect(() => {
    if (
      renamingTagId !== null &&
      !tags.some((tag) => tag.id === renamingTagId)
    ) {
      closeRenameEditor();
    }

    if (contextMenu && !tags.some((tag) => tag.id === contextMenu.tagId)) {
      setContextMenu(null);
    }

    if (deleteDialogTag && !tags.some((tag) => tag.id === deleteDialogTag.id)) {
      setDeleteDialogTag(null);
    }
  }, [contextMenu, deleteDialogTag, renamingTagId, tags]);

  useEffect(() => {
    function handleWindowPointerDown(event: MouseEvent) {
      const target = event.target as Node | null;

      if (contextMenuRef.current?.contains(target)) {
        return;
      }

      setContextMenu(null);
    }

    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      setContextMenu(null);
      setDeleteDialogTag(null);
      closeRenameEditor();
      closeCreateDialog();
    }

    window.addEventListener("pointerdown", handleWindowPointerDown);
    window.addEventListener("keydown", handleWindowKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handleWindowPointerDown);
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, []);

  async function runMutation(operation: () => Promise<void>) {
    setErrorMessage(null);
    setIsBusy(true);

    try {
      await operation();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
      throw error;
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreateTagSubmit() {
    const { name, error } = getValidatedTagName(createValue);

    if (error) {
      setCreateDialogError(error);
      return;
    }

    await runMutation(async () => {
      const tag = await createTag(name);
      closeCreateDialog();
      await refreshTags(tag.id);
    });
  }

  async function handleRenameTagSubmit(tag: TagWithCount) {
    const { name, error } = getValidatedTagName(renameValue);

    if (error) {
      setErrorMessage(error);
      return;
    }

    await runMutation(async () => {
      await renameTag(tag.id, name);
      closeRenameEditor();
      await refreshTags(tag.id);
    });
  }

  async function handleDeleteTagConfirm(tag: TagWithCount) {
    await runMutation(async () => {
      await deleteTag(tag.id);
      setDeleteDialogTag(null);
      await refreshTags(null);
    });
  }

  function handleContextMenuOpen(
    tag: TagWithCount,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    handleSelectTag(tag.id);
    closeRenameEditor();
    setDeleteDialogTag(null);
    setCreateDialogError(null);
    setContextMenu({
      tagId: tag.id,
      ...getClampedContextMenuPosition(event.clientX, event.clientY),
    });
  }

  function handleStartRename(tag: TagWithCount) {
    setContextMenu(null);
    setDeleteDialogTag(null);
    handleSelectTag(tag.id);
    setRenameValue(tag.name);
    setRenamingTagId(tag.id);
  }

  function renderTagList() {
    if (tags.length === 0) {
      return (
        <div className={`${styles.emptyBlock} ${styles.emptyBlockCompact}`}>
          <p className={styles.emptyTitle}>暂无标签</p>
        </div>
      );
    }

    return (
      <ul className={styles.tagList}>
        {tags.map((tag) => {
          const isActive = selectedTagId === tag.id;
          const isRenaming = renamingTagId === tag.id;

          if (isRenaming) {
            return (
              <li key={tag.id} className={styles.tagListItem}>
                <div
                  className={`${styles.tagItem} ${styles.tagItemActive} ${styles.tagItemEditing}`}
                >
                  <span
                    className={styles.tagDot}
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className={styles.tagItemText}>
                    <input
                      type="text"
                      className={styles.inlineNameInput}
                      value={renameValue}
                      maxLength={20}
                      autoFocus
                      onChange={(event) =>
                        setRenameValue(event.currentTarget.value)
                      }
                      onBlur={() => closeRenameEditor()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleRenameTagSubmit(tag).catch(() => undefined);
                        }

                        if (event.key === "Escape") {
                          event.preventDefault();
                          closeRenameEditor();
                        }
                      }}
                    />
                    <span className={styles.tagItemMeta}>
                      {tag.noteCount} 个文件
                    </span>
                  </span>
                </div>
              </li>
            );
          }

          return (
            <li key={tag.id} className={styles.tagListItem}>
              <button
                type="button"
                className={`${styles.tagItem} ${
                  isActive ? styles.tagItemActive : ""
                }`}
                onClick={() => handleSelectTag(tag.id)}
                onContextMenu={(event) => handleContextMenuOpen(tag, event)}
                disabled={isBusy}
              >
                <span
                  className={styles.tagDot}
                  style={{ backgroundColor: tag.color }}
                />
                <span className={styles.tagItemText}>
                  <span className={styles.tagItemTitle}>{tag.name}</span>
                  <span className={styles.tagItemMeta}>
                    {tag.noteCount} 个文件
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  const contextMenuTag =
    contextMenu === null
      ? null
      : tags.find((tag) => tag.id === contextMenu.tagId) ?? null;

  if (isInitializing) {
    return (
      <div className={styles.statusCard}>
        <strong className={styles.statusTitle}>正在读取标签广场</strong>
        <p className={styles.statusText}>正在连接标签表并载入关联文件。</p>
      </div>
    );
  }

  return (
    <>
      {errorMessage ? (
        <div className={styles.errorBanner}>
          <div>
            <p className={styles.errorTitle}>标签操作失败</p>
            <p className={styles.errorText}>{errorMessage}</p>
          </div>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setErrorMessage(null)}
          >
            关闭提示
          </button>
        </div>
      ) : null}

      <div className={styles.workspace}>
        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <div className={styles.panelHeaderBar}>
              <h3 className={styles.panelTitle}>标签列表</h3>
              <button
                type="button"
                className={styles.headerActionButton}
                onClick={() => {
                  setContextMenu(null);
                  closeRenameEditor();
                  setDeleteDialogTag(null);
                  setCreateDialogError(null);
                  setIsCreateDialogOpen(true);
                }}
                disabled={isBusy}
                aria-label="创建标签"
                title="创建标签"
              >
                ⚙️
              </button>
            </div>
          </header>

          <div className={styles.panelBody}>{renderTagList()}</div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <div className={styles.panelHeaderBar}>
              <h3 className={styles.panelTitle}>关联文件</h3>
            </div>
          </header>

          <div className={`${styles.panelBody} ${styles.notePanelBody}`}>
            {selectedTag === null ? (
              <div className={`${styles.emptyBlock} ${styles.emptyBlockCompact}`}>
                <p className={styles.emptyTitle}>先选择一个标签</p>
                <p className={styles.emptyText}>
                  点击左侧标签后，这里会显示对应的关联文件列表。
                </p>
              </div>
            ) : isLoadingNotes ? (
              <div className={`${styles.emptyBlock} ${styles.emptyBlockCompact}`}>
                <p className={styles.emptyTitle}>正在读取关联文件…</p>
              </div>
            ) : taggedNotes.length === 0 ? (
              <div className={`${styles.emptyBlock} ${styles.emptyBlockCompact}`}>
                <p className={styles.emptyTitle}>这个标签下还没有文件</p>
                <p className={styles.emptyText}>
                  你可以先回到笔记本，在文件正文区把这个标签绑定到具体 note。
                </p>
              </div>
            ) : (
              <ul className={styles.noteList}>
                {taggedNotes.map((note) => (
                  <li key={note.noteId}>
                    <button
                      type="button"
                      className={styles.noteItem}
                      onClick={() =>
                        onOpenNote({
                          noteId: note.noteId,
                          notebookId: note.notebookId,
                        })
                      }
                    >
                      <span className={styles.noteTitle}>{note.title}</span>
                      <span className={styles.notePath}>{buildPath(note)}</span>
                      <span className={styles.noteMeta}>
                        更新时间：{formatDate(note.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {isCreateDialogOpen ? (
        <div
          className={styles.dialogOverlay}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeCreateDialog();
            }
          }}
        >
          <div className={styles.dialogCard}>
            <h3 className={styles.dialogTitle}>创建标签</h3>
            <p className={styles.dialogText}>输入标签名称，最多 10 个字。</p>
            <input
              type="text"
              className={styles.dialogInput}
              value={createValue}
              maxLength={20}
              autoFocus
              placeholder="输入标签名称"
              onChange={(event) => {
                setCreateDialogError(null);
                setCreateValue(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleCreateTagSubmit().catch(() => undefined);
                }

                if (event.key === "Escape") {
                  event.preventDefault();
                  closeCreateDialog();
                }
              }}
            />
            {createDialogError ? (
              <p className={styles.fieldError}>{createDialogError}</p>
            ) : null}
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => closeCreateDialog()}
                disabled={isBusy}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  void handleCreateTagSubmit().catch(() => undefined);
                }}
                disabled={isBusy}
              >
                创建标签
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteDialogTag ? (
        <div
          className={styles.dialogOverlay}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setDeleteDialogTag(null);
            }
          }}
        >
          <div className={styles.dialogCard}>
            <h3 className={styles.dialogTitle}>删除标签</h3>
            <p className={styles.dialogText}>
              确定删除“{deleteDialogTag.name}”吗？删除后不会影响文件本身。
            </p>
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setDeleteDialogTag(null)}
                disabled={isBusy}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => {
                  void handleDeleteTagConfirm(deleteDialogTag).catch(
                    () => undefined,
                  );
                }}
                disabled={isBusy}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {contextMenu && contextMenuTag ? (
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            className={styles.contextMenuItem}
            onClick={() => handleStartRename(contextMenuTag)}
          >
            重命名
          </button>
          <button
            type="button"
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            onClick={() => {
              setContextMenu(null);
              setDeleteDialogTag(contextMenuTag);
            }}
          >
            删除
          </button>
        </div>
      ) : null}
    </>
  );
}

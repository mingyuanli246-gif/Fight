import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import {
  countTagUsageNotes,
  createTag,
  deleteTag,
  listTagContentPreviews,
  listTagsWithCounts,
  renameTag,
} from "../notebooks/repository";
import {
  DEFAULT_TAG_COLOR,
  TAG_COLOR_PALETTE,
  normalizeTagColor,
} from "../notebooks/tagColors";
import { validateTagName } from "../notebooks/tagNameValidation";
import type {
  NoteOpenTarget,
  TagContentPreviewResult,
  TagWithCount,
} from "../notebooks/types";
import styles from "./TagPlazaWorkspace.module.css";

const CONTEXT_MENU_WIDTH = 188;
const CONTEXT_MENU_HEIGHT = 128;
const CONTEXT_MENU_MARGIN = 12;
const DELETE_BLOCKED_MESSAGE_PATTERN =
  /^该标签仍被\s+(\d+)\s+个文件使用，需先移除正文中的标签后才能删除。?$/;
const EMPTY_PREVIEW_TEXT = "该标签所在正文暂无可预览内容";

interface TagPlazaWorkspaceProps {
  onOpenNote: (target: NoteOpenTarget) => void;
}

interface ContextMenuState {
  tagId: number;
  x: number;
  y: number;
}

interface DeleteDialogState {
  tag: TagWithCount;
  mode: "confirm" | "blocked";
  usageNoteCount: number;
}

interface ColorPickerProps {
  selectedColor: string;
  isOpen: boolean;
  label: string;
  pickerRef: RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onSelect: (color: string) => void;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "标签操作失败，请稍后重试。";
}

function parseDeleteBlockedUsageCount(error: unknown) {
  const match = getErrorMessage(error).match(DELETE_BLOCKED_MESSAGE_PATTERN);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

function getClampedContextMenuPosition(x: number, y: number) {
  const maxX = window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN;
  const maxY = window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN;

  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(x, maxX)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(y, maxY)),
  };
}

function handlePaletteControlMouseDown(event: ReactMouseEvent) {
  event.preventDefault();
}

function ColorPicker({
  selectedColor,
  isOpen,
  label,
  pickerRef,
  onToggle,
  onSelect,
}: ColorPickerProps) {
  const normalizedSelectedColor = normalizeTagColor(selectedColor);

  return (
    <div ref={pickerRef} className={styles.colorPicker}>
      <button
        type="button"
        className={styles.colorTrigger}
        style={{ backgroundColor: normalizedSelectedColor }}
        onMouseDown={handlePaletteControlMouseDown}
        onClick={onToggle}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      />

      {isOpen ? (
        <div className={styles.colorPalette} role="menu" aria-label="标签颜色">
          {TAG_COLOR_PALETTE.map((color) => {
            const isSelected = normalizedSelectedColor === color;

            return (
              <button
                key={color}
                type="button"
                className={`${styles.colorOption} ${
                  isSelected ? styles.colorOptionSelected : ""
                }`}
                style={{ backgroundColor: color }}
                onMouseDown={handlePaletteControlMouseDown}
                onClick={() => onSelect(normalizeTagColor(color))}
                aria-label={`选择颜色 ${color}`}
                aria-pressed={isSelected}
              >
                {isSelected ? (
                  <span className={styles.colorOptionIndicator}>✓</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function TagPlazaWorkspace({ onOpenNote }: TagPlazaWorkspaceProps) {
  const [tags, setTags] = useState<TagWithCount[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const [tagContentPreviews, setTagContentPreviews] = useState<
    TagContentPreviewResult[]
  >([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createValue, setCreateValue] = useState("");
  const [createSelectedColor, setCreateSelectedColor] = useState(DEFAULT_TAG_COLOR);
  const [isCreatePaletteOpen, setIsCreatePaletteOpen] = useState(false);
  const [createDialogError, setCreateDialogError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingTagId, setRenamingTagId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameSelectedColor, setRenameSelectedColor] = useState(DEFAULT_TAG_COLOR);
  const [isRenamePaletteOpen, setIsRenamePaletteOpen] = useState(false);
  const [deleteDialogState, setDeleteDialogState] =
    useState<DeleteDialogState | null>(null);
  const requestVersionRef = useRef(0);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const createColorPickerRef = useRef<HTMLDivElement | null>(null);
  const renameColorPickerRef = useRef<HTMLDivElement | null>(null);
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
    setCreateSelectedColor(DEFAULT_TAG_COLOR);
    setIsCreatePaletteOpen(false);
    setCreateDialogError(null);
  }

  function closeRenameEditor() {
    setRenamingTagId(null);
    setRenameValue("");
    setRenameSelectedColor(DEFAULT_TAG_COLOR);
    setIsRenamePaletteOpen(false);
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
        setTagContentPreviews([]);
      } finally {
        setIsInitializing(false);
      }
    })();
  }, [refreshTags]);

  useEffect(() => {
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;

    if (selectedTagId === null) {
      setTagContentPreviews([]);
      setIsLoadingPreviews(false);
      return;
    }

    setIsLoadingPreviews(true);

    void (async () => {
      try {
        const nextPreviews = await listTagContentPreviews(selectedTagId);

        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTagContentPreviews(nextPreviews);
      } catch (error) {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTagContentPreviews([]);
        setErrorMessage(getErrorMessage(error));
      } finally {
        if (requestVersion === requestVersionRef.current) {
          setIsLoadingPreviews(false);
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

    if (
      deleteDialogState &&
      !tags.some((tag) => tag.id === deleteDialogState.tag.id)
    ) {
      setDeleteDialogState(null);
    }
  }, [contextMenu, deleteDialogState, renamingTagId, tags]);

  useEffect(() => {
    function handleWindowPointerDown(event: MouseEvent) {
      const target = event.target as Node | null;

      if (contextMenuRef.current?.contains(target)) {
        return;
      }

      if (
        isCreatePaletteOpen &&
        !createColorPickerRef.current?.contains(target)
      ) {
        setIsCreatePaletteOpen(false);
      }

      if (
        isRenamePaletteOpen &&
        !renameColorPickerRef.current?.contains(target)
      ) {
        setIsRenamePaletteOpen(false);
      }

      setContextMenu(null);
    }

    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (isCreatePaletteOpen) {
        event.preventDefault();
        setIsCreatePaletteOpen(false);
        return;
      }

      if (isRenamePaletteOpen) {
        event.preventDefault();
        setIsRenamePaletteOpen(false);
        return;
      }

      setContextMenu(null);
      setDeleteDialogState(null);
      closeRenameEditor();
      closeCreateDialog();
    }

    window.addEventListener("pointerdown", handleWindowPointerDown);
    window.addEventListener("keydown", handleWindowKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handleWindowPointerDown);
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [isCreatePaletteOpen, isRenamePaletteOpen]);

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
    const { name, error } = validateTagName(createValue, {
      existingNames: tags.map((tag) => tag.name),
    });

    if (error) {
      setCreateDialogError(error);
      return;
    }

    await runMutation(async () => {
      const tag = await createTag(name, createSelectedColor);
      closeCreateDialog();
      await refreshTags(tag.id);
    });
  }

  async function handleRenameTagSubmit(tag: TagWithCount) {
    const { name, error } = validateTagName(renameValue, {
      existingNames: tags
        .filter((candidate) => candidate.id !== tag.id)
        .map((candidate) => candidate.name),
    });

    if (error) {
      setErrorMessage(error);
      return;
    }

    await runMutation(async () => {
      await renameTag(tag.id, name, renameSelectedColor);
      closeRenameEditor();
      await refreshTags(tag.id);
    });
  }

  async function handleDeleteTagConfirm(tag: TagWithCount) {
    setErrorMessage(null);
    setIsBusy(true);

    try {
      await deleteTag(tag.id);
      setDeleteDialogState(null);
      await refreshTags(null);
    } catch (error) {
      const usageNoteCount = parseDeleteBlockedUsageCount(error);

      if (usageNoteCount !== null) {
        setDeleteDialogState({
          tag,
          mode: "blocked",
          usageNoteCount,
        });
        return;
      }

      setErrorMessage(getErrorMessage(error));
      throw error;
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRequestDeleteTag(tag: TagWithCount) {
    setContextMenu(null);
    setErrorMessage(null);
    setIsBusy(true);

    try {
      const usageNoteCount = await countTagUsageNotes(tag.id);
      setDeleteDialogState({
        tag,
        mode: usageNoteCount > 0 ? "blocked" : "confirm",
        usageNoteCount,
      });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  function handleContextMenuOpen(
    tag: TagWithCount,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    handleSelectTag(tag.id);
    closeRenameEditor();
    setDeleteDialogState(null);
    setCreateDialogError(null);
    setContextMenu({
      tagId: tag.id,
      ...getClampedContextMenuPosition(event.clientX, event.clientY),
    });
  }

  function handleStartRename(tag: TagWithCount) {
    setContextMenu(null);
    setDeleteDialogState(null);
    handleSelectTag(tag.id);
    setRenameValue(tag.name);
    setRenameSelectedColor(normalizeTagColor(tag.color));
    setIsRenamePaletteOpen(false);
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
                  <ColorPicker
                    selectedColor={renameSelectedColor}
                    isOpen={isRenamePaletteOpen}
                    label={`修改标签 ${tag.name} 的颜色`}
                    pickerRef={renameColorPickerRef}
                    onToggle={() => {
                      setIsRenamePaletteOpen((current) => !current);
                    }}
                    onSelect={(color) => {
                      setRenameSelectedColor(color);
                      setIsRenamePaletteOpen(false);
                    }}
                  />
                  <span className={styles.tagItemText}>
                    <input
                      type="text"
                      className={styles.inlineNameInput}
                      value={renameValue}
                      maxLength={24}
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
                          if (isRenamePaletteOpen) {
                            setIsRenamePaletteOpen(false);
                            return;
                          }
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
                  style={{ backgroundColor: normalizeTagColor(tag.color) }}
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
        <p className={styles.statusText}>正在连接标签表并载入关联内容预览。</p>
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
                  setDeleteDialogState(null);
                  setCreateDialogError(null);
                  setCreateSelectedColor(DEFAULT_TAG_COLOR);
                  setIsCreatePaletteOpen(false);
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
              <h3 className={styles.panelTitle}>关联内容预览</h3>
            </div>
          </header>

          <div className={`${styles.panelBody} ${styles.notePanelBody}`}>
            {selectedTag === null ? (
              <div className={`${styles.emptyBlock} ${styles.emptyBlockCompact}`}>
                <p className={styles.emptyTitle}>先选择一个标签</p>
                <p className={styles.emptyText}>
                  点击左侧标签后，这里会显示对应的正文内容预览。
                </p>
              </div>
            ) : isLoadingPreviews ? (
              <div className={`${styles.emptyBlock} ${styles.emptyBlockCompact}`}>
                <p className={styles.emptyTitle}>正在读取关联内容预览…</p>
              </div>
            ) : tagContentPreviews.length === 0 ? (
              <div className={`${styles.emptyBlock} ${styles.emptyBlockCompact}`}>
                <p className={styles.emptyTitle}>这个标签还没有关联内容</p>
                <p className={styles.emptyText}>
                  你可以先回到笔记本，在正文里给一段内容打上这个标签。
                </p>
              </div>
            ) : (
              <ul className={styles.noteList}>
                {tagContentPreviews.map((note) => (
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
                      <span className={styles.previewText}>
                        {note.previewText.trim() || EMPTY_PREVIEW_TEXT}
                      </span>
                      <span className={styles.notePath}>{note.title}</span>
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
            <p className={styles.dialogText}>输入标签名称，最多 6 个单位。</p>
            <div className={styles.dialogInputRow}>
              <ColorPicker
                selectedColor={createSelectedColor}
                isOpen={isCreatePaletteOpen}
                label="选择标签颜色"
                pickerRef={createColorPickerRef}
                onToggle={() => {
                  setIsCreatePaletteOpen((current) => !current);
                }}
                onSelect={(color) => {
                  setCreateSelectedColor(color);
                  setIsCreatePaletteOpen(false);
                }}
              />
              <input
                type="text"
                className={styles.dialogInput}
                value={createValue}
                maxLength={24}
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
                    if (isCreatePaletteOpen) {
                      setIsCreatePaletteOpen(false);
                      return;
                    }
                    closeCreateDialog();
                  }
                }}
              />
            </div>
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

      {deleteDialogState ? (
        <div
          className={styles.dialogOverlay}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setDeleteDialogState(null);
            }
          }}
        >
          <div className={styles.dialogCard}>
            <h3 className={styles.dialogTitle}>
              {deleteDialogState.mode === "blocked" ? "暂时无法删除标签" : "删除标签"}
            </h3>
            <p className={styles.dialogText}>
              {deleteDialogState.mode === "blocked"
                ? `该标签仍被 ${deleteDialogState.usageNoteCount} 个文件使用，需先移除正文中的标签后才能删除。`
                : `确定删除“${deleteDialogState.tag.name}”吗？删除后不会影响文件本身。`}
            </p>
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setDeleteDialogState(null)}
                disabled={isBusy}
              >
                {deleteDialogState.mode === "blocked" ? "知道了" : "取消"}
              </button>
              {deleteDialogState.mode === "confirm" ? (
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={() => {
                    void handleDeleteTagConfirm(deleteDialogState.tag).catch(
                      () => undefined,
                    );
                  }}
                  disabled={isBusy}
                >
                  确认删除
                </button>
              ) : null}
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
              void handleRequestDeleteTag(contextMenuTag);
            }}
          >
            删除
          </button>
        </div>
      ) : null}
    </>
  );
}

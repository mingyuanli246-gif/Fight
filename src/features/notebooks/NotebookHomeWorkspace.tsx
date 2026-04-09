import { useEffect, useRef, useState } from "react";
import { GlobalSearch } from "../../app/layout/GlobalSearch";
import type {
  NoteOpenTarget,
  Notebook,
  NotebookHomeSort,
} from "./types";
import { ManagedResourceImage } from "./ManagedResourceImage";
import { SortIcon } from "./NotebookUiIcons";
import styles from "./NotebookWorkspaceShell.module.css";

const COVER_FALLBACKS = [
  "linear-gradient(135deg, #e0f2fe 0%, #dbeafe 48%, #f8fafc 100%)",
  "linear-gradient(135deg, #fae8ff 0%, #ede9fe 48%, #f8fafc 100%)",
  "linear-gradient(135deg, #dcfce7 0%, #d1fae5 48%, #f8fafc 100%)",
  "linear-gradient(135deg, #fef3c7 0%, #fee2e2 48%, #fff7ed 100%)",
  "linear-gradient(135deg, #e2e8f0 0%, #dbeafe 44%, #f8fafc 100%)",
];

interface NotebookHomeWorkspaceProps {
  notebooks: Notebook[];
  selectedNotebookId: number | null;
  disabled: boolean;
  sort: NotebookHomeSort;
  onSortChange: (sort: NotebookHomeSort) => void;
  onSelectNotebook: (notebookId: number) => void;
  onOpenNotebook: (notebookId: number) => void;
  onOpenSearchResult: (target: NoteOpenTarget) => void;
  onCreateNotebook: (name: string) => Promise<void>;
  onRenameNotebook: (id: number, name: string) => Promise<void>;
  onRequestDeleteNotebook: (notebook: Notebook) => void;
  onSetNotebookCoverImage: (id: number) => Promise<void>;
  onClearNotebookCoverImage: (id: number) => Promise<void>;
}

interface ContextMenuState {
  notebookId: number;
  x: number;
  y: number;
}

const SORT_OPTIONS: Array<{ value: NotebookHomeSort; label: string }> = [
  { value: "updated-desc", label: "最近更新优先" },
  { value: "created-desc", label: "创建时间优先" },
  { value: "name-asc", label: "名称 A-Z / 拼音顺序" },
  { value: "name-desc", label: "名称 Z-A / 逆序" },
];

function getNotebookFallbackBackground(notebook: Notebook) {
  const seed = (notebook.id + notebook.name.length) % COVER_FALLBACKS.length;
  return COVER_FALLBACKS[seed] ?? COVER_FALLBACKS[0];
}

export function NotebookHomeWorkspace({
  notebooks,
  selectedNotebookId,
  disabled,
  sort,
  onSortChange,
  onSelectNotebook,
  onOpenNotebook,
  onOpenSearchResult,
  onCreateNotebook,
  onRenameNotebook,
  onRequestDeleteNotebook,
  onSetNotebookCoverImage,
  onClearNotebookCoverImage,
}: NotebookHomeWorkspaceProps) {
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingNotebookId, setEditingNotebookId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createValue, setCreateValue] = useState("");
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const nameClickTimerRef = useRef<number | null>(null);

  const contextNotebook =
    contextMenu === null
      ? null
      : notebooks.find((notebook) => notebook.id === contextMenu.notebookId) ?? null;

  useEffect(() => {
    function handleWindowPointerDown(event: MouseEvent) {
      const target = event.target as Node | null;

      if (
        menuAnchorRef.current?.contains(target) ||
        contextMenuRef.current?.contains(target)
      ) {
        return;
      }

      setIsSortMenuOpen(false);
      setContextMenu(null);
    }

    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsSortMenuOpen(false);
        setContextMenu(null);
        setEditingNotebookId(null);
        setRenameValue("");
        setIsCreating(false);
      }
    }

    window.addEventListener("pointerdown", handleWindowPointerDown);
    window.addEventListener("keydown", handleWindowKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handleWindowPointerDown);
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, []);

  useEffect(() => {
    if (editingNotebookId === null) {
      return;
    }

    const notebook =
      notebooks.find((item) => item.id === editingNotebookId) ?? null;

    if (!notebook) {
      setEditingNotebookId(null);
      setRenameValue("");
    }
  }, [editingNotebookId, notebooks]);

  function startRename(notebook: Notebook) {
    setContextMenu(null);
    setEditingNotebookId(notebook.id);
    setRenameValue(notebook.name);
  }

  async function submitRename() {
    if (editingNotebookId === null) {
      return;
    }

    try {
      await onRenameNotebook(editingNotebookId, renameValue);
      setEditingNotebookId(null);
      setRenameValue("");
    } catch {
      // 错误由上层统一展示
    }
  }

  async function submitCreate() {
    try {
      await onCreateNotebook(createValue);
      setCreateValue("");
      setIsCreating(false);
    } catch {
      // 错误由上层统一展示
    }
  }

  return (
    <div className={styles.homeShell}>
      <section className={styles.homeHeader}>
        <div className={styles.homeSearchBand}>
          <GlobalSearch
            onOpenResult={onOpenSearchResult}
            variant="home"
            rootClassName={styles.notebookHomeSearchRoot}
            boxClassName={styles.notebookHomeSearchBox}
            rootStyle={{
              width: "460px",
              maxWidth: "460px",
            }}
            boxStyle={{
              minHeight: "58px",
              padding: "0 18px",
              borderRadius: "18px",
            }}
          />
        </div>
        <div className={styles.homeToolbarActions}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => setIsCreating(true)}
            disabled={disabled}
          >
            新建笔记本
          </button>
          <div ref={menuAnchorRef} className={styles.menuAnchor}>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setIsSortMenuOpen((current) => !current)}
              disabled={disabled}
              aria-label="切换排序"
            >
              <SortIcon className={styles.buttonIcon} />
            </button>
            {isSortMenuOpen ? (
              <div className={styles.sortMenu}>
                {SORT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`${styles.sortMenuButton} ${
                      option.value === sort ? styles.sortMenuButtonActive : ""
                    }`}
                    onClick={() => {
                      onSortChange(option.value);
                      setIsSortMenuOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {isCreating ? (
        <div className={styles.dialogOverlay}>
          <div className={styles.deleteDialog}>
            <h3 className={styles.dialogTitle}>新建笔记本</h3>
            <p className={styles.dialogText}>输入一个笔记本名称，创建后会出现在首页网格中。</p>
            <div className={styles.treeInlineEditor}>
              <input
                type="text"
                className={styles.inlineInput}
                value={createValue}
                onChange={(event) => setCreateValue(event.currentTarget.value)}
                placeholder="输入笔记本名称"
                maxLength={80}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitCreate();
                  }

                  if (event.key === "Escape") {
                    setCreateValue("");
                    setIsCreating(false);
                  }
                }}
              />
              <div className={styles.dialogActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => {
                    setCreateValue("");
                    setIsCreating(false);
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => {
                    void submitCreate();
                  }}
                  disabled={disabled}
                >
                  创建
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {notebooks.length === 0 ? (
        <section className={styles.homeEmptyState}>
          <h3 className={styles.homeEmptyTitle}>还没有任何笔记本</h3>
          <p className={styles.homeEmptyText}>
            先创建一个笔记本作为入口，之后就可以为它设置封面、建立文件夹，并开始写作。
          </p>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => setIsCreating(true)}
            disabled={disabled}
          >
            创建第一个笔记本
          </button>
        </section>
      ) : (
        <section className={styles.homeGrid}>
          {notebooks.map((notebook) => {
            const isSelected = notebook.id === selectedNotebookId;
            const isEditing = notebook.id === editingNotebookId;

            return (
              <article
                key={notebook.id}
                className={`${styles.notebookCard} ${
                  isSelected ? styles.notebookCardSelected : ""
                }`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onSelectNotebook(notebook.id);
                  setContextMenu({
                    notebookId: notebook.id,
                    x: event.clientX,
                    y: event.clientY,
                  });
                  setIsSortMenuOpen(false);
                }}
              >
                <button
                  type="button"
                  className={styles.notebookCover}
                  onClick={() => onOpenNotebook(notebook.id)}
                  disabled={disabled}
                >
                  <ManagedResourceImage
                    resourcePath={notebook.coverImagePath}
                    alt={`${notebook.name} 封面`}
                    imageClassName={styles.notebookCoverImage}
                    fallbackClassName={styles.notebookCoverFallback}
                    loadingClassName={styles.notebookCoverFallback}
                    fallbackTitle=""
                    fallbackMessage=""
                    fallbackStyle={{
                      background: getNotebookFallbackBackground(notebook),
                    }}
                  />
                </button>

                <div className={styles.notebookCardMeta}>
                  <div className={styles.notebookCardNameRow}>
                    {isEditing ? (
                      <div
                        className={`${styles.inlineNameEditor} ${styles.inlineNameEditorCentered}`}
                      >
                        <input
                          type="text"
                          className={`${styles.inlineNameInput} ${styles.inlineNameInputCentered}`}
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.currentTarget.value)}
                          maxLength={80}
                          autoFocus
                          onClick={(event) => event.stopPropagation()}
                          onBlur={() => {
                            setEditingNotebookId(null);
                            setRenameValue("");
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void submitRename();
                            }

                            if (event.key === "Escape") {
                              setEditingNotebookId(null);
                              setRenameValue("");
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={styles.ghostTitleButton}
                        onClick={() => {
                          if (nameClickTimerRef.current !== null) {
                            window.clearTimeout(nameClickTimerRef.current);
                          }

                          nameClickTimerRef.current = window.setTimeout(() => {
                            onOpenNotebook(notebook.id);
                            nameClickTimerRef.current = null;
                          }, 220);
                        }}
                        onDoubleClick={() => {
                          if (nameClickTimerRef.current !== null) {
                            window.clearTimeout(nameClickTimerRef.current);
                            nameClickTimerRef.current = null;
                          }

                          startRename(notebook);
                        }}
                      >
                        <h4 className={styles.notebookCardName}>{notebook.name}</h4>
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {contextMenu && contextNotebook ? (
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            className={styles.contextMenuButton}
            onClick={() => {
              startRename(contextNotebook);
            }}
          >
            重命名
          </button>
          <button
            type="button"
            className={styles.contextMenuButton}
            onClick={() => {
              void onSetNotebookCoverImage(contextNotebook.id);
              setContextMenu(null);
            }}
            disabled={disabled}
          >
            更换封面
          </button>
          <button
            type="button"
            className={styles.contextMenuButton}
            onClick={() => {
              void onClearNotebookCoverImage(contextNotebook.id);
              setContextMenu(null);
            }}
            disabled={disabled || contextNotebook.coverImagePath === null}
          >
            清除封面
          </button>
          <button
            type="button"
            className={`${styles.contextMenuButton} ${styles.contextMenuButtonDanger}`}
            onClick={() => {
              onRequestDeleteNotebook(contextNotebook);
              setContextMenu(null);
            }}
          >
            删除
          </button>
        </div>
      ) : null}
    </div>
  );
}

import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { GlobalSearch } from "../../app/layout/GlobalSearch";
import type { NoteOpenTarget, Notebook, NotebookHomeSort } from "./types";
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
  dragBusy: boolean;
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
  onReorderNotebooks: (orderedNotebookIds: number[]) => Promise<void>;
}

interface ContextMenuState {
  notebookId: number;
  x: number;
  y: number;
}

interface NotebookDropIndicator {
  notebookId: number;
  side: "before" | "after";
}

interface NotebookGridCardProps {
  notebook: Notebook;
  isSelected: boolean;
  isEditing: boolean;
  disabled: boolean;
  dragEnabled: boolean;
  isDragging: boolean;
  dropIndicatorSide: NotebookDropIndicator["side"] | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onStartRename: (notebook: Notebook) => void;
  onOpenNotebook: (notebookId: number) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  shouldSuppressNotebookOpen: () => boolean;
}

const SORT_OPTIONS: Array<{ value: NotebookHomeSort; label: string }> = [
  { value: "updated-desc", label: "最近更新优先" },
  { value: "created-desc", label: "创建时间优先" },
  { value: "custom", label: "自定义排序" },
  { value: "name-asc", label: "名称 A-Z / 拼音顺序" },
  { value: "name-desc", label: "名称 Z-A / 逆序" },
];

function getNotebookFallbackBackground(notebook: Notebook) {
  const seed = (notebook.id + notebook.name.length) % COVER_FALLBACKS.length;
  return COVER_FALLBACKS[seed] ?? COVER_FALLBACKS[0];
}

function reorderNotebookIds(
  notebookIds: number[],
  activeNotebookId: number,
  overNotebookId: number,
  side: NotebookDropIndicator["side"],
) {
  const reorderedIds = notebookIds.filter((notebookId) => notebookId !== activeNotebookId);
  const overIndex = reorderedIds.indexOf(overNotebookId);

  if (overIndex === -1) {
    return notebookIds;
  }

  const nextIndex = side === "after" ? overIndex + 1 : overIndex;
  reorderedIds.splice(nextIndex, 0, activeNotebookId);
  return reorderedIds;
}

function areArraysEqual(left: number[], right: number[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function NotebookDragPreview({
  notebook,
  isSelected,
}: {
  notebook: Notebook;
  isSelected: boolean;
}) {
  return (
    <article
      className={`${styles.notebookCard} ${styles.notebookCardOverlay} ${
        isSelected ? styles.notebookCardSelected : ""
      }`}
      data-drag-overlay="true"
    >
      <div className={styles.notebookCover}>
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
      </div>
      <div className={styles.notebookCardMeta}>
        <div className={styles.notebookCardNameRow}>
          <h4 className={styles.notebookCardName}>{notebook.name}</h4>
        </div>
      </div>
    </article>
  );
}

function NotebookGridCard({
  notebook,
  isSelected,
  isEditing,
  disabled,
  dragEnabled,
  isDragging,
  dropIndicatorSide,
  renameValue,
  onRenameValueChange,
  onSubmitRename,
  onCancelRename,
  onStartRename,
  onOpenNotebook,
  onOpenContextMenu,
  shouldSuppressNotebookOpen,
}: NotebookGridCardProps) {
  const clickTimerRef = useRef<number | null>(null);
  const { attributes, listeners, setNodeRef: setDraggableNodeRef } = useDraggable({
    id: `notebook-${notebook.id}`,
    data: {
      type: "notebook-card",
      notebookId: notebook.id,
    },
    disabled: !dragEnabled,
  });
  const { setNodeRef: setDroppableNodeRef } = useDroppable({
    id: `notebook-${notebook.id}`,
    data: {
      type: "notebook-card",
      notebookId: notebook.id,
    },
    disabled: !dragEnabled,
  });

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDraggableNodeRef(node);
      setDroppableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );

  return (
    <article
      ref={setNodeRef}
      className={`${styles.notebookCard} ${
        isSelected ? styles.notebookCardSelected : ""
      } ${isDragging ? styles.notebookCardDragging : ""} ${
        dropIndicatorSide === "before" ? styles.notebookCardDropBefore : ""
      } ${dropIndicatorSide === "after" ? styles.notebookCardDropAfter : ""}`}
      onContextMenu={onOpenContextMenu}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        className={styles.notebookCover}
        onClick={() => {
          if (shouldSuppressNotebookOpen()) {
            return;
          }

          onOpenNotebook(notebook.id);
        }}
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
                onChange={(event) => onRenameValueChange(event.currentTarget.value)}
                maxLength={80}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onBlur={onCancelRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void onSubmitRename();
                  }

                  if (event.key === "Escape") {
                    onCancelRename();
                  }
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              className={styles.ghostTitleButton}
              onClick={() => {
                if (shouldSuppressNotebookOpen()) {
                  return;
                }

                if (clickTimerRef.current !== null) {
                  window.clearTimeout(clickTimerRef.current);
                }

                clickTimerRef.current = window.setTimeout(() => {
                  onOpenNotebook(notebook.id);
                  clickTimerRef.current = null;
                }, 220);
              }}
              onDoubleClick={() => {
                if (clickTimerRef.current !== null) {
                  window.clearTimeout(clickTimerRef.current);
                  clickTimerRef.current = null;
                }

                onStartRename(notebook);
              }}
            >
              <h4 className={styles.notebookCardName}>{notebook.name}</h4>
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function NotebookHomeWorkspace({
  notebooks,
  selectedNotebookId,
  disabled,
  dragBusy,
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
  onReorderNotebooks,
}: NotebookHomeWorkspaceProps) {
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingNotebookId, setEditingNotebookId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createValue, setCreateValue] = useState("");
  const [activeNotebookId, setActiveNotebookId] = useState<number | null>(null);
  const [dropIndicator, setDropIndicator] = useState<NotebookDropIndicator | null>(null);
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const lastDragCompletedAtRef = useRef(0);
  const activeNotebookIdRef = useRef<number | null>(null);
  const dragCursorRef = useRef<{ x: number; y: number } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );

  const contextNotebook =
    contextMenu === null
      ? null
      : notebooks.find((notebook) => notebook.id === contextMenu.notebookId) ?? null;
  const activeNotebook =
    activeNotebookId === null
      ? null
      : notebooks.find((notebook) => notebook.id === activeNotebookId) ?? null;
  const isDragEnabled =
    sort === "custom" &&
    !disabled &&
    !dragBusy &&
    !isCreating &&
    editingNotebookId === null &&
    contextMenu === null &&
    !isSortMenuOpen;

  useEffect(() => {
    activeNotebookIdRef.current = activeNotebookId;
  }, [activeNotebookId]);

  useEffect(() => {
    function updateCursorPosition(event: PointerEvent) {
      dragCursorRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
    }

    function handleWindowPointerDown(event: PointerEvent) {
      updateCursorPosition(event);
    }

    function handleWindowPointerMove(event: PointerEvent) {
      updateCursorPosition(event);
    }

    window.addEventListener("pointerdown", handleWindowPointerDown, true);
    window.addEventListener("pointermove", handleWindowPointerMove, true);

    return () => {
      window.removeEventListener("pointerdown", handleWindowPointerDown, true);
      window.removeEventListener("pointermove", handleWindowPointerMove, true);
    };
  }, []);

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

  useEffect(() => {
    if (!isDragEnabled) {
      setActiveNotebookId(null);
      setDropIndicator(null);
    }
  }, [isDragEnabled]);

  const collisionDetection = useMemo<CollisionDetection>(() => {
    return (args) =>
      pointerWithin(args).filter(
        (entry) => entry.id !== `notebook-${activeNotebookIdRef.current ?? ""}`,
      );
  }, []);

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

  function shouldSuppressNotebookOpen() {
    return performance.now() - lastDragCompletedAtRef.current < 180;
  }

  function resolveDropIndicator(
    event: Pick<DragOverEvent | DragEndEvent, "active" | "over">,
  ) {
    if (!event.over || event.over.data.current?.type !== "notebook-card") {
      return null;
    }

    const activeRect =
      event.active.rect.current.translated ?? event.active.rect.current.initial;
    if (!activeRect) {
      return null;
    }

    const activeNotebookId = event.active.data.current?.notebookId;
    const overNotebookId = event.over.data.current?.notebookId;

    if (
      typeof activeNotebookId !== "number" ||
      typeof overNotebookId !== "number" ||
      activeNotebookId === overNotebookId
    ) {
      return null;
    }

    const pointerCenterX =
      dragCursorRef.current?.x ?? activeRect.left + activeRect.width / 2;
    const side =
      pointerCenterX < event.over.rect.left + event.over.rect.width / 2
        ? "before"
        : "after";

    return {
      notebookId: overNotebookId,
      side,
    } satisfies NotebookDropIndicator;
  }

  function handleDragStart(event: DragStartEvent) {
    const notebookId = event.active.data.current?.notebookId;

    if (typeof notebookId !== "number") {
      return;
    }

    onSelectNotebook(notebookId);
    setContextMenu(null);
    setIsSortMenuOpen(false);
    setActiveNotebookId(notebookId);
    setDropIndicator(null);
  }

  function handleDragOver(event: DragOverEvent) {
    const nextIndicator = resolveDropIndicator(event);
    setDropIndicator(nextIndicator);
  }

  function finishDragState() {
    if (activeNotebookIdRef.current !== null) {
      lastDragCompletedAtRef.current = performance.now();
    }

    dragCursorRef.current = null;
    setActiveNotebookId(null);
    setDropIndicator(null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const activeId = event.active.data.current?.notebookId;
    const indicator = resolveDropIndicator(event) ?? dropIndicator;

    if (typeof activeId !== "number" || indicator === null) {
      finishDragState();
      return;
    }

    const currentNotebookIds = notebooks.map((notebook) => notebook.id);
    const nextNotebookIds = reorderNotebookIds(
      currentNotebookIds,
      activeId,
      indicator.notebookId,
      indicator.side,
    );

    finishDragState();

    if (areArraysEqual(currentNotebookIds, nextNotebookIds)) {
      return;
    }

    try {
      await onReorderNotebooks(nextNotebookIds);
    } catch {
      // 错误和回滚由上层统一处理
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
            disabled={disabled || dragBusy}
          >
            新建笔记本
          </button>
          <div ref={menuAnchorRef} className={styles.menuAnchor}>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setIsSortMenuOpen((current) => !current)}
              disabled={disabled || dragBusy}
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
                  disabled={disabled || dragBusy}
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
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          measuring={{
            droppable: {
              strategy: MeasuringStrategy.Always,
            },
          }}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragCancel={finishDragState}
          onDragEnd={(event) => {
            void handleDragEnd(event);
          }}
        >
          <section className={styles.homeGrid}>
            {notebooks.map((notebook) => (
              <NotebookGridCard
                key={notebook.id}
                notebook={notebook}
                isSelected={notebook.id === selectedNotebookId}
                isEditing={notebook.id === editingNotebookId}
                disabled={disabled}
                dragEnabled={isDragEnabled && notebook.id !== editingNotebookId}
                isDragging={notebook.id === activeNotebookId}
                dropIndicatorSide={
                  dropIndicator?.notebookId === notebook.id ? dropIndicator.side : null
                }
                renameValue={renameValue}
                onRenameValueChange={setRenameValue}
                onSubmitRename={submitRename}
                onCancelRename={() => {
                  setEditingNotebookId(null);
                  setRenameValue("");
                }}
                onStartRename={startRename}
                onOpenNotebook={onOpenNotebook}
                onOpenContextMenu={(event) => {
                  event.preventDefault();
                  onSelectNotebook(notebook.id);
                  setContextMenu({
                    notebookId: notebook.id,
                    x: event.clientX,
                    y: event.clientY,
                  });
                  setIsSortMenuOpen(false);
                }}
                shouldSuppressNotebookOpen={shouldSuppressNotebookOpen}
              />
            ))}
          </section>

          <DragOverlay>
            {activeNotebook ? (
              <NotebookDragPreview
                notebook={activeNotebook}
                isSelected={activeNotebook.id === selectedNotebookId}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
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
              void onSetNotebookCoverImage(contextNotebook.id).catch(() => {
                // 错误由上层统一展示
              });
              setContextMenu(null);
            }}
            disabled={disabled || dragBusy}
          >
            更换封面
          </button>
          <button
            type="button"
            className={styles.contextMenuButton}
            onClick={() => {
              void onClearNotebookCoverImage(contextNotebook.id).catch(() => {
                // 错误由上层统一展示
              });
              setContextMenu(null);
            }}
            disabled={disabled || dragBusy || contextNotebook.coverImagePath === null}
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

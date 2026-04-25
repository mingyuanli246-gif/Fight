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
  type DragMoveEvent,
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

interface NotebookShellLayout {
  notebookId: number;
  rowIndex: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface NotebookGridCardProps {
  notebook: Notebook;
  isSelected: boolean;
  isEditing: boolean;
  disabled: boolean;
  menuDisabled: boolean;
  dragEnabled: boolean;
  isDragging: boolean;
  showTailInsertionBand: boolean;
  dropIndicatorSide: NotebookDropIndicator["side"] | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onStartRename: (notebook: Notebook) => void;
  onOpenNotebook: (notebookId: number) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onOpenActionMenu: (notebookId: number, anchorRect: DOMRect) => void;
  shouldSuppressNotebookOpen: () => boolean;
  onShellRefChange: (notebookId: number, node: HTMLDivElement | null) => void;
}

interface NotebookInsertionBandProps {
  droppableId: string;
  notebookId: number;
  side: "before" | "after";
  position: "before" | "after";
  enabled: boolean;
}

const SORT_OPTIONS: Array<{ value: NotebookHomeSort; label: string }> = [
  { value: "updated-desc", label: "最近更新优先" },
  { value: "created-desc", label: "创建时间优先" },
  { value: "custom", label: "自定义排序" },
  { value: "name-asc", label: "名称 A-Z / 拼音顺序" },
  { value: "name-desc", label: "名称 Z-A / 逆序" },
];

const NOTEBOOK_ROW_GROUP_THRESHOLD = 18;
const NOTEBOOK_VERTICAL_GAP_BUFFER = 34;
const NOTEBOOK_EDGE_BUFFER = 12;
const CONTEXT_MENU_MIN_WIDTH = 180;
const CONTEXT_MENU_VIEWPORT_MARGIN = 12;

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

function NotebookInsertionBand({
  droppableId,
  notebookId,
  side,
  position,
  enabled,
}: NotebookInsertionBandProps) {
  const { setNodeRef } = useDroppable({
    id: droppableId,
    data: {
      type: "notebook-insert",
      notebookId,
      side,
    },
    disabled: !enabled,
  });

  return (
    <div
      ref={setNodeRef}
      className={`${styles.notebookDropBand} ${
        position === "before"
          ? styles.notebookDropBandBefore
          : styles.notebookDropBandAfter
      }`}
      aria-hidden="true"
    />
  );
}

function NotebookGridCard({
  notebook,
  isSelected,
  isEditing,
  disabled,
  menuDisabled,
  dragEnabled,
  isDragging,
  showTailInsertionBand,
  dropIndicatorSide,
  renameValue,
  onRenameValueChange,
  onSubmitRename,
  onCancelRename,
  onStartRename,
  onOpenNotebook,
  onOpenContextMenu,
  onOpenActionMenu,
  shouldSuppressNotebookOpen,
  onShellRefChange,
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
    <div
      ref={(node) => onShellRefChange(notebook.id, node)}
      className={styles.notebookCardShell}
    >
      <NotebookInsertionBand
        droppableId={`notebook-insert-before-${notebook.id}`}
        notebookId={notebook.id}
        side="before"
        position="before"
        enabled={dragEnabled}
      />
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
        <div className={styles.notebookCover}>
          <button
            type="button"
            className={styles.notebookCoverOpenButton}
            onClick={() => {
              if (shouldSuppressNotebookOpen()) {
                return;
              }

              onOpenNotebook(notebook.id);
            }}
            disabled={disabled}
            aria-label={`打开笔记本：${notebook.name}`}
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
          <button
            type="button"
            className={styles.notebookCoverMenuButton}
            aria-label={`${notebook.name} 操作菜单`}
            disabled={menuDisabled || isEditing}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();

              if (menuDisabled || isEditing) {
                return;
              }

              onOpenActionMenu(notebook.id, event.currentTarget.getBoundingClientRect());
            }}
          >
            <span className={styles.notebookCoverMenuDots} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
        </div>

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
      {showTailInsertionBand ? (
        <NotebookInsertionBand
          droppableId={`notebook-insert-after-${notebook.id}`}
          notebookId={notebook.id}
          side="after"
          position="after"
          enabled={dragEnabled}
        />
      ) : null}
    </div>
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
  const notebookShellRefs = useRef(new Map<number, HTMLDivElement>());
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

  const setNotebookShellRef = useCallback(
    (notebookId: number, node: HTMLDivElement | null) => {
      if (node) {
        notebookShellRefs.current.set(notebookId, node);
        return;
      }

      notebookShellRefs.current.delete(notebookId);
    },
    [],
  );

  function getNotebookShellLayouts(excludedNotebookId: number | null) {
    const layouts: NotebookShellLayout[] = [];
    let currentRowTop: number | null = null;
    let currentRowIndex = -1;

    for (const notebook of notebooks) {
      if (notebook.id === excludedNotebookId) {
        continue;
      }

      const shell = notebookShellRefs.current.get(notebook.id);
      if (!shell) {
        continue;
      }

      const rect = shell.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      if (
        currentRowTop === null ||
        Math.abs(rect.top - currentRowTop) > NOTEBOOK_ROW_GROUP_THRESHOLD
      ) {
        currentRowIndex += 1;
        currentRowTop = rect.top;
      }

      layouts.push({
        notebookId: notebook.id,
        rowIndex: currentRowIndex,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      });
    }

    return layouts;
  }

  function resolveVerticalGapIndicator(activeNotebookId: number) {
    const pointer = dragCursorRef.current;
    if (!pointer) {
      return null;
    }

    const layouts = getNotebookShellLayouts(activeNotebookId);
    if (layouts.length === 0) {
      return null;
    }

    const firstLayout = layouts[0];
    const lastLayout = layouts[layouts.length - 1];
    const lastRowIndex = lastLayout?.rowIndex ?? 0;
    const firstRowLayouts = layouts.filter((layout) => layout.rowIndex === 0);
    const lastRowLayouts = layouts.filter((layout) => layout.rowIndex === lastRowIndex);
    const pointerWithinColumn = (layout: NotebookShellLayout) =>
      pointer.x >= layout.left && pointer.x <= layout.right;

    const firstRowTop = Math.min(...firstRowLayouts.map((layout) => layout.top));
    if (
      pointer.y >= firstRowTop - NOTEBOOK_VERTICAL_GAP_BUFFER &&
      pointer.y <= firstRowTop + NOTEBOOK_EDGE_BUFFER &&
      firstRowLayouts.some(pointerWithinColumn)
    ) {
      return {
        notebookId: firstLayout.notebookId,
        side: "before",
      } satisfies NotebookDropIndicator;
    }

    for (const layout of layouts) {
      if (layout.rowIndex === 0 || !pointerWithinColumn(layout)) {
        continue;
      }

      if (
        pointer.y >= layout.top - NOTEBOOK_VERTICAL_GAP_BUFFER &&
        pointer.y <= layout.top + NOTEBOOK_EDGE_BUFFER
      ) {
        return {
          notebookId: layout.notebookId,
          side: "before",
        } satisfies NotebookDropIndicator;
      }
    }

    const lastRowBottom = Math.max(...lastRowLayouts.map((layout) => layout.bottom));
    if (
      pointer.y >= lastRowBottom - NOTEBOOK_EDGE_BUFFER &&
      pointer.y <= lastRowBottom + NOTEBOOK_VERTICAL_GAP_BUFFER &&
      lastRowLayouts.some(pointerWithinColumn)
    ) {
      return {
        notebookId: lastLayout.notebookId,
        side: "after",
      } satisfies NotebookDropIndicator;
    }

    return null;
  }

  const updateDropIndicator = useCallback((nextIndicator: NotebookDropIndicator | null) => {
    setDropIndicator((currentIndicator) => {
      if (
        currentIndicator?.notebookId === nextIndicator?.notebookId &&
        currentIndicator?.side === nextIndicator?.side
      ) {
        return currentIndicator;
      }

      return nextIndicator;
    });
  }, []);

  const collisionDetection = useMemo<CollisionDetection>(() => {
    return (args) =>
      pointerWithin(args).filter((entry) => {
        const data = args.droppableContainers.find(
          (container) => container.id === entry.id,
        )?.data.current;

        if (!data) {
          return false;
        }

        if (
          (data.type === "notebook-card" || data.type === "notebook-insert") &&
          data.notebookId === activeNotebookIdRef.current
        ) {
          return false;
        }

        return data.type === "notebook-card" || data.type === "notebook-insert";
      });
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

  function openNotebookContextMenu(notebookId: number, x: number, y: number) {
    onSelectNotebook(notebookId);
    setContextMenu({
      notebookId,
      x,
      y,
    });
    setIsSortMenuOpen(false);
  }

  function openNotebookActionMenu(notebookId: number, anchorRect: DOMRect) {
    const maxX =
      window.innerWidth - CONTEXT_MENU_MIN_WIDTH - CONTEXT_MENU_VIEWPORT_MARGIN;
    const preferredX = anchorRect.right - CONTEXT_MENU_MIN_WIDTH;
    const x = Math.max(
      CONTEXT_MENU_VIEWPORT_MARGIN,
      Math.min(preferredX, maxX),
    );
    const y = Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, anchorRect.bottom + 8);

    openNotebookContextMenu(notebookId, x, y);
  }

  function resolveDropIndicator(
    event: Pick<DragMoveEvent | DragOverEvent | DragEndEvent, "active" | "over">,
  ) {
    const activeNotebookId = event.active.data.current?.notebookId;

    if (typeof activeNotebookId !== "number") {
      return null;
    }

    const gapIndicator = resolveVerticalGapIndicator(activeNotebookId);
    if (gapIndicator) {
      return gapIndicator;
    }

    if (!event.over) {
      return null;
    }

    const overType = event.over.data.current?.type;
    const overNotebookId = event.over.data.current?.notebookId;

    if (
      typeof overNotebookId !== "number" ||
      activeNotebookId === overNotebookId
    ) {
      return null;
    }

    if (overType === "notebook-insert") {
      const side = event.over.data.current?.side;

      if (side !== "before" && side !== "after") {
        return null;
      }

      return {
        notebookId: overNotebookId,
        side,
      } satisfies NotebookDropIndicator;
    }

    if (overType !== "notebook-card") {
      return null;
    }

    const activeRect =
      event.active.rect.current.translated ?? event.active.rect.current.initial;
    if (!activeRect) {
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

  function handleDragMove(event: DragMoveEvent) {
    const nextIndicator = resolveDropIndicator(event);
    updateDropIndicator(nextIndicator);
  }

  function handleDragOver(event: DragOverEvent) {
    const nextIndicator = resolveDropIndicator(event);
    updateDropIndicator(nextIndicator);
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
          onDragMove={handleDragMove}
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
                menuDisabled={disabled || dragBusy || isCreating}
                dragEnabled={isDragEnabled && notebook.id !== editingNotebookId}
                isDragging={notebook.id === activeNotebookId}
                showTailInsertionBand={
                  notebook.id === notebooks[notebooks.length - 1]?.id
                }
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
                  openNotebookContextMenu(notebook.id, event.clientX, event.clientY);
                }}
                onOpenActionMenu={openNotebookActionMenu}
                shouldSuppressNotebookOpen={shouldSuppressNotebookOpen}
                onShellRefChange={setNotebookShellRef}
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

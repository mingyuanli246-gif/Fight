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
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Folder, Note, Notebook, SelectedEntity } from "./types";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "./NotebookUiIcons";
import { ItemActionMenu } from "./ItemActionMenu";
import styles from "./NotebookWorkspaceShell.module.css";

const AUTO_SCROLL_ACTIVATE_DELAY_MS = 180;
const AUTO_SCROLL_EDGE_THRESHOLD_PX = 40;
const AUTO_SCROLL_SPEED_PX_PER_SECOND = 260;

interface RenameState {
  kind: "folder" | "note";
  id: number;
  value: string;
}

interface ContextMenuState {
  kind: "folder" | "note";
  id: number;
  x: number;
  y: number;
}

interface NotebookTreePaneProps {
  notebook: Notebook | null;
  folders: Folder[];
  notes: Note[];
  selectedEntity: SelectedEntity | null;
  activeFolderId: number | null;
  disabled: boolean;
  onError: (message: string) => void;
  onReturnHome: () => void;
  onSelectEntity: (entity: SelectedEntity) => void;
  onCreateFolder: () => Promise<void>;
  onCreateNote: () => Promise<void>;
  onRenameFolder: (id: number, name: string) => Promise<void>;
  onRenameNote: (id: number, title: string) => Promise<void>;
  onRequestDeleteFolder: (folder: Folder) => void;
  onRequestDeleteNote: (note: Note) => void;
  onReorderFolders: (orderedFolderIds: number[]) => Promise<void>;
  onMoveNote: (
    noteId: number,
    targetFolderId: number,
    targetIndex: number,
  ) => Promise<Note>;
}

type TreeDragItem =
  | {
      type: "folder";
      folderId: number;
    }
  | {
      type: "note";
      noteId: number;
      folderId: number | null;
    };

type TreeDropIndicator =
  | {
      kind: "folder";
      folderId: number;
      side: "before" | "after";
    }
  | {
      kind: "note";
      noteId: number;
      folderId: number;
      side: "before" | "after";
    }
  | {
      kind: "folder-empty";
      folderId: number;
    };

type PointerDropTarget =
  | {
      type: "folder-row";
      folderId: number;
      rect: DOMRect;
    }
  | {
      type: "note-row";
      noteId: number;
      folderId: number;
      rect: DOMRect;
    }
  | {
      type: "empty-folder";
      folderId: number;
      rect: DOMRect;
    }
  | {
      type: "folder-insert";
      folderId: number;
      side: "before" | "after";
    }
  | {
      type: "note-insert";
      noteId: number;
      folderId: number;
      side: "before" | "after";
    };

type TreeOverTarget =
  DragOverEvent["over"]
  | DragEndEvent["over"]
  | null;

interface TreeFolderRowProps {
  folder: Folder;
  noteCount: number;
  isExpanded: boolean;
  isActive: boolean;
  isEditing: boolean;
  disabled: boolean;
  dragEnabled: boolean;
  isDragging: boolean;
  dropIndicatorSide: "before" | "after" | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onSelectFolder: () => void;
  onToggleFolder: () => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onStartRename: () => void;
}

interface TreeNoteRowProps {
  note: Note;
  isActive: boolean;
  isEditing: boolean;
  disabled: boolean;
  dragEnabled: boolean;
  isDragging: boolean;
  dropIndicatorSide: "before" | "after" | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onSelectNote: () => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onStartRename: () => void;
}

interface TreeInsertionBandProps {
  droppableId: string;
  dropType: "folder-insert" | "note-insert";
  side: "before" | "after";
  folderId: number;
  noteId?: number;
  position: "before" | "after";
}

function buildExpandedSet(folderIds: number[]) {
  return new Set(folderIds);
}

function combineNodeRefs<T>(
  ...refs: Array<(node: T | null) => void>
) {
  return (node: T | null) => {
    refs.forEach((ref) => ref(node));
  };
}

function getActiveRectCenter(
  active: DragStartEvent["active"] | DragMoveEvent["active"] | DragOverEvent["active"] | DragEndEvent["active"],
) {
  const activeRect =
    active.rect.current.translated ?? active.rect.current.initial;

  if (!activeRect) {
    return null;
  }

  return {
    x: activeRect.left + activeRect.width / 2,
    y: activeRect.top + activeRect.height / 2,
  };
}

function reorderLinearIds(
  itemIds: number[],
  activeId: number,
  overId: number,
  side: "before" | "after",
) {
  const reorderedIds = itemIds.filter((itemId) => itemId !== activeId);
  const overIndex = reorderedIds.indexOf(overId);

  if (overIndex === -1) {
    return itemIds;
  }

  const nextIndex = side === "after" ? overIndex + 1 : overIndex;
  reorderedIds.splice(nextIndex, 0, activeId);
  return reorderedIds;
}

function TreeDragPreview({
  item,
  folderName,
  noteTitle,
}: {
  item: TreeDragItem;
  folderName: string | null;
  noteTitle: string | null;
}) {
  if (item.type === "folder") {
    return (
      <div
        className={`${styles.treeRow} ${styles.treeDragOverlay}`}
        data-drag-overlay="true"
      >
        <span className={styles.treeLabelWrap}>
          <span className={styles.treeLabel}>{folderName ?? "文件夹"}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      className={`${styles.treeNoteRow} ${styles.treeDragOverlay}`}
      data-drag-overlay="true"
    >
      <span className={styles.treeLabelWrap}>
        <span className={styles.treeLabel}>{noteTitle ?? "文件"}</span>
      </span>
    </div>
  );
}

function TreeFolderRow({
  folder,
  noteCount,
  isExpanded,
  isActive,
  isEditing,
  disabled,
  dragEnabled,
  isDragging,
  dropIndicatorSide,
  renameValue,
  onRenameValueChange,
  onSubmitRename,
  onCancelRename,
  onSelectFolder,
  onToggleFolder,
  onOpenContextMenu,
  onStartRename,
}: TreeFolderRowProps) {
  const { attributes, listeners, setNodeRef: setDraggableRef } = useDraggable({
    id: `tree-folder-${folder.id}`,
    data: {
      type: "folder-row",
      folderId: folder.id,
    },
    disabled: !dragEnabled,
  });
  const { setNodeRef: setDroppableRef } = useDroppable({
    id: `tree-folder-${folder.id}`,
    data: {
      type: "folder-row",
      folderId: folder.id,
    },
    disabled: !dragEnabled,
  });

  return (
    <div className={styles.treeRowShell}>
      <button
        type="button"
        className={styles.treeDisclosureButton}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFolder();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        disabled={disabled}
        aria-label={isExpanded ? "收起文件夹" : "展开文件夹"}
      >
        {isExpanded ? (
          <ChevronDownIcon className={styles.treeRowIcon} />
        ) : (
          <ChevronRightIcon className={styles.treeRowIcon} />
        )}
      </button>
      {isEditing ? (
        <div
          className={`${styles.treeRow} ${styles.treeRowActive} ${styles.treeRowEditing}`}
        >
          <span className={styles.treeLabelWrap}>
            <div className={styles.inlineNameEditor}>
              <input
                type="text"
                className={`${styles.inlineNameInput} ${styles.inlineNameInputCompact}`}
                value={renameValue}
                onChange={(event) => onRenameValueChange(event.currentTarget.value)}
                autoFocus
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
            <span className={styles.treeMeta}>{noteCount} 个文件</span>
          </span>
        </div>
      ) : (
        <button
          ref={combineNodeRefs(setDraggableRef, setDroppableRef)}
          type="button"
          data-tree-drop-type="folder-row"
          data-tree-folder-id={folder.id}
          className={`${styles.treeRow} ${
            isActive ? styles.treeRowActive : ""
          } ${isDragging ? styles.treeDragSource : ""} ${
            dropIndicatorSide === "before" ? styles.treeDropBefore : ""
          } ${dropIndicatorSide === "after" ? styles.treeDropAfter : ""}`}
          onContextMenu={onOpenContextMenu}
          onClick={onSelectFolder}
          disabled={disabled}
          {...attributes}
          {...listeners}
        >
          <span className={styles.treeLabelWrap}>
            <span
              className={styles.treeLabel}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onStartRename();
              }}
            >
              {folder.name}
            </span>
            <span className={styles.treeMeta}>{noteCount} 个文件</span>
          </span>
        </button>
      )}
    </div>
  );
}

function TreeNoteRow({
  note,
  isActive,
  isEditing,
  disabled,
  dragEnabled,
  isDragging,
  dropIndicatorSide,
  renameValue,
  onRenameValueChange,
  onSubmitRename,
  onCancelRename,
  onSelectNote,
  onOpenContextMenu,
  onStartRename,
}: TreeNoteRowProps) {
  const { attributes, listeners, setNodeRef: setDraggableRef } = useDraggable({
    id: `tree-note-${note.id}`,
    data: {
      type: "note-row",
      noteId: note.id,
      folderId: note.folderId,
    },
    disabled: !dragEnabled,
  });
  const { setNodeRef: setDroppableRef } = useDroppable({
    id: `tree-note-${note.id}`,
    data: {
      type: "note-row",
      noteId: note.id,
      folderId: note.folderId,
    },
    disabled: !dragEnabled,
  });

  if (isEditing) {
    return (
      <div
        className={`${styles.treeNoteRow} ${styles.treeNoteRowActive} ${styles.treeNoteRowEditing}`}
      >
        <span className={styles.treeLabelWrap}>
          <div className={styles.inlineNameEditor}>
            <input
              type="text"
              className={`${styles.inlineNameInput} ${styles.inlineNameInputCompact}`}
              value={renameValue}
              onChange={(event) => onRenameValueChange(event.currentTarget.value)}
              autoFocus
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
        </span>
      </div>
    );
  }

  return (
    <button
      ref={combineNodeRefs(setDraggableRef, setDroppableRef)}
      type="button"
      data-tree-drop-type="note-row"
      data-tree-note-id={note.id}
      data-tree-folder-id={note.folderId ?? undefined}
      className={`${styles.treeNoteRow} ${
        isActive ? styles.treeNoteRowActive : ""
      } ${isDragging ? styles.treeDragSource : ""} ${
        dropIndicatorSide === "before" ? styles.treeDropBefore : ""
      } ${dropIndicatorSide === "after" ? styles.treeDropAfter : ""}`}
      onContextMenu={onOpenContextMenu}
      onClick={onSelectNote}
      disabled={disabled}
      {...attributes}
      {...listeners}
    >
      <span className={styles.treeLabelWrap}>
        <span
          className={styles.treeLabel}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onStartRename();
          }}
        >
          {note.title}
        </span>
      </span>
    </button>
  );
}

function TreeInsertionBand({
  droppableId,
  dropType,
  side,
  folderId,
  noteId,
  position,
}: TreeInsertionBandProps) {
  const { setNodeRef } = useDroppable({
    id: droppableId,
    data: {
      type: dropType,
      side,
      folderId,
      noteId,
    },
  });

  return (
    <div
      ref={setNodeRef}
      data-tree-drop-type={dropType}
      data-tree-drop-side={side}
      data-tree-folder-id={folderId}
      data-tree-note-id={noteId}
      className={`${styles.treeDropBand} ${
        position === "before"
          ? styles.treeDropBandBefore
          : styles.treeDropBandAfter
      }`}
      aria-hidden="true"
    />
  );
}

function EmptyFolderDropZone({
  folderId,
  active,
}: {
  folderId: number;
  active: boolean;
}) {
  const { setNodeRef } = useDroppable({
    id: `tree-empty-${folderId}`,
    data: {
      type: "empty-folder",
      folderId,
    },
  });

  return (
    <div
      ref={setNodeRef}
      data-tree-drop-type="empty-folder"
      data-tree-folder-id={folderId}
      className={`${styles.treeEmptyDropZone} ${
        active ? styles.treeEmptyDropZoneActive : ""
      }`}
    >
      拖到这里放入文件夹
    </div>
  );
}

export function NotebookTreePane({
  notebook,
  folders,
  notes,
  selectedEntity,
  activeFolderId,
  disabled,
  onError,
  onReturnHome,
  onSelectEntity,
  onCreateFolder,
  onCreateNote,
  onRenameFolder,
  onRenameNote,
  onRequestDeleteFolder,
  onRequestDeleteNote,
  onReorderFolders,
  onMoveNote,
}: NotebookTreePaneProps) {
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(
    () => buildExpandedSet([]),
  );
  const [renameState, setRenameState] = useState<RenameState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [activeDragItem, setActiveDragItem] = useState<TreeDragItem | null>(null);
  const [dropIndicator, setDropIndicator] = useState<TreeDropIndicator | null>(null);
  const lastNotebookIdRef = useRef<number | null>(null);
  const treeBodyRef = useRef<HTMLDivElement | null>(null);
  const pendingExpandTimerRef = useRef<number | null>(null);
  const pendingExpandFolderIdRef = useRef<number | null>(null);
  const dragPointerCenterRef = useRef<{ x: number; y: number } | null>(null);
  const dragCursorRef = useRef<{ x: number; y: number } | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);
  const autoScrollDelayTimerRef = useRef<number | null>(null);
  const autoScrollDirectionRef = useRef<"up" | "down" | null>(null);
  const autoScrollLastFrameAtRef = useRef<number | null>(null);
  const preDragExpandedFolderIdsRef = useRef<Set<number>>(buildExpandedSet([]));
  const activeDragItemRef = useRef<TreeDragItem | null>(null);
  const lastDragOverAtRef = useRef(0);
  const lastDragCompletedAtRef = useRef(0);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
  );

  useEffect(() => {
    function updateCursorPosition(event: PointerEvent) {
      dragCursorRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
    }

    function handleWindowPointerMove(event: PointerEvent) {
      updateCursorPosition(event);
    }

    function handleWindowPointerDown(event: PointerEvent) {
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
    activeDragItemRef.current = activeDragItem;
  }, [activeDragItem]);

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

  const noteById = useMemo(
    () => new Map(notes.map((note) => [note.id, note])),
    [notes],
  );
  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const canCreateNote = activeFolderId !== null;
  const dragEnabled = !disabled && renameState === null && contextMenu === null;

  useEffect(() => {
    if (!notebook) {
      setExpandedFolderIds(buildExpandedSet([]));
      setRenameState(null);
      setContextMenu(null);
      activeDragItemRef.current = null;
      dragPointerCenterRef.current = null;
      dragCursorRef.current = null;
      setActiveDragItem(null);
      setDropIndicator(null);
      if (pendingExpandTimerRef.current !== null) {
        window.clearTimeout(pendingExpandTimerRef.current);
        pendingExpandTimerRef.current = null;
      }
      pendingExpandFolderIdRef.current = null;
      clearAutoScrollDelayTimer();
      if (autoScrollRafRef.current !== null) {
        window.cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
      autoScrollDirectionRef.current = null;
      autoScrollLastFrameAtRef.current = null;
      lastDragOverAtRef.current = 0;
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

  useEffect(() => {
    return () => {
      if (pendingExpandTimerRef.current !== null) {
        window.clearTimeout(pendingExpandTimerRef.current);
      }

      if (autoScrollDelayTimerRef.current !== null) {
        window.clearTimeout(autoScrollDelayTimerRef.current);
      }

      if (autoScrollRafRef.current !== null) {
        window.cancelAnimationFrame(autoScrollRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (contextMenu === null) {
      return;
    }

    if (
      contextMenu.kind === "folder" &&
      !folders.some((folder) => folder.id === contextMenu.id)
    ) {
      setContextMenu(null);
      return;
    }

    if (
      contextMenu.kind === "note" &&
      !notes.some((note) => note.id === contextMenu.id)
    ) {
      setContextMenu(null);
    }
  }, [contextMenu, folders, notes]);

  const collisionDetection = useMemo<CollisionDetection>(() => {
    return (args) => {
      const currentActive = activeDragItemRef.current;
      const collisions = pointerWithin(args);

      if (!currentActive) {
        return collisions;
      }

      return collisions.filter((entry) => {
        const data = args.droppableContainers.find(
          (container) => container.id === entry.id,
        )?.data.current;

        if (!data) {
          return false;
        }

        if (currentActive.type === "folder") {
          return (
            (data.type === "folder-row" || data.type === "folder-insert") &&
            data.folderId !== currentActive.folderId
          );
        }

        if (data.type === "folder-row") {
          return data.folderId !== currentActive.folderId;
        }

        if (data.type === "folder-insert") {
          return false;
        }

        if (data.type === "empty-folder") {
          return true;
        }

        if (data.type === "note-insert") {
          return data.noteId !== currentActive.noteId;
        }

        return data.type === "note-row" && data.noteId !== currentActive.noteId;
      });
    };
  }, []);

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

  function clearPendingExpand() {
    if (pendingExpandTimerRef.current !== null) {
      window.clearTimeout(pendingExpandTimerRef.current);
      pendingExpandTimerRef.current = null;
    }

    pendingExpandFolderIdRef.current = null;
  }

  function clearAutoScrollDelayTimer() {
    if (autoScrollDelayTimerRef.current !== null) {
      window.clearTimeout(autoScrollDelayTimerRef.current);
      autoScrollDelayTimerRef.current = null;
    }
  }

  function stopAutoScroll() {
    clearAutoScrollDelayTimer();

    if (autoScrollRafRef.current !== null) {
      window.cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }

    autoScrollDirectionRef.current = null;
    autoScrollLastFrameAtRef.current = null;
  }

  function getAutoScrollDirection() {
    const pointerCenter = dragCursorRef.current ?? dragPointerCenterRef.current;
    const container = treeBodyRef.current;

    if (!pointerCenter || !container || isPointerInsideScrollbarGutter()) {
      return null;
    }

    const containerRect = container.getBoundingClientRect();

    if (pointerCenter.y <= containerRect.top + AUTO_SCROLL_EDGE_THRESHOLD_PX) {
      return "up" as const;
    }

    if (pointerCenter.y >= containerRect.bottom - AUTO_SCROLL_EDGE_THRESHOLD_PX) {
      return "down" as const;
    }

    return null;
  }

  function runAutoScrollFrame(timestamp: number) {
    autoScrollRafRef.current = null;

    const container = treeBodyRef.current;
    const direction = autoScrollDirectionRef.current;
    const nextDirection = getAutoScrollDirection();

    if (!container || !direction || nextDirection !== direction) {
      stopAutoScroll();
      refreshDragFeedback();
      return;
    }

    const previousTimestamp = autoScrollLastFrameAtRef.current ?? timestamp;
    const elapsedMs = Math.min(timestamp - previousTimestamp, 32);
    autoScrollLastFrameAtRef.current = timestamp;

    const scrollStep = Math.max(
      1,
      Math.round((AUTO_SCROLL_SPEED_PX_PER_SECOND * elapsedMs) / 1000),
    );
    const previousScrollTop = container.scrollTop;
    container.scrollTop += direction === "up" ? -scrollStep : scrollStep;

    refreshDragFeedback();

    if (container.scrollTop === previousScrollTop) {
      stopAutoScroll();
      return;
    }

    autoScrollRafRef.current = window.requestAnimationFrame(runAutoScrollFrame);
  }

  function syncAutoScroll() {
    const nextDirection = getAutoScrollDirection();

    if (nextDirection === null) {
      stopAutoScroll();
      return;
    }

    if (autoScrollDirectionRef.current === nextDirection) {
      if (autoScrollDelayTimerRef.current !== null || autoScrollRafRef.current !== null) {
        return;
      }
    }

    stopAutoScroll();
    autoScrollDirectionRef.current = nextDirection;
    autoScrollDelayTimerRef.current = window.setTimeout(() => {
      autoScrollDelayTimerRef.current = null;

      if (getAutoScrollDirection() !== nextDirection) {
        stopAutoScroll();
        return;
      }

      autoScrollLastFrameAtRef.current = null;
      autoScrollRafRef.current = window.requestAnimationFrame(runAutoScrollFrame);
    }, AUTO_SCROLL_ACTIVATE_DELAY_MS);
  }

  function updateDragPointer(active: DragMoveEvent["active"] | DragOverEvent["active"] | DragStartEvent["active"] | DragEndEvent["active"]) {
    const pointerCenter = dragCursorRef.current ?? getActiveRectCenter(active);
    dragPointerCenterRef.current = pointerCenter;

    if (pointerCenter === null) {
      clearPendingExpand();
      setDropIndicator(null);
      stopAutoScroll();
      return;
    }

    syncAutoScroll();
  }

  function restoreExpandedFolders(preserveFolderIds: Set<number> = new Set()) {
    clearPendingExpand();
    setExpandedFolderIds(() => {
      const next = new Set(preDragExpandedFolderIdsRef.current);
      for (const folderId of preserveFolderIds) {
        next.add(folderId);
      }
      return next;
    });
  }

  function finishVisualDragState() {
    if (activeDragItemRef.current !== null) {
      lastDragCompletedAtRef.current = performance.now();
    }

    clearPendingExpand();
    stopAutoScroll();
    dragPointerCenterRef.current = null;
    dragCursorRef.current = null;
    lastDragOverAtRef.current = 0;
    activeDragItemRef.current = null;
    setActiveDragItem(null);
    setDropIndicator(null);
  }

  function startRename(kind: RenameState["kind"], id: number, value: string) {
    setContextMenu(null);
    setRenameState({
      kind,
      id,
      value,
    });
  }

  function shouldSuppressSelection() {
    return performance.now() - lastDragCompletedAtRef.current < 180;
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

  function openContextMenu(
    item: { kind: "folder"; value: Folder } | { kind: "note"; value: Note },
    position: { x: number; y: number },
  ) {
    onSelectEntity({ kind: item.kind, id: item.value.id });
    setContextMenu({
      kind: item.kind,
      id: item.value.id,
      x: position.x,
      y: position.y,
    });
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

  async function handleCreateFolderClick() {
    setContextMenu(null);

    try {
      await onCreateFolder();
    } catch {
      // 错误由上层统一展示
    }
  }

  async function handleCreateNoteClick() {
    setContextMenu(null);

    if (!canCreateNote) {
      onError("请先选择文件夹");
      return;
    }

    try {
      await onCreateNote();
    } catch {
      // 错误由上层统一展示
    }
  }

  function isPointerInsideScrollbarGutter() {
    const pointerCenter = dragCursorRef.current ?? dragPointerCenterRef.current;
    const container = treeBodyRef.current;

    if (!pointerCenter || !container) {
      return false;
    }

    const scrollbarWidth = container.offsetWidth - container.clientWidth;
    if (scrollbarWidth <= 0) {
      return false;
    }

    const containerRect = container.getBoundingClientRect();
    return pointerCenter.x >= containerRect.right - scrollbarWidth;
  }

  function resolvePointerDropTarget(activeItem: TreeDragItem | null) {
    const pointerCenter = dragCursorRef.current;

    if (!pointerCenter || isPointerInsideScrollbarGutter()) {
      return null;
    }

    const rawElement = document.elementFromPoint(pointerCenter.x, pointerCenter.y);
    if (!(rawElement instanceof HTMLElement)) {
      return null;
    }

    if (rawElement.closest("[data-drag-overlay='true']")) {
      return null;
    }

    const targetElement = rawElement.closest<HTMLElement>("[data-tree-drop-type]");

    if (!targetElement) {
      return null;
    }

    const dropType = targetElement.dataset.treeDropType;
    const folderId = Number(targetElement.dataset.treeFolderId);
    const noteId = Number(targetElement.dataset.treeNoteId);
    const dropSide = targetElement.dataset.treeDropSide;
    const rect = targetElement.getBoundingClientRect();

    if (dropType === "folder-row" && Number.isFinite(folderId)) {
      if (activeItem?.type === "folder" && folderId === activeItem.folderId) {
        return null;
      }

      return {
        type: "folder-row",
        folderId,
        rect,
      } satisfies PointerDropTarget;
    }

    if (
      dropType === "note-row" &&
      Number.isFinite(folderId) &&
      Number.isFinite(noteId)
    ) {
      if (activeItem?.type === "note" && noteId === activeItem.noteId) {
        return null;
      }

      return {
        type: "note-row",
        noteId,
        folderId,
        rect,
      } satisfies PointerDropTarget;
    }

    if (dropType === "empty-folder" && Number.isFinite(folderId)) {
      return {
        type: "empty-folder",
        folderId,
        rect,
      } satisfies PointerDropTarget;
    }

    if (
      dropType === "folder-insert" &&
      Number.isFinite(folderId) &&
      (dropSide === "before" || dropSide === "after")
    ) {
      return {
        type: "folder-insert",
        folderId,
        side: dropSide,
      } satisfies PointerDropTarget;
    }

    if (
      dropType === "note-insert" &&
      Number.isFinite(folderId) &&
      Number.isFinite(noteId) &&
      (dropSide === "before" || dropSide === "after")
    ) {
      return {
        type: "note-insert",
        noteId,
        folderId,
        side: dropSide,
      } satisfies PointerDropTarget;
    }

    return null;
  }

  function resolveDropIndicatorFromPointer(activeItem: TreeDragItem | null) {
    if (!activeItem) {
      return null;
    }

    const pointerCenter = dragCursorRef.current;
    const target = resolvePointerDropTarget(activeItem);

    if (!pointerCenter || !target) {
      return null;
    }

    if (activeItem.type === "folder" && target.type === "folder-row") {
      if (target.folderId === activeItem.folderId) {
        return null;
      }

      return {
        kind: "folder",
        folderId: target.folderId,
        side:
          pointerCenter.y < target.rect.top + target.rect.height / 2
            ? "before"
            : "after",
      } satisfies TreeDropIndicator;
    }

    if (activeItem.type === "folder" && target.type === "folder-insert") {
      return {
        kind: "folder",
        folderId: target.folderId,
        side: target.side,
      } satisfies TreeDropIndicator;
    }

    if (activeItem.type !== "note") {
      return null;
    }

    if (target.type === "empty-folder") {
      return {
        kind: "folder-empty",
        folderId: target.folderId,
      } satisfies TreeDropIndicator;
    }

    if (target.type === "note-insert") {
      if (target.noteId === activeItem.noteId) {
        return null;
      }

      return {
        kind: "note",
        noteId: target.noteId,
        folderId: target.folderId,
        side: target.side,
      } satisfies TreeDropIndicator;
    }

    if (target.type !== "note-row" || target.noteId === activeItem.noteId) {
      return null;
    }

    return {
      kind: "note",
      noteId: target.noteId,
      folderId: target.folderId,
      side:
        pointerCenter.y < target.rect.top + target.rect.height / 2
          ? "before"
          : "after",
    } satisfies TreeDropIndicator;
  }

  function resolveDropIndicatorFromOver(
    activeItem: TreeDragItem | null,
    over: TreeOverTarget,
    active:
      | DragStartEvent["active"]
      | DragMoveEvent["active"]
      | DragOverEvent["active"]
      | DragEndEvent["active"],
  ) {
    if (!activeItem || !over) {
      return null;
    }

    const pointerCenter =
      dragCursorRef.current ?? dragPointerCenterRef.current ?? getActiveRectCenter(active);

    if (!pointerCenter || isPointerInsideScrollbarGutter()) {
      return null;
    }

    const overType = over.data.current?.type;

    if (activeItem.type === "folder" && overType === "folder-row") {
      const folderId = over.data.current?.folderId;

      if (typeof folderId !== "number" || folderId === activeItem.folderId) {
        return null;
      }

      return {
        kind: "folder",
        folderId,
        side:
          pointerCenter.y < over.rect.top + over.rect.height / 2
            ? "before"
            : "after",
      } satisfies TreeDropIndicator;
    }

    if (activeItem.type === "folder" && overType === "folder-insert") {
      const folderId = over.data.current?.folderId;
      const side = over.data.current?.side;

      if (
        typeof folderId !== "number" ||
        folderId === activeItem.folderId ||
        (side !== "before" && side !== "after")
      ) {
        return null;
      }

      return {
        kind: "folder",
        folderId,
        side,
      } satisfies TreeDropIndicator;
    }

    if (activeItem.type !== "note") {
      return null;
    }

    if (overType === "empty-folder") {
      const folderId = over.data.current?.folderId;

      if (typeof folderId !== "number") {
        return null;
      }

      return {
        kind: "folder-empty",
        folderId,
      } satisfies TreeDropIndicator;
    }

    if (overType === "note-insert") {
      const noteId = over.data.current?.noteId;
      const folderId = over.data.current?.folderId;
      const side = over.data.current?.side;

      if (
        typeof noteId !== "number" ||
        typeof folderId !== "number" ||
        noteId === activeItem.noteId ||
        (side !== "before" && side !== "after")
      ) {
        return null;
      }

      return {
        kind: "note",
        noteId,
        folderId,
        side,
      } satisfies TreeDropIndicator;
    }

    if (overType !== "note-row") {
      return null;
    }

    const noteId = over.data.current?.noteId;
    const folderId = over.data.current?.folderId;

    if (
      typeof noteId !== "number" ||
      typeof folderId !== "number" ||
      noteId === activeItem.noteId
    ) {
      return null;
    }

    return {
      kind: "note",
      noteId,
      folderId,
      side:
        pointerCenter.y < over.rect.top + over.rect.height / 2
          ? "before"
          : "after",
    } satisfies TreeDropIndicator;
  }

  function syncFolderExpandFromOver(activeItem: TreeDragItem | null, over: TreeOverTarget) {
    if (activeItem?.type !== "note") {
      clearPendingExpand();
      return;
    }

    if (over?.data.current?.type !== "folder-row") {
      clearPendingExpand();
      return;
    }

    const folderId = over.data.current?.folderId;

    if (typeof folderId !== "number") {
      clearPendingExpand();
      return;
    }

    scheduleFolderExpand(folderId);
  }

  function refreshDragFeedback() {
    if (performance.now() - lastDragOverAtRef.current < 48) {
      return;
    }

    const activeItem = activeDragItemRef.current;
    const target = resolvePointerDropTarget(activeItem);

    if (activeItem?.type === "note" && target?.type === "folder-row") {
      scheduleFolderExpand(target.folderId);
    } else {
      clearPendingExpand();
    }

    setDropIndicator(resolveDropIndicatorFromPointer(activeItem));
  }

  function scheduleFolderExpand(folderId: number) {
    if (expandedFolderIds.has(folderId) || pendingExpandFolderIdRef.current === folderId) {
      return;
    }

    clearPendingExpand();
    pendingExpandFolderIdRef.current = folderId;
    pendingExpandTimerRef.current = window.setTimeout(() => {
      setExpandedFolderIds((current) => {
        if (current.has(folderId)) {
          return current;
        }

        const next = new Set(current);
        next.add(folderId);
        return next;
      });
      pendingExpandFolderIdRef.current = null;
      pendingExpandTimerRef.current = null;
    }, 420);
  }

  function buildNoteMoveTarget(indicator: TreeDropIndicator, activeNoteId: number) {
    if (indicator.kind === "folder-empty") {
      return {
        targetFolderId: indicator.folderId,
        targetIndex: 0,
      };
    }

    if (indicator.kind !== "note") {
      return null;
    }

    const activeNote = noteById.get(activeNoteId);
    if (!activeNote) {
      return null;
    }

    const targetNotes = notesByFolder.get(indicator.folderId) ?? [];
    const insertionNotes =
      activeNote.folderId === indicator.folderId
        ? targetNotes.filter((note) => note.id !== activeNoteId)
        : targetNotes;
    const overIndex = insertionNotes.findIndex((note) => note.id === indicator.noteId);

    if (overIndex === -1) {
      return null;
    }

    return {
      targetFolderId: indicator.folderId,
      targetIndex: indicator.side === "after" ? overIndex + 1 : overIndex,
    };
  }

  function getDragItemFromActive(
    active:
      | DragStartEvent["active"]
      | DragMoveEvent["active"]
      | DragOverEvent["active"]
      | DragEndEvent["active"],
  ) {
    if (active.data.current?.type === "folder-row") {
      const folderId = active.data.current.folderId;

      if (typeof folderId === "number") {
        return {
          type: "folder",
          folderId,
        } satisfies TreeDragItem;
      }
    }

    if (active.data.current?.type === "note-row") {
      const noteId = active.data.current.noteId;
      const folderId = active.data.current.folderId;

      if (typeof noteId === "number") {
        return {
          type: "note",
          noteId,
          folderId: typeof folderId === "number" ? folderId : null,
        } satisfies TreeDragItem;
      }
    }

    return null;
  }

  function handleDragStart(event: DragStartEvent) {
    preDragExpandedFolderIdsRef.current = new Set(expandedFolderIds);
    setContextMenu(null);
    setDropIndicator(null);
    lastDragOverAtRef.current = 0;

    const dragItem = getDragItemFromActive(event.active);

    if (!dragItem) {
      updateDragPointer(event.active);
      return;
    }

    activeDragItemRef.current = dragItem;
    setActiveDragItem(dragItem);

    if (dragItem.type === "folder") {
      onSelectEntity({ kind: "folder", id: dragItem.folderId });
    } else {
      onSelectEntity({ kind: "note", id: dragItem.noteId });
    }

    updateDragPointer(event.active);
  }

  function handleDragMove(event: DragMoveEvent) {
    updateDragPointer(event.active);
  }

  function handleDragOver(event: DragOverEvent) {
    updateDragPointer(event.active);
    const activeItem = activeDragItemRef.current;
    lastDragOverAtRef.current = performance.now();
    syncFolderExpandFromOver(activeItem, event.over);
    setDropIndicator(resolveDropIndicatorFromOver(activeItem, event.over, event.active));
  }

  async function handleDragEnd(event: DragEndEvent) {
    const dragItem = getDragItemFromActive(event.active);
    const indicator =
      resolveDropIndicatorFromOver(dragItem, event.over, event.active) ??
      resolveDropIndicatorFromPointer(dragItem) ??
      dropIndicator;
    const preserveExpandedFolderIds = new Set<number>();

    try {
      if (event.active.data.current?.type === "folder-row" && indicator?.kind === "folder") {
        const activeFolderId = event.active.data.current.folderId;

        if (typeof activeFolderId !== "number") {
          finishVisualDragState();
          restoreExpandedFolders();
          return;
        }

        const currentFolderIds = folders.map((folder) => folder.id);
        const nextFolderIds = reorderLinearIds(
          currentFolderIds,
          activeFolderId,
          indicator.folderId,
          indicator.side,
        );

        const hasChanged = nextFolderIds.some(
          (folderId, index) => folderId !== currentFolderIds[index],
        );

        if (hasChanged) {
          const persistPromise = onReorderFolders(nextFolderIds);
          finishVisualDragState();
          await persistPromise;
        } else {
          finishVisualDragState();
        }

        restoreExpandedFolders();
        return;
      }

      if (event.active.data.current?.type === "note-row" && indicator !== null) {
        const activeNoteId = event.active.data.current.noteId;

        if (typeof activeNoteId !== "number") {
          finishVisualDragState();
          restoreExpandedFolders();
          return;
        }

        const moveTarget = buildNoteMoveTarget(indicator, activeNoteId);

        if (!moveTarget) {
          finishVisualDragState();
          restoreExpandedFolders();
          return;
        }

        const activeNote = noteById.get(activeNoteId);
        if (
          activeNote?.folderId === moveTarget.targetFolderId &&
          activeNote.sortOrder === moveTarget.targetIndex
        ) {
          finishVisualDragState();
          restoreExpandedFolders();
          return;
        }

        preserveExpandedFolderIds.add(moveTarget.targetFolderId);
        setExpandedFolderIds((current) => {
          if (current.has(moveTarget.targetFolderId)) {
            return current;
          }

          const next = new Set(current);
          next.add(moveTarget.targetFolderId);
          return next;
        });
        const persistPromise = onMoveNote(
          activeNoteId,
          moveTarget.targetFolderId,
          moveTarget.targetIndex,
        );
        finishVisualDragState();
        await persistPromise;
        restoreExpandedFolders(preserveExpandedFolderIds);
        return;
      }
    } catch {
      finishVisualDragState();
      restoreExpandedFolders();
      return;
    }

    finishVisualDragState();
    restoreExpandedFolders();
  }

  const contextMenuFolder =
    contextMenu?.kind === "folder"
      ? folders.find((folder) => folder.id === contextMenu.id) ?? null
      : null;
  const contextMenuNote =
    contextMenu?.kind === "note"
      ? notes.find((note) => note.id === contextMenu.id) ?? null
      : null;
  const contextMenuX = contextMenu?.x ?? 0;
  const contextMenuY = contextMenu?.y ?? 0;
  const dragPreviewFolderName =
    activeDragItem?.type === "folder"
      ? folderById.get(activeDragItem.folderId)?.name ?? null
      : null;
  const dragPreviewNoteTitle =
    activeDragItem?.type === "note"
      ? noteById.get(activeDragItem.noteId)?.title ?? null
      : null;

  return (
    <section className={styles.detailSidebar}>
      <header className={styles.treeHeader}>
        <div className={styles.treeHeaderTop}>
          <button
            type="button"
            className={styles.treeBackButton}
            onClick={onReturnHome}
            onPointerDown={() => setContextMenu(null)}
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
              void handleCreateFolderClick();
            }}
            disabled={disabled || notebook === null}
          >
            新建文件夹
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => {
              void handleCreateNoteClick();
            }}
            disabled={disabled || notebook === null}
          >
            新建文件
          </button>
        </div>
      </header>

      <div
        ref={treeBodyRef}
        className={styles.treeBody}
        data-tree-dragging={activeDragItem ? "true" : "false"}
      >
        {!notebook ? (
          <div className={styles.treeEmpty}>请选择一个笔记本后继续。</div>
        ) : folders.length === 0 ? (
          <div className={styles.treeEmpty}>
            当前笔记本还没有内容。先创建一个文件夹，再在里面建立文件。
          </div>
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
            onDragCancel={() => {
              finishVisualDragState();
              restoreExpandedFolders();
            }}
            onDragEnd={(event) => {
              void handleDragEnd(event);
            }}
          >
            <ul className={styles.treeList}>
              {folders.map((folder, folderIndex) => {
                const folderNotes = notesByFolder.get(folder.id) ?? [];
                const isExpanded = expandedFolderIds.has(folder.id);
                const isActive =
                  selectedEntity?.kind === "folder" && selectedEntity.id === folder.id;
                const isEditing =
                  renameState?.kind === "folder" && renameState.id === folder.id;
                const emptyDropActive =
                  activeDragItem?.type === "note" &&
                  folderNotes.length === 0 &&
                  dropIndicator?.kind === "folder-empty" &&
                  dropIndicator.folderId === folder.id;
                const isLastFolder = folderIndex === folders.length - 1;

                return (
                  <li key={folder.id} className={styles.treeListItem}>
                    <TreeInsertionBand
                      droppableId={`tree-folder-insert-before-${folder.id}`}
                      dropType="folder-insert"
                      folderId={folder.id}
                      side="before"
                      position="before"
                    />
                    <TreeFolderRow
                      folder={folder}
                      noteCount={folderNotes.length}
                      isExpanded={isExpanded}
                      isActive={isActive}
                      isEditing={isEditing}
                      disabled={disabled}
                      dragEnabled={dragEnabled && !isEditing}
                      isDragging={
                        activeDragItem?.type === "folder" &&
                        activeDragItem.folderId === folder.id
                      }
                      dropIndicatorSide={
                        dropIndicator?.kind === "folder" &&
                        dropIndicator.folderId === folder.id
                          ? dropIndicator.side
                          : null
                      }
                      renameValue={renameState?.value ?? ""}
                      onRenameValueChange={updateRenameValue}
                      onSubmitRename={submitRename}
                      onCancelRename={cancelRename}
                      onSelectFolder={() => {
                        if (shouldSuppressSelection()) {
                          return;
                        }

                        setContextMenu(null);
                        onSelectEntity({ kind: "folder", id: folder.id });
                      }}
                      onToggleFolder={() => toggleFolder(folder.id)}
                      onOpenContextMenu={(event) => {
                        event.preventDefault();
                        openContextMenu(
                          { kind: "folder", value: folder },
                          { x: event.clientX, y: event.clientY },
                        );
                      }}
                      onStartRename={() =>
                        startRename("folder", folder.id, folder.name)
                      }
                    />

                    {isExpanded ? (
                      folderNotes.length > 0 ? (
                        <ul className={styles.treeNoteList}>
                          {folderNotes.map((note, noteIndex) => {
                            const isNoteActive =
                              selectedEntity?.kind === "note" &&
                              selectedEntity.id === note.id;
                            const isNoteEditing =
                              renameState?.kind === "note" && renameState.id === note.id;
                            const isLastNote = noteIndex === folderNotes.length - 1;

                            return (
                              <li key={note.id} className={styles.treeListItem}>
                                <TreeInsertionBand
                                  droppableId={`tree-note-insert-before-${note.id}`}
                                  dropType="note-insert"
                                  folderId={folder.id}
                                  noteId={note.id}
                                  side="before"
                                  position="before"
                                />
                                <TreeNoteRow
                                  note={note}
                                  isActive={isNoteActive}
                                  isEditing={isNoteEditing}
                                  disabled={disabled}
                                  dragEnabled={dragEnabled && !isNoteEditing}
                                  isDragging={
                                    activeDragItem?.type === "note" &&
                                    activeDragItem.noteId === note.id
                                  }
                                  dropIndicatorSide={
                                    dropIndicator?.kind === "note" &&
                                    dropIndicator.noteId === note.id
                                      ? dropIndicator.side
                                      : null
                                  }
                                  renameValue={renameState?.value ?? ""}
                                  onRenameValueChange={updateRenameValue}
                                  onSubmitRename={submitRename}
                                  onCancelRename={cancelRename}
                                  onSelectNote={() => {
                                    if (shouldSuppressSelection()) {
                                      return;
                                    }

                                    setContextMenu(null);
                                    onSelectEntity({ kind: "note", id: note.id });
                                  }}
                                  onOpenContextMenu={(event) => {
                                    event.preventDefault();
                                    openContextMenu(
                                      { kind: "note", value: note },
                                      { x: event.clientX, y: event.clientY },
                                    );
                                  }}
                                  onStartRename={() =>
                                    startRename("note", note.id, note.title)
                                  }
                                />
                                {isLastNote ? (
                                  <TreeInsertionBand
                                    droppableId={`tree-note-insert-after-${note.id}`}
                                    dropType="note-insert"
                                    folderId={folder.id}
                                    noteId={note.id}
                                    side="after"
                                    position="after"
                                  />
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : activeDragItem?.type === "note" ? (
                        <EmptyFolderDropZone
                          folderId={folder.id}
                          active={emptyDropActive}
                        />
                      ) : (
                        <div className={styles.treeEmpty}>这个文件夹还没有文件。</div>
                      )
                    ) : null}
                    {isLastFolder ? (
                      <TreeInsertionBand
                        droppableId={`tree-folder-insert-after-${folder.id}`}
                        dropType="folder-insert"
                        folderId={folder.id}
                        side="after"
                        position="after"
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <DragOverlay>
              {activeDragItem ? (
                <TreeDragPreview
                  item={activeDragItem}
                  folderName={dragPreviewFolderName}
                  noteTitle={dragPreviewNoteTitle}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>
      {contextMenuFolder ? (
        <ItemActionMenu
          x={contextMenuX}
          y={contextMenuY}
          onClose={() => setContextMenu(null)}
          onRename={() =>
            startRename("folder", contextMenuFolder.id, contextMenuFolder.name)
          }
          onDelete={() => onRequestDeleteFolder(contextMenuFolder)}
        />
      ) : null}
      {contextMenuNote ? (
        <ItemActionMenu
          x={contextMenuX}
          y={contextMenuY}
          onClose={() => setContextMenu(null)}
          onRename={() =>
            startRename("note", contextMenuNote.id, contextMenuNote.title)
          }
          onDelete={() => onRequestDeleteNote(contextMenuNote)}
        />
      ) : null}
    </section>
  );
}

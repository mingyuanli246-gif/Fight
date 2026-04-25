import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { Folder, Notebook } from "./types";
import styles from "./NotebookWorkspaceShell.module.css";

const VIEWPORT_MARGIN = 12;
const SUBMENU_GAP = 6;
const SUBMENU_WIDTH = 196;
const SUBMENU_CLOSE_DELAY_MS = 180;

type ItemActionMenuKind = "folder" | "note";

interface ItemActionMenuProps {
  kind: ItemActionMenuKind;
  x: number;
  y: number;
  notebooks?: Notebook[];
  folders?: Folder[];
  currentFolderId?: number | null;
  sourceNotebookId?: number | null;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onMoveToFolder?: (folder: Folder) => void;
  onMoveToNotebook?: (notebook: Notebook) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getRectPosition(rect: DOMRect | null) {
  if (!rect) {
    return null;
  }

  const maxTop = window.innerHeight - VIEWPORT_MARGIN;

  return {
    left: rect.left,
    right: rect.right,
    top: clamp(rect.top, VIEWPORT_MARGIN, maxTop),
  };
}

function getSubmenuPosition(anchorRect: DOMRect | null): CSSProperties {
  const anchor = getRectPosition(anchorRect);

  if (!anchor) {
    return {
      left: VIEWPORT_MARGIN,
      top: VIEWPORT_MARGIN,
      width: SUBMENU_WIDTH,
      maxHeight: window.innerHeight - VIEWPORT_MARGIN * 2,
    };
  }

  const canOpenRight =
    anchor.right + SUBMENU_GAP + SUBMENU_WIDTH <= window.innerWidth - VIEWPORT_MARGIN;
  const left = canOpenRight
    ? anchor.right + SUBMENU_GAP
    : Math.max(VIEWPORT_MARGIN, anchor.left - SUBMENU_GAP - SUBMENU_WIDTH);

  return {
    left,
    top: anchor.top,
    width: SUBMENU_WIDTH,
    maxHeight: window.innerHeight - VIEWPORT_MARGIN * 2,
  };
}

export function ItemActionMenu({
  kind,
  x,
  y,
  notebooks = [],
  folders = [],
  currentFolderId = null,
  sourceNotebookId = null,
  onClose,
  onRename,
  onDelete,
  onDuplicate,
  onMoveToFolder,
  onMoveToNotebook,
}: ItemActionMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const notebookSubmenuRef = useRef<HTMLDivElement | null>(null);
  const folderSubmenuRef = useRef<HTMLDivElement | null>(null);
  const closeSubmenuTimerRef = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [moveAnchorRect, setMoveAnchorRect] = useState<DOMRect | null>(null);
  const [activeNotebookId, setActiveNotebookId] = useState<number | null>(null);
  const [folderAnchorRect, setFolderAnchorRect] = useState<DOMRect | null>(null);

  const foldersByNotebook = useMemo(() => {
    const grouped = new Map<number, Folder[]>();

    for (const folder of folders) {
      const current = grouped.get(folder.notebookId) ?? [];
      current.push(folder);
      grouped.set(folder.notebookId, current);
    }

    return grouped;
  }, [folders]);
  const activeNotebookFolders =
    activeNotebookId === null ? [] : foldersByNotebook.get(activeNotebookId) ?? [];
  const canMove = kind === "note" ? Boolean(onMoveToFolder) : Boolean(onMoveToNotebook);
  const isMoveMenuOpen = moveAnchorRect !== null;

  useLayoutEffect(() => {
    const menu = menuRef.current;

    if (!menu) {
      return;
    }

    const rect = menu.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
  }, [kind, x, y]);

  useEffect(() => {
    function containsMenuTarget(target: Node | null) {
      return (
        menuRef.current?.contains(target) ||
        notebookSubmenuRef.current?.contains(target) ||
        folderSubmenuRef.current?.contains(target)
      );
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;

      if (containsMenuTarget(target)) {
        return;
      }

      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    function handleScroll() {
      onClose();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleScroll, true);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (closeSubmenuTimerRef.current !== null) {
        window.clearTimeout(closeSubmenuTimerRef.current);
      }
    };
  }, []);

  const position = useMemo(() => {
    const maxLeft = Math.max(
      VIEWPORT_MARGIN,
      window.innerWidth - size.width - VIEWPORT_MARGIN,
    );
    const maxTop = Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight - size.height - VIEWPORT_MARGIN,
    );

    return {
      left: Math.min(Math.max(x, VIEWPORT_MARGIN), maxLeft),
      top: Math.min(Math.max(y, VIEWPORT_MARGIN), maxTop),
    };
  }, [size.height, size.width, x, y]);

  function cancelSubmenuClose() {
    if (closeSubmenuTimerRef.current !== null) {
      window.clearTimeout(closeSubmenuTimerRef.current);
      closeSubmenuTimerRef.current = null;
    }
  }

  function scheduleSubmenuClose() {
    cancelSubmenuClose();
    closeSubmenuTimerRef.current = window.setTimeout(() => {
      setMoveAnchorRect(null);
      setActiveNotebookId(null);
      setFolderAnchorRect(null);
      closeSubmenuTimerRef.current = null;
    }, SUBMENU_CLOSE_DELAY_MS);
  }

  function openMoveMenu(anchor: HTMLElement) {
    cancelSubmenuClose();
    setMoveAnchorRect(anchor.getBoundingClientRect());
  }

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <>
      <div
        ref={menuRef}
        className={styles.contextMenu}
        style={position}
        role="menu"
        aria-label="项目操作菜单"
      >
        <button
          type="button"
          className={styles.contextMenuButton}
          role="menuitem"
          onClick={() => {
            onRename();
            onClose();
          }}
        >
          重命名
        </button>
        {kind === "note" ? (
          <>
            <button
              type="button"
              className={styles.contextMenuButton}
              role="menuitem"
              onClick={() => {
                onDuplicate?.();
                onClose();
              }}
              disabled={!onDuplicate}
            >
              复制
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={`${styles.contextMenuButton} ${styles.contextMenuButtonWithArrow}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={isMoveMenuOpen}
          onPointerEnter={(event) => openMoveMenu(event.currentTarget)}
          onPointerLeave={scheduleSubmenuClose}
          onFocus={(event) => openMoveMenu(event.currentTarget)}
          disabled={!canMove}
        >
          <span>移到</span>
          <span className={styles.contextMenuArrow} aria-hidden="true">
            ›
          </span>
        </button>
        <button
          type="button"
          className={`${styles.contextMenuButton} ${styles.contextMenuButtonDanger}`}
          role="menuitem"
          onClick={() => {
            onDelete();
            onClose();
          }}
        >
          删除
        </button>
      </div>

      {isMoveMenuOpen ? (
        <div
          ref={notebookSubmenuRef}
          className={`${styles.contextMenu} ${styles.contextSubmenu}`}
          style={getSubmenuPosition(moveAnchorRect)}
          role="menu"
          aria-label="选择笔记本"
          onPointerMove={(event) => {
            const target = event.target as HTMLElement | null;
            const notebookButton = target?.closest<HTMLButtonElement>(
              "[data-notebook-menu-item='true']",
            );

            if (notebookButton?.disabled) {
              setActiveNotebookId(null);
              setFolderAnchorRect(null);
            }
          }}
          onPointerEnter={cancelSubmenuClose}
          onPointerLeave={scheduleSubmenuClose}
        >
          {notebooks.map((notebook) => {
            const notebookFolders = foldersByNotebook.get(notebook.id) ?? [];
            const isDisabled =
              kind === "note"
                ? notebookFolders.length === 0
                : notebook.id === sourceNotebookId;

            return (
              <button
                key={notebook.id}
                type="button"
                className={`${styles.contextMenuButton} ${
                  kind === "note" ? styles.contextMenuButtonWithArrow : ""
                }`}
                role="menuitem"
                aria-disabled={isDisabled}
                data-disabled={isDisabled ? "true" : undefined}
                data-notebook-menu-item="true"
                tabIndex={isDisabled ? -1 : 0}
                disabled={isDisabled}
                onPointerEnter={(event) => {
                  cancelSubmenuClose();
                  if (isDisabled || kind === "folder") {
                    setActiveNotebookId(null);
                    setFolderAnchorRect(null);
                    return;
                  }

                  setActiveNotebookId(notebook.id);
                  setFolderAnchorRect(event.currentTarget.getBoundingClientRect());
                }}
                onClick={(event) => {
                  if (isDisabled) {
                    event.preventDefault();
                    return;
                  }

                  if (kind === "folder") {
                    onMoveToNotebook?.(notebook);
                    onClose();
                  }
                }}
                onFocus={(event) => {
                  if (isDisabled || kind === "folder") {
                    setActiveNotebookId(null);
                    setFolderAnchorRect(null);
                    return;
                  }

                  setActiveNotebookId(notebook.id);
                  setFolderAnchorRect(event.currentTarget.getBoundingClientRect());
                }}
              >
                <span className={styles.contextMenuLabel}>{notebook.name}</span>
                {kind === "note" ? (
                  <span className={styles.contextMenuArrow} aria-hidden="true">
                    ›
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {kind === "note" && isMoveMenuOpen && activeNotebookId !== null ? (
        <div
          ref={folderSubmenuRef}
          className={`${styles.contextMenu} ${styles.contextSubmenu}`}
          style={getSubmenuPosition(folderAnchorRect)}
          role="menu"
          aria-label="选择目标文件夹"
          onPointerEnter={cancelSubmenuClose}
          onPointerLeave={scheduleSubmenuClose}
        >
          {activeNotebookFolders.map((folder) => {
            const isCurrentFolder = folder.id === currentFolderId;

            return (
              <button
                key={folder.id}
                type="button"
                className={styles.contextMenuButton}
                role="menuitem"
                disabled={isCurrentFolder}
                onClick={() => {
                  if (isCurrentFolder) {
                    return;
                  }

                  onMoveToFolder?.(folder);
                  onClose();
                }}
              >
                <span className={styles.contextMenuLabel}>{folder.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </>,
    document.body,
  );
}

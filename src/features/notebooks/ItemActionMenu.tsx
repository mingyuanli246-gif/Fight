import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import styles from "./NotebookWorkspaceShell.module.css";

const VIEWPORT_MARGIN = 12;

interface ItemActionMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function ItemActionMenu({
  x,
  y,
  onClose,
  onRename,
  onDelete,
}: ItemActionMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const menu = menuRef.current;

    if (!menu) {
      return;
    }

    const rect = menu.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
  }, [x, y]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;

      if (menuRef.current?.contains(target)) {
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

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
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
    </div>,
    document.body,
  );
}

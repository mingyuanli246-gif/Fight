import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ManagedResourceImage } from "./ManagedResourceImage";
import { ClockIcon, FileTextIcon, MoreIcon } from "./NotebookUiIcons";
import {
  formatNotebookUpdatedLabel,
  type NotebookCoverTheme,
} from "./notebookHomePresentation";
import type { Notebook } from "./types";
import styles from "./NotebookWorkspaceShell.module.css";

function getNotebookCoverFallbackStyle(coverImageSrc: string): CSSProperties {
  return {
    backgroundColor: "#f4f6fb",
    backgroundImage: `url(${coverImageSrc})`,
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    backgroundSize: "cover",
  };
}

function NotebookCoverArtwork({
  notebook,
  coverImageSrc,
}: {
  notebook: Notebook;
  coverImageSrc: string;
}) {
  if (notebook.coverImagePath) {
    return (
      <ManagedResourceImage
        resourcePath={notebook.coverImagePath}
        alt={`${notebook.name} 封面`}
        imageClassName={styles.notebookCoverImage}
        fallbackClassName={styles.notebookCoverFallback}
        loadingClassName={styles.notebookCoverFallback}
        fallbackTitle=""
        fallbackMessage=""
        fallbackStyle={getNotebookCoverFallbackStyle(coverImageSrc)}
      />
    );
  }

  return (
    <img
      className={styles.notebookCoverImage}
      src={coverImageSrc}
      alt={`${notebook.name} 封面`}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}

interface NotebookCardProps {
  notebook: Notebook;
  coverTheme: NotebookCoverTheme;
  coverImageSrc: string;
  noteCount: number;
  isEditing: boolean;
  disabled: boolean;
  menuDisabled: boolean;
  dragEnabled: boolean;
  isDragging: boolean;
  dropIndicatorSide: "before" | "after" | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onStartRename: (notebook: Notebook) => void;
  onOpenNotebook: (notebookId: number) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onOpenActionMenu: (notebookId: number, anchorRect: DOMRect) => void;
  shouldSuppressNotebookOpen: () => boolean;
}

function NotebookCardComponent({
  notebook,
  coverTheme,
  coverImageSrc,
  noteCount,
  isEditing,
  disabled,
  menuDisabled,
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
  onOpenActionMenu,
  shouldSuppressNotebookOpen,
}: NotebookCardProps) {
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
  const updatedLabel = formatNotebookUpdatedLabel(notebook.updatedAt);
  const shouldShowRibbon = notebook.coverImagePath === null;
  const ribbonStyle = {
    "--notebook-ribbon-color": coverTheme.accent,
  } as CSSProperties;

  function handleOpenNotebook() {
    if (disabled || isEditing || shouldSuppressNotebookOpen()) {
      return;
    }

    onOpenNotebook(notebook.id);
  }

  return (
    <article
      ref={setNodeRef}
      className={`${styles.notebookCard} ${isDragging ? styles.notebookCardDragging : ""} ${
        dropIndicatorSide === "before" ? styles.notebookCardDropBefore : ""
      } ${dropIndicatorSide === "after" ? styles.notebookCardDropAfter : ""}`}
      onClick={handleOpenNotebook}
      onContextMenu={onOpenContextMenu}
      {...attributes}
      {...listeners}
    >
      <div className={styles.notebookCover}>
        <NotebookCoverArtwork notebook={notebook} coverImageSrc={coverImageSrc} />
        {shouldShowRibbon ? (
          <span
            className={styles.notebookCoverRibbon}
            style={ribbonStyle}
            aria-hidden="true"
          />
        ) : null}
      </div>

      <div className={styles.notebookCardInfo}>
        <div className={styles.notebookCardNameRow}>
          {isEditing ? (
            <div className={styles.inlineNameEditor}>
              <input
                type="text"
                className={`${styles.inlineNameInput} ${styles.inlineNameInputCard}`}
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
              onClick={(event) => {
                event.stopPropagation();

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
              onDoubleClick={(event) => {
                event.stopPropagation();

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
        <div className={styles.notebookInfoStack}>
          <div className={styles.notebookStatRow}>
            <FileTextIcon className={styles.inlineMetaIcon} />
            <span>{noteCount} 条笔记</span>
          </div>
          <div className={styles.notebookStatRow}>
            <ClockIcon className={styles.inlineMetaIcon} />
            <span>{updatedLabel}</span>
          </div>
        </div>
        <div className={styles.notebookMenuRow}>
          <button
            type="button"
            className={styles.notebookMenuButton}
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
            <MoreIcon className={styles.cardActionIcon} />
          </button>
        </div>
      </div>
    </article>
  );
}

export const NotebookCard = memo(NotebookCardComponent, (previousProps, nextProps) => {
  return (
    previousProps.notebook === nextProps.notebook &&
    previousProps.coverTheme.key === nextProps.coverTheme.key &&
    previousProps.coverImageSrc === nextProps.coverImageSrc &&
    previousProps.noteCount === nextProps.noteCount &&
    previousProps.isEditing === nextProps.isEditing &&
    previousProps.disabled === nextProps.disabled &&
    previousProps.menuDisabled === nextProps.menuDisabled &&
    previousProps.dragEnabled === nextProps.dragEnabled &&
    previousProps.isDragging === nextProps.isDragging &&
    previousProps.dropIndicatorSide === nextProps.dropIndicatorSide &&
    previousProps.renameValue === nextProps.renameValue
  );
});

export function NotebookDragPreview({
  notebook,
  coverTheme,
  coverImageSrc,
  noteCount,
}: {
  notebook: Notebook;
  coverTheme: NotebookCoverTheme;
  coverImageSrc: string;
  noteCount: number;
}) {
  const shouldShowRibbon = notebook.coverImagePath === null;

  return (
    <article
      className={`${styles.notebookCard} ${styles.notebookCardOverlay}`}
      data-drag-overlay="true"
    >
      <div className={styles.notebookCover}>
        <NotebookCoverArtwork notebook={notebook} coverImageSrc={coverImageSrc} />
        {shouldShowRibbon ? (
          <span
            className={styles.notebookCoverRibbon}
            style={{ "--notebook-ribbon-color": coverTheme.accent } as CSSProperties}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className={styles.notebookCardInfo}>
        <div className={styles.notebookCardNameRow}>
          <h4 className={styles.notebookCardName}>{notebook.name}</h4>
        </div>
        <div className={styles.notebookInfoStack}>
          <div className={styles.notebookStatRow}>
            <FileTextIcon className={styles.inlineMetaIcon} />
            <span>{noteCount} 条笔记</span>
          </div>
          <div className={styles.notebookStatRow}>
            <ClockIcon className={styles.inlineMetaIcon} />
            <span>{formatNotebookUpdatedLabel(notebook.updatedAt)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

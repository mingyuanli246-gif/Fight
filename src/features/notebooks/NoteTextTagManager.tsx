import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { listTagsWithCounts } from "./repository";
import type { NoteEditorPaneRef } from "./NoteEditorPane";
import { normalizeTagColor } from "./tagColors";
import type {
  TagWithCount,
  TextTagInspectionState,
  TextTagSelectionState,
} from "./types";
import styles from "./NoteTextTagManager.module.css";

interface NoteTextTagManagerProps {
  noteEditorRef: RefObject<NoteEditorPaneRef | null>;
  selectionState: TextTagSelectionState;
  inspectionState: TextTagInspectionState;
  disabled: boolean;
  onError: (message: string) => void;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "标签操作失败，请稍后重试。";
}

function handleTagActionMouseDown(event: ReactMouseEvent) {
  event.preventDefault();
}

export function NoteTextTagManager({
  noteEditorRef,
  selectionState,
  inspectionState,
  disabled,
  onError,
}: NoteTextTagManagerProps) {
  const [tagCatalog, setTagCatalog] = useState<TagWithCount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;
    setIsLoading(true);
    setCatalogError(null);

    void (async () => {
      try {
        const nextCatalog = await listTagsWithCounts();

        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTagCatalog(nextCatalog);
      } catch (error) {
        if (requestVersion === requestVersionRef.current) {
          setTagCatalog([]);
          setCatalogError(getErrorMessage(error));
        }
      } finally {
        if (requestVersion === requestVersionRef.current) {
          setIsLoading(false);
        }
      }
    })();
  }, []);

  const resolvedSelectionTag = useMemo(() => {
    if (
      selectionState.activeTagId === null ||
      selectionState.activeColorSnapshot === null
    ) {
      return null;
    }

    const matchedTag =
      tagCatalog.find((tag) => tag.id === selectionState.activeTagId) ?? null;

    if (matchedTag) {
      return {
        id: matchedTag.id,
        name: matchedTag.name,
        color: normalizeTagColor(matchedTag.color),
        available: true,
      };
    }

    return {
      id: selectionState.activeTagId,
      name: `标签 #${selectionState.activeTagId}`,
      color: normalizeTagColor(selectionState.activeColorSnapshot),
      available: false,
    };
  }, [selectionState, tagCatalog]);

  const resolvedInspectionTag = useMemo(() => {
    const activeOccurrence = inspectionState.activeOccurrence;

    if (!activeOccurrence) {
      return null;
    }

    const matchedTag =
      tagCatalog.find((tag) => tag.id === activeOccurrence.tagId) ?? null;

    if (matchedTag) {
      return {
        id: matchedTag.id,
        name: matchedTag.name,
        color: normalizeTagColor(matchedTag.color),
        available: true,
      };
    }

    return {
      id: activeOccurrence.tagId,
      name: `标签 #${activeOccurrence.tagId}`,
      color: normalizeTagColor(activeOccurrence.colorSnapshot),
      available: false,
    };
  }, [inspectionState, tagCatalog]);

  async function handleApplyTag(tagId: number, colorSnapshot: string) {
    if (disabled || isBusy) {
      return;
    }

    setIsBusy(true);

    try {
      const didApply = noteEditorRef.current?.applyTextTag(tagId, colorSnapshot);

      if (!didApply) {
        throw new Error("当前选区暂不支持打标签。");
      }
    } catch (error) {
      onError(getErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleClearTag() {
    if (disabled || isBusy) {
      return;
    }

    setIsBusy(true);

    try {
      const didClear = noteEditorRef.current?.clearTextTag();

      if (!didClear) {
        throw new Error("当前选区没有可清除的标签。");
      }
    } catch (error) {
      onError(getErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  const hasInspectionTarget =
    !selectionState.hasSelection && inspectionState.activeOccurrence !== null;

  const canApplyTag =
    !disabled &&
    !isBusy &&
    !isLoading &&
    ((selectionState.isTaggableSelection &&
      !selectionState.hasMixedOrInvalidSelection) ||
      hasInspectionTarget);
  const canClearTag =
    !disabled &&
    !isBusy &&
    ((selectionState.isTaggableSelection &&
      selectionState.activeTagId !== null &&
      !selectionState.hasMixedOrInvalidSelection) ||
      hasInspectionTarget);

  return (
    <section className={styles.manager}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>正文标签</p>
          <h4 className={styles.title}>给当前选中内容打标签</h4>
        </div>
      </div>

      {selectionState.hasSelection ? (
        !selectionState.isTaggableSelection ||
        selectionState.hasMixedOrInvalidSelection ? (
          <p className={styles.warningText}>
            当前选区包含不同标签状态或不支持的内容，请只选中同一段普通文字后再操作。
          </p>
        ) : (
          <>
            {selectionState.activeTagId !== null &&
            !selectionState.hasMixedOrInvalidSelection ? (
              <div className={styles.activeTagRow}>
                <span
                  className={styles.inspectTagChip}
                  style={{
                    color:
                      resolvedSelectionTag?.color ??
                      selectionState.activeColorSnapshot ??
                      "#8E8E93",
                    borderColor: `${
                      resolvedSelectionTag?.color ??
                      selectionState.activeColorSnapshot ??
                      "#8E8E93"
                    }40`,
                    backgroundColor: `${
                      resolvedSelectionTag?.color ??
                      selectionState.activeColorSnapshot ??
                      "#8E8E93"
                    }18`,
                  }}
                >
                  当前标签：{resolvedSelectionTag?.name ?? `标签 #${selectionState.activeTagId}`}
                </span>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onMouseDown={handleTagActionMouseDown}
                  onClick={() => {
                    void handleClearTag();
                  }}
                  disabled={!canClearTag}
                >
                  清除标签
                </button>
              </div>
            ) : (
              <p className={styles.stateText}>
                当前选区还没有标签。点击下面任一标签即可应用。
              </p>
            )}

            {selectionState.activeTagId !== null &&
            resolvedSelectionTag &&
            !resolvedSelectionTag.available ? (
              <p className={styles.warningText}>
                当前选区命中的标签已不在标签目录中，仍可清除；若要替换，请从现有目录里重新选择标签。
              </p>
            ) : null}

            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                <p className={styles.sectionLabel}>全部标签</p>
              </div>
              {isLoading ? (
                <p className={styles.stateText}>正在读取标签目录…</p>
              ) : catalogError ? (
                <p className={styles.warningText}>标签目录读取失败：{catalogError}</p>
              ) : tagCatalog.length === 0 ? (
                <p className={styles.stateText}>
                  标签目录为空，请先到标签广场创建标签。
                </p>
              ) : (
                <div className={styles.catalog}>
                  {tagCatalog.map((tag) => {
                    const normalizedColor = normalizeTagColor(tag.color);
                    const isActive = selectionState.activeTagId === tag.id;

                    return (
                      <button
                        key={tag.id}
                        type="button"
                        className={`${styles.tagButton} ${
                          isActive ? styles.tagButtonActive : ""
                        }`}
                        style={{
                          color: normalizedColor,
                          borderColor: isActive
                            ? `${normalizedColor}55`
                            : `${normalizedColor}38`,
                          backgroundColor: isActive
                            ? `${normalizedColor}1F`
                            : `${normalizedColor}12`,
                        }}
                        onClick={() => {
                          void handleApplyTag(tag.id, normalizedColor);
                        }}
                        onMouseDown={handleTagActionMouseDown}
                        disabled={!canApplyTag}
                      >
                        <span
                          className={styles.tagDot}
                          style={{ backgroundColor: normalizedColor }}
                        />
                        <span className={styles.tagName}>{tag.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )
      ) : hasInspectionTarget ? (
        <>
          <div className={styles.activeTagRow}>
            <span
              className={styles.inspectTagChip}
              style={{
                color: resolvedInspectionTag?.color ?? "#8E8E93",
                borderColor: `${resolvedInspectionTag?.color ?? "#8E8E93"}40`,
                backgroundColor: `${resolvedInspectionTag?.color ?? "#8E8E93"}18`,
              }}
            >
              当前标签：{resolvedInspectionTag?.name ?? `标签 #${inspectionState.activeOccurrence?.tagId ?? ""}`}
            </span>
            <button
              type="button"
              className={styles.secondaryButton}
              onMouseDown={handleTagActionMouseDown}
              onClick={() => {
                void handleClearTag();
              }}
              disabled={!canClearTag}
            >
              清除标签
            </button>
          </div>

          <p className={styles.stateText}>
            已激活这段标签文字。点击下面任一标签可直接替换，或清除当前标签。
          </p>

          {resolvedInspectionTag && !resolvedInspectionTag.available ? (
            <p className={styles.warningText}>
              当前激活的标签已不在标签目录中，仍可清除；若要替换，请从现有目录里重新选择标签。
            </p>
          ) : null}

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <p className={styles.sectionLabel}>全部标签</p>
            </div>
            {isLoading ? (
              <p className={styles.stateText}>正在读取标签目录…</p>
            ) : catalogError ? (
              <p className={styles.warningText}>标签目录读取失败：{catalogError}</p>
            ) : tagCatalog.length === 0 ? (
              <p className={styles.stateText}>
                标签目录为空，请先到标签广场创建标签。
              </p>
            ) : (
              <div className={styles.catalog}>
                {tagCatalog.map((tag) => {
                  const normalizedColor = normalizeTagColor(tag.color);
                  const isActive = inspectionState.activeOccurrence?.tagId === tag.id;

                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className={`${styles.tagButton} ${
                        isActive ? styles.tagButtonActive : ""
                      }`}
                      style={{
                        color: normalizedColor,
                        borderColor: isActive
                          ? `${normalizedColor}55`
                          : `${normalizedColor}38`,
                        backgroundColor: isActive
                          ? `${normalizedColor}1F`
                          : `${normalizedColor}12`,
                      }}
                      onClick={() => {
                        void handleApplyTag(tag.id, normalizedColor);
                      }}
                      onMouseDown={handleTagActionMouseDown}
                      disabled={!canApplyTag}
                    >
                      <span
                        className={styles.tagDot}
                        style={{ backgroundColor: normalizedColor }}
                      />
                      <span className={styles.tagName}>{tag.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </>
      ) : (
        <p className={styles.stateText}>选中文字后可添加标签。</p>
      )}
    </section>
  );
}

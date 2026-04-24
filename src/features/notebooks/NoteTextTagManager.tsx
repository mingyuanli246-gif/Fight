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
  LiveTextTagOccurrence,
  TagWithCount,
  TextTagInspectionState,
  TextTagSelectionState,
} from "./types";
import styles from "./NoteTextTagManager.module.css";

interface NoteTextTagManagerProps {
  noteEditorRef: RefObject<NoteEditorPaneRef | null>;
  selectionState: TextTagSelectionState;
  inspectionState: TextTagInspectionState;
  liveOccurrences: LiveTextTagOccurrence[];
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
  liveOccurrences,
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
      if (hasInspectionTarget) {
        const didFlush = await noteEditorRef.current?.flushPendingSave();

        if (!didFlush) {
          throw new Error("当前批注保存失败，请稍后重试。");
        }
      }

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
  const isDefaultState =
    !selectionState.hasSelection && inspectionState.activeOccurrence === null;

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

  const currentNoteTags = useMemo(() => {
    const tagCatalogById = new Map(tagCatalog.map((tag) => [tag.id, tag]));
    const dedupedTags = new Map<
      number,
      {
        id: number;
        name: string;
        color: string;
      }
    >();

    for (const occurrence of liveOccurrences) {
      if (dedupedTags.has(occurrence.tagId)) {
        continue;
      }

      const matchedTag = tagCatalogById.get(occurrence.tagId);
      dedupedTags.set(occurrence.tagId, {
        id: occurrence.tagId,
        name: matchedTag?.name ?? `标签 #${occurrence.tagId}`,
        color: normalizeTagColor(matchedTag?.color ?? occurrence.colorSnapshot),
      });
    }

    return Array.from(dedupedTags.values()).sort((left, right) =>
      left.name.localeCompare(right.name, "zh-CN"),
    );
  }, [liveOccurrences, tagCatalog]);

  const headerTitle = selectionState.hasSelection
    ? "添加标签"
    : hasInspectionTarget
      ? "替换标签"
      : "当前文件已有标签";

  return (
    <section className={styles.manager} data-text-tag-manager="true">
      <div className={styles.header}>
        <div>
          <p className={styles.label}>正文标签</p>
          <h4 className={styles.title}>{headerTitle}</h4>
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
      ) : isDefaultState ? (
        currentNoteTags.length === 0 ? (
          <p className={styles.stateText}>当前文件暂无正文标签</p>
        ) : (
          <ul className={styles.indexList}>
            {currentNoteTags.map((tag) => (
              <li key={tag.id} className={styles.indexItem}>
                <span
                  className={`${styles.tagButton} ${styles.indexChip}`}
                  style={{
                    color: tag.color,
                    borderColor: `${tag.color}38`,
                    backgroundColor: `${tag.color}12`,
                  }}
                >
                  <span
                    className={styles.tagDot}
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className={styles.tagName}>{tag.name}</span>
                </span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className={styles.stateText}>当前状态暂不支持标签操作。</p>
      )}
    </section>
  );
}

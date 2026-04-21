import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { listTagsWithCounts } from "./repository";
import { readRecentTextTagIds, rememberRecentTextTagId } from "./textTagRecent";
import type { NoteEditorPaneRef } from "./NoteEditorPane";
import type {
  LiveTextTagOccurrence,
  TagWithCount,
  TextTagPanelState,
} from "./types";
import styles from "./NoteTextTagManager.module.css";

interface NoteTextTagManagerProps {
  noteEditorRef: RefObject<NoteEditorPaneRef | null>;
  panelState: TextTagPanelState;
  disabled: boolean;
  onError: (message: string) => void;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "标签操作失败，请稍后重试。";
}

function resolveOccurrenceTag(
  occurrence: LiveTextTagOccurrence | null,
  tagCatalog: TagWithCount[],
) {
  if (!occurrence) {
    return null;
  }

  const matchedTag = tagCatalog.find((tag) => tag.id === occurrence.tagId) ?? null;

  if (matchedTag) {
    return {
      id: matchedTag.id,
      name: matchedTag.name,
      color: matchedTag.color,
      available: true,
    };
  }

  return {
    id: occurrence.tagId,
    name: `标签 #${occurrence.tagId}`,
    color: occurrence.colorSnapshot,
    available: false,
  };
}

function groupOccurrencesByTag(
  occurrences: LiveTextTagOccurrence[],
  tagCatalog: TagWithCount[],
) {
  const grouped = new Map<
    number,
    {
      id: number;
      name: string;
      color: string;
      available: boolean;
      items: LiveTextTagOccurrence[];
    }
  >();

  for (const occurrence of occurrences) {
    const existingGroup = grouped.get(occurrence.tagId);

    if (existingGroup) {
      existingGroup.items.push(occurrence);
      continue;
    }

    const resolvedTag = resolveOccurrenceTag(occurrence, tagCatalog);

    grouped.set(occurrence.tagId, {
      id: occurrence.tagId,
      name: resolvedTag?.name ?? `标签 #${occurrence.tagId}`,
      color: resolvedTag?.color ?? occurrence.colorSnapshot,
      available: resolvedTag?.available ?? false,
      items: [occurrence],
    });
  }

  return Array.from(grouped.values()).sort((left, right) => {
    if (left.items[0]?.sortOrder !== right.items[0]?.sortOrder) {
      return (left.items[0]?.sortOrder ?? 0) - (right.items[0]?.sortOrder ?? 0);
    }

    return left.id - right.id;
  });
}

export function NoteTextTagManager({
  noteEditorRef,
  panelState,
  disabled,
  onError,
}: NoteTextTagManagerProps) {
  const [tagCatalog, setTagCatalog] = useState<TagWithCount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [recentTagIds, setRecentTagIds] = useState<number[]>(() => readRecentTextTagIds());
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

  const recentTags = useMemo(() => {
    const tagById = new Map(tagCatalog.map((tag) => [tag.id, tag]));
    return recentTagIds
      .map((tagId) => tagById.get(tagId) ?? null)
      .filter((tag): tag is TagWithCount => tag !== null);
  }, [recentTagIds, tagCatalog]);

  const allTags = useMemo(() => tagCatalog, [tagCatalog]);
  const resolvedActiveTag = useMemo(
    () => resolveOccurrenceTag(panelState.activeOccurrence, tagCatalog),
    [panelState.activeOccurrence, tagCatalog],
  );
  const resolvedSelectionTag = useMemo(() => {
    if (
      panelState.selection.activeTagId === null ||
      panelState.selection.activeColorSnapshot === null
    ) {
      return null;
    }

    const matchedTag =
      tagCatalog.find((tag) => tag.id === panelState.selection.activeTagId) ?? null;

    if (matchedTag) {
      return {
        id: matchedTag.id,
        name: matchedTag.name,
        color: matchedTag.color,
        available: true,
      };
    }

    return {
      id: panelState.selection.activeTagId,
      name: `标签 #${panelState.selection.activeTagId}`,
      color: panelState.selection.activeColorSnapshot,
      available: false,
    };
  }, [panelState.selection, tagCatalog]);
  const occurrenceGroups = useMemo(
    () => groupOccurrencesByTag(panelState.occurrences, tagCatalog),
    [panelState.occurrences, tagCatalog],
  );

  async function handleApplyTag(tagId: number, colorSnapshot: string) {
    if (disabled || isBusy) {
      return;
    }

    setIsBusy(true);

    try {
      const didApply = noteEditorRef.current?.applyTextTag(tagId, colorSnapshot);

      if (!didApply) {
        throw new Error("当前上下文暂不支持打标签。");
      }

      rememberRecentTextTagId(tagId);
      setRecentTagIds(readRecentTextTagIds());
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
        throw new Error("当前上下文没有可清除的标签。");
      }
    } catch (error) {
      onError(getErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleFocusOccurrence(occurrenceKey: string) {
    if (disabled || isBusy) {
      return;
    }

    const didScroll = noteEditorRef.current?.scrollToTextTagOccurrence(occurrenceKey);

    if (!didScroll) {
      onError("定位该标记失败，请稍后重试。");
    }
  }

  const canApplyTag =
    !disabled &&
    !isBusy &&
    !isLoading &&
    (panelState.mode === "apply" || panelState.mode === "inspect") &&
    (panelState.mode === "inspect" || panelState.selection.isTaggableSelection);

  const canClearTag =
    !disabled &&
    !isBusy &&
    (
      (panelState.mode === "apply" &&
        panelState.selection.isTaggableSelection &&
        panelState.selection.activeTagId !== null &&
        !panelState.selection.hasMixedOrInvalidSelection) ||
      (panelState.mode === "inspect" && panelState.activeOccurrence !== null)
    );

  const renderTagButtons = (tags: TagWithCount[]) => {
    if (tags.length === 0) {
      return <p className={styles.stateText}>暂无可展示的标签。</p>;
    }

    return (
      <div className={styles.catalog}>
        {tags.map((tag) => {
          const isActive =
            panelState.mode === "inspect"
              ? panelState.activeOccurrence?.tagId === tag.id
              : panelState.selection.activeTagId === tag.id;

          return (
            <button
              key={tag.id}
              type="button"
              className={`${styles.tagButton} ${
                isActive ? styles.tagButtonActive : ""
              }`}
              style={{
                color: tag.color,
                borderColor: isActive ? `${tag.color}55` : `${tag.color}38`,
                backgroundColor: isActive ? `${tag.color}1F` : `${tag.color}12`,
              }}
              onClick={() => {
                void handleApplyTag(tag.id, tag.color);
              }}
              disabled={!canApplyTag}
            >
              <span
                className={styles.tagDot}
                style={{ backgroundColor: tag.color }}
              />
              <span className={styles.tagName}>{tag.name}</span>
            </button>
          );
        })}
      </div>
    );
  };

  const renderRecentSection = () => {
    if (panelState.mode === "index") {
      return null;
    }

    return (
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <p className={styles.sectionLabel}>最近使用标签</p>
        </div>
        {recentTags.length > 0 ? (
          renderTagButtons(recentTags)
        ) : (
          <p className={styles.stateText}>最近还没有使用过标签。</p>
        )}
      </section>
    );
  };

  const renderCatalogSection = () => {
    if (panelState.mode === "index") {
      return null;
    }

    return (
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <p className={styles.sectionLabel}>全部标签</p>
        </div>
        {isLoading ? (
          <p className={styles.stateText}>正在读取标签目录…</p>
        ) : catalogError ? (
          <p className={styles.warningText}>标签目录读取失败：{catalogError}</p>
        ) : allTags.length === 0 ? (
          <p className={styles.stateText}>标签目录为空，请先到标签广场创建标签。</p>
        ) : (
          renderTagButtons(allTags)
        )}
      </section>
    );
  };

  const renderApplyMode = () => (
    <>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>正文标签</p>
          <h4 className={styles.title}>给当前选中内容打标签</h4>
        </div>
      </div>

      {!panelState.selection.isTaggableSelection ? (
        <p className={styles.warningText}>
          当前选区不是单个普通文字片段，暂不支持直接打标签。请改为同一文本块内的普通文字选区。
        </p>
      ) : panelState.selection.activeTagId !== null &&
        !panelState.selection.hasMixedOrInvalidSelection ? (
        <div className={styles.activeTagRow}>
          <span
            className={styles.inspectTagChip}
            style={{
              color: resolvedSelectionTag?.color ?? panelState.selection.activeColorSnapshot ?? "#8E8E93",
              borderColor: `${
                resolvedSelectionTag?.color ?? panelState.selection.activeColorSnapshot ?? "#8E8E93"
              }40`,
              backgroundColor: `${
                resolvedSelectionTag?.color ?? panelState.selection.activeColorSnapshot ?? "#8E8E93"
              }18`,
            }}
          >
            当前标签：{resolvedSelectionTag?.name ?? `标签 #${panelState.selection.activeTagId}`}
          </span>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => {
              void handleClearTag();
            }}
            disabled={!canClearTag}
          >
            清除标签
          </button>
        </div>
      ) : panelState.selection.hasMixedOrInvalidSelection ? (
        <p className={styles.warningText}>
          当前选区包含不同标签状态。继续应用新标签时，会统一替换为新标签。
        </p>
      ) : (
        <p className={styles.stateText}>
          当前选区还没有标签。点击下面任一标签即可应用。
        </p>
      )}

      {panelState.selection.activeTagId !== null && resolvedSelectionTag && !resolvedSelectionTag.available ? (
        <p className={styles.warningText}>
          当前选区命中的标签已不在标签目录中，仍可清除；若要替换，请从现有目录里重新选择标签。
        </p>
      ) : null}

      {renderRecentSection()}
      {renderCatalogSection()}
    </>
  );

  const renderInspectMode = () => (
    <>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>正文标签</p>
          <h4 className={styles.title}>当前标签检查器</h4>
        </div>
      </div>

      {panelState.activeOccurrence ? (
        <>
          <div className={styles.inspectCard}>
            <div className={styles.inspectRow}>
              <span
                className={styles.inspectTagChip}
                style={{
                  color: resolvedActiveTag?.color ?? panelState.activeOccurrence.colorSnapshot,
                  borderColor: `${
                    resolvedActiveTag?.color ?? panelState.activeOccurrence.colorSnapshot
                  }40`,
                  backgroundColor: `${
                    resolvedActiveTag?.color ?? panelState.activeOccurrence.colorSnapshot
                  }18`,
                }}
              >
                {resolvedActiveTag?.name ?? `标签 #${panelState.activeOccurrence.tagId}`}
              </span>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  void handleClearTag();
                }}
                disabled={!canClearTag}
              >
                清除标签
              </button>
            </div>

            <p className={styles.inspectSnippet}>
              {panelState.activeOccurrence.snippetText}
            </p>

            {!resolvedActiveTag?.available ? (
              <p className={styles.warningText}>
                当前标签已不在标签目录中，仅保留正文快照信息。本阶段可查看与定位，但替换依赖现有目录标签。
              </p>
            ) : null}

            <div className={styles.inspectNavRow}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled
                title="Phase 3 仅预留接口，暂未实现跳转"
              >
                上一个同标签
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled
                title="Phase 3 仅预留接口，暂未实现跳转"
              >
                下一个同标签
              </button>
            </div>
          </div>

          {renderRecentSection()}
          {renderCatalogSection()}
        </>
      ) : (
        <p className={styles.stateText}>当前光标未命中有效标签。</p>
      )}
    </>
  );

  const renderIndexMode = () => (
    <>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>正文标签</p>
          <h4 className={styles.title}>当前文件标记概览</h4>
        </div>
      </div>

      {panelState.occurrences.length === 0 ? (
        <p className={styles.stateText}>
          当前文件还没有任何正文标记。选中一段普通文字后，可在右侧直接打标签。
        </p>
      ) : (
        <>
          {catalogError ? (
            <p className={styles.warningText}>
              标签目录读取失败，当前概览已按正文快照稳定降级展示：{catalogError}
            </p>
          ) : null}
          <div className={styles.summaryGrid}>
            <div className={styles.summaryCard}>
              <span className={styles.summaryValue}>{panelState.summary.totalCount}</span>
              <span className={styles.summaryLabel}>总标记数</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryValue}>
                {panelState.summary.distinctTagCount}
              </span>
              <span className={styles.summaryLabel}>标签种类数</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryValue}>{panelState.summary.textCount}</span>
              <span className={styles.summaryLabel}>文本标记数</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryValue}>{panelState.summary.formulaCount}</span>
              <span className={styles.summaryLabel}>公式标记数</span>
            </div>
          </div>

          {occurrenceGroups.map((group) => (
            <section key={group.id} className={styles.groupSection}>
              <div className={styles.groupHeader}>
                <div className={styles.groupTitleRow}>
                  <span
                    className={styles.groupColorDot}
                    style={{ backgroundColor: group.color }}
                  />
                  <p className={styles.groupTitle}>{group.name}</p>
                </div>
                {!group.available ? (
                  <span className={styles.groupMeta}>目录缺失，按正文快照展示</span>
                ) : null}
              </div>

              <div className={styles.occurrenceList}>
                {group.items.map((occurrence) => (
                  <button
                    key={occurrence.key}
                    type="button"
                    className={styles.occurrenceButton}
                    onClick={() => {
                      void handleFocusOccurrence(occurrence.key);
                    }}
                    disabled={disabled}
                  >
                    <span
                      className={styles.occurrenceAccent}
                      style={{ backgroundColor: group.color }}
                    />
                    <span className={styles.occurrenceText}>
                      {occurrence.snippetText}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );

  return (
    <section className={styles.manager}>
      {panelState.mode === "apply"
        ? renderApplyMode()
        : panelState.mode === "inspect"
          ? renderInspectMode()
          : renderIndexMode()}
    </section>
  );
}

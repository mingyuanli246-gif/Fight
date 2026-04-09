import { useEffect, useRef, useState } from "react";
import {
  createTag,
  deleteTag,
  listNotesByTag,
  listTagsWithCounts,
  renameTag,
} from "../notebooks/repository";
import type {
  NoteOpenTarget,
  TaggedNoteResult,
  TagWithCount,
} from "../notebooks/types";
import styles from "./TagPlazaWorkspace.module.css";

const SUGGESTED_TAGS = ["待巩固", "重点", "易错"];

interface TagPlazaWorkspaceProps {
  onOpenNote: (target: NoteOpenTarget) => void;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "标签操作失败，请稍后重试。";
}

function formatDate(value: string) {
  return new Date(value.replace(" ", "T")).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildPath(note: TaggedNoteResult) {
  return `${note.notebookName} / ${note.folderName ?? "未归类"}`;
}

export function TagPlazaWorkspace({ onOpenNote }: TagPlazaWorkspaceProps) {
  const [tags, setTags] = useState<TagWithCount[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const [taggedNotes, setTaggedNotes] = useState<TaggedNoteResult[]>([]);
  const [createValue, setCreateValue] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [isLoadingNotes, setIsLoadingNotes] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const requestVersionRef = useRef(0);

  const selectedTag =
    selectedTagId === null
      ? null
      : tags.find((tag) => tag.id === selectedTagId) ?? null;

  async function refreshTags(preferredTagId?: number | null) {
    const nextTags = await listTagsWithCounts();
    setTags(nextTags);

    const nextSelectedTagId =
      preferredTagId === undefined
        ? nextTags.some((tag) => tag.id === selectedTagId)
          ? selectedTagId
          : (nextTags[0]?.id ?? null)
        : preferredTagId !== null &&
            nextTags.some((tag) => tag.id === preferredTagId)
          ? preferredTagId
          : (nextTags[0]?.id ?? null);

    setSelectedTagId(nextSelectedTagId);
    setIsConfirmingDelete(false);
    return nextSelectedTagId;
  }

  useEffect(() => {
    void (async () => {
      setErrorMessage(null);
      setIsInitializing(true);

      try {
        await refreshTags();
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
        setTags([]);
        setSelectedTagId(null);
        setTaggedNotes([]);
      } finally {
        setIsInitializing(false);
      }
    })();
  }, []);

  useEffect(() => {
    setRenameValue(selectedTag?.name ?? "");
    setIsConfirmingDelete(false);
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;

    if (selectedTagId === null) {
      setTaggedNotes([]);
      setIsLoadingNotes(false);
      return;
    }

    setIsLoadingNotes(true);

    void (async () => {
      try {
        const nextNotes = await listNotesByTag(selectedTagId);

        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTaggedNotes(nextNotes);
      } catch (error) {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTaggedNotes([]);
        setErrorMessage(getErrorMessage(error));
      } finally {
        if (requestVersion === requestVersionRef.current) {
          setIsLoadingNotes(false);
        }
      }
    })();
  }, [selectedTag, selectedTagId]);

  async function runMutation(operation: () => Promise<void>) {
    setErrorMessage(null);
    setIsBusy(true);

    try {
      await operation();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
      throw error;
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreateTag(name: string) {
    return runMutation(async () => {
      const tag = await createTag(name);
      setCreateValue("");
      await refreshTags(tag.id);
    });
  }

  async function handleRenameTag() {
    if (selectedTagId === null) {
      return;
    }

    return runMutation(async () => {
      await renameTag(selectedTagId, renameValue);
      await refreshTags(selectedTagId);
    });
  }

  async function handleDeleteTag() {
    if (selectedTagId === null) {
      return;
    }

    return runMutation(async () => {
      await deleteTag(selectedTagId);
      await refreshTags(null);
    });
  }

  if (isInitializing) {
    return (
      <div className={styles.statusCard}>
        <strong className={styles.statusTitle}>正在读取标签广场</strong>
        <p className={styles.statusText}>正在连接标签表并载入关联文件。</p>
      </div>
    );
  }

  return (
    <>
      {errorMessage ? (
        <div className={styles.errorBanner}>
          <div>
            <p className={styles.errorTitle}>标签操作失败</p>
            <p className={styles.errorText}>{errorMessage}</p>
          </div>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setErrorMessage(null)}
          >
            关闭提示
          </button>
        </div>
      ) : null}

      <div className={styles.workspace}>
        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <div>
              <h3 className={styles.panelTitle}>标签列表</h3>
              <p className={styles.panelDescription}>
                创建、选择并管理当前阶段的 note 级标签。
              </p>
            </div>
          </header>

          <div className={styles.panelBody}>
            <div className={styles.form}>
              <input
                type="text"
                className={styles.input}
                value={createValue}
                onChange={(event) => setCreateValue(event.currentTarget.value)}
                placeholder="输入新标签名称"
                maxLength={40}
                disabled={isBusy}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleCreateTag(createValue).catch(() => undefined);
                  }
                }}
              />
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  void handleCreateTag(createValue).catch(() => undefined);
                }}
                disabled={isBusy}
              >
                创建标签
              </button>
            </div>

            {tags.length === 0 ? (
              <div className={styles.emptyBlock}>
                <p className={styles.emptyTitle}>还没有任何标签</p>
                <p className={styles.emptyText}>
                  你可以先创建常用标签，后续在文件正文区直接绑定到 note。
                </p>
                <div className={styles.suggestionList}>
                  {SUGGESTED_TAGS.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className={styles.suggestionChip}
                      onClick={() => {
                        void handleCreateTag(tag).catch(() => undefined);
                      }}
                      disabled={isBusy}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <ul className={styles.tagList}>
                {tags.map((tag) => (
                  <li key={tag.id}>
                    <button
                      type="button"
                      className={`${styles.tagItem} ${
                        selectedTagId === tag.id ? styles.tagItemActive : ""
                      }`}
                      onClick={() => {
                        setErrorMessage(null);
                        setIsConfirmingDelete(false);
                        setSelectedTagId(tag.id);
                      }}
                      disabled={isBusy}
                    >
                      <span
                        className={styles.tagDot}
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className={styles.tagItemText}>
                        <span className={styles.tagItemTitle}>{tag.name}</span>
                        <span className={styles.tagItemMeta}>
                          {tag.noteCount} 个文件
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {selectedTag ? (
              <section className={styles.actionCard}>
                <h4 className={styles.cardTitle}>当前标签管理</h4>
                <div className={styles.form}>
                  <input
                    type="text"
                    className={styles.input}
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.currentTarget.value)}
                    placeholder="输入新的标签名称"
                    maxLength={40}
                    disabled={isBusy}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void handleRenameTag().catch(() => undefined);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() => {
                      void handleRenameTag().catch(() => undefined);
                    }}
                    disabled={isBusy}
                  >
                    保存名称
                  </button>
                </div>

                {!isConfirmingDelete ? (
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => setIsConfirmingDelete(true)}
                    disabled={isBusy}
                  >
                    删除标签
                  </button>
                ) : (
                  <div className={styles.confirmBox}>
                    <p className={styles.confirmText}>
                      确认删除“{selectedTag.name}”吗？删除后不会影响文件本身。
                    </p>
                    <div className={styles.confirmActions}>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => setIsConfirmingDelete(false)}
                        disabled={isBusy}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className={styles.dangerButton}
                        onClick={() => {
                          void handleDeleteTag().catch(() => undefined);
                        }}
                        disabled={isBusy}
                      >
                        确认删除
                      </button>
                    </div>
                  </div>
                )}
              </section>
            ) : null}
          </div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <div>
              <h3 className={styles.panelTitle}>关联文件</h3>
              <p className={styles.panelDescription}>
                查看当前标签下的全部 note，并直接跳转打开。
              </p>
            </div>
          </header>

          <div className={styles.panelBody}>
            {selectedTag === null ? (
              <div className={styles.emptyBlock}>
                <p className={styles.emptyTitle}>先选择一个标签</p>
                <p className={styles.emptyText}>
                  创建并选中标签后，这里会显示关联的文件列表。
                </p>
              </div>
            ) : isLoadingNotes ? (
              <div className={styles.emptyBlock}>
                <p className={styles.emptyTitle}>正在读取关联文件…</p>
              </div>
            ) : taggedNotes.length === 0 ? (
              <div className={styles.emptyBlock}>
                <p className={styles.emptyTitle}>这个标签下还没有文件</p>
                <p className={styles.emptyText}>
                  你可以先回到笔记本，在文件正文区把这个标签绑定到具体 note。
                </p>
              </div>
            ) : (
              <ul className={styles.noteList}>
                {taggedNotes.map((note) => (
                  <li key={note.noteId}>
                    <button
                      type="button"
                      className={styles.noteItem}
                      onClick={() =>
                        onOpenNote({
                          noteId: note.noteId,
                          notebookId: note.notebookId,
                        })
                      }
                    >
                      <span className={styles.noteTitle}>{note.title}</span>
                      <span className={styles.notePath}>{buildPath(note)}</span>
                      <span className={styles.noteMeta}>
                        更新时间：{formatDate(note.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

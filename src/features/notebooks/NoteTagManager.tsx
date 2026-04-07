import { useEffect, useRef, useState } from "react";
import {
  addTagToNoteByName,
  listTagsByNote,
  removeTagFromNote,
} from "./repository";
import type { Tag } from "./types";
import styles from "./NoteTagManager.module.css";

interface NoteTagManagerProps {
  noteId: number;
  disabled: boolean;
  onError: (message: string) => void;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "标签操作失败，请稍后重试。";
}

export function NoteTagManager({
  noteId,
  disabled,
  onError,
}: NoteTagManagerProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const activeNoteIdRef = useRef(noteId);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    activeNoteIdRef.current = noteId;
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;
    setIsLoading(true);
    setTags([]);
    setInputValue("");

    void (async () => {
      try {
        const nextTags = await listTagsByNote(noteId);

        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTags(nextTags);
      } catch (error) {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTags([]);
        onError(getErrorMessage(error));
      } finally {
        if (requestVersion === requestVersionRef.current) {
          setIsLoading(false);
        }
      }
    })();
  }, [noteId, onError]);

  async function handleAddTag() {
    if (disabled || isBusy) {
      return;
    }

    const expectedNoteId = noteId;
    setIsBusy(true);

    try {
      const nextTags = await addTagToNoteByName(expectedNoteId, inputValue);

      if (activeNoteIdRef.current !== expectedNoteId) {
        return;
      }

      setTags(nextTags);
      setInputValue("");
    } catch (error) {
      if (activeNoteIdRef.current === expectedNoteId) {
        onError(getErrorMessage(error));
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRemoveTag(tagId: number) {
    if (disabled || isBusy) {
      return;
    }

    const expectedNoteId = noteId;
    setIsBusy(true);

    try {
      const nextTags = await removeTagFromNote(expectedNoteId, tagId);

      if (activeNoteIdRef.current !== expectedNoteId) {
        return;
      }

      setTags(nextTags);
    } catch (error) {
      if (activeNoteIdRef.current === expectedNoteId) {
        onError(getErrorMessage(error));
      }
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className={styles.manager}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>当前标签</p>
          <p className={styles.hint}>为当前文件添加分类或复习标签，支持回车快速提交。</p>
        </div>
      </div>

      {isLoading ? (
        <p className={styles.stateText}>正在读取标签…</p>
      ) : tags.length === 0 ? (
        <p className={styles.stateText}>这个文件还没有标签。</p>
      ) : (
        <div className={styles.tagList}>
          {tags.map((tag) => (
            <span
              key={tag.id}
              className={styles.tagChip}
              style={{
                color: tag.color,
                borderColor: `${tag.color}40`,
                backgroundColor: `${tag.color}18`,
              }}
            >
              <span className={styles.tagName}>{tag.name}</span>
              <button
                type="button"
                className={styles.removeButton}
                onClick={() => {
                  void handleRemoveTag(tag.id);
                }}
                disabled={disabled || isBusy}
                aria-label={`移除标签 ${tag.name}`}
              >
                移除
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={styles.form}>
        <input
          type="text"
          className={styles.input}
          value={inputValue}
          onChange={(event) => setInputValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleAddTag();
            }
          }}
          placeholder="输入标签名称后按 Enter"
          maxLength={40}
          disabled={disabled || isBusy}
        />
        <button
          type="button"
          className={styles.addButton}
          onClick={() => {
            void handleAddTag();
          }}
          disabled={disabled || isBusy}
        >
          添加标签
        </button>
      </div>
    </section>
  );
}

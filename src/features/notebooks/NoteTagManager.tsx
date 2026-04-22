import { useEffect, useMemo, useRef, useState } from "react";
import {
  addTagToNoteByName,
  listTagsWithCounts,
  listTagsByNote,
  removeTagFromNote,
} from "./repository";
import { normalizeTagColor } from "./tagColors";
import type { Tag, TagWithCount } from "./types";
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
  const [tagCatalog, setTagCatalog] = useState<TagWithCount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const activeNoteIdRef = useRef(noteId);
  const requestVersionRef = useRef(0);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const availableTags = useMemo(() => {
    const boundTagIds = new Set(tags.map((tag) => tag.id));
    return tagCatalog.filter((tag) => !boundTagIds.has(tag.id));
  }, [tagCatalog, tags]);

  useEffect(() => {
    activeNoteIdRef.current = noteId;
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;
    setIsLoading(true);
    setTags([]);
    setTagCatalog([]);
    setIsPickerOpen(false);

    void (async () => {
      try {
        const [nextTags, nextTagCatalog] = await Promise.all([
          listTagsByNote(noteId),
          listTagsWithCounts(),
        ]);

        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTags(nextTags);
        setTagCatalog(nextTagCatalog);
      } catch (error) {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTags([]);
        setTagCatalog([]);
        onError(getErrorMessage(error));
      } finally {
        if (requestVersion === requestVersionRef.current) {
          setIsLoading(false);
        }
      }
    })();
  }, [noteId, onError]);

  useEffect(() => {
    if (!isPickerOpen) {
      return;
    }

    function handleWindowPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;

      if (pickerRef.current?.contains(target)) {
        return;
      }

      setIsPickerOpen(false);
    }

    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsPickerOpen(false);
      }
    }

    window.addEventListener("pointerdown", handleWindowPointerDown);
    window.addEventListener("keydown", handleWindowKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handleWindowPointerDown);
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [isPickerOpen]);

  async function handleAddTag(tag: TagWithCount) {
    if (disabled || isBusy) {
      return;
    }

    const expectedNoteId = noteId;
    setIsBusy(true);

    try {
      const nextTags = await addTagToNoteByName(expectedNoteId, tag.name);

      if (activeNoteIdRef.current !== expectedNoteId) {
        return;
      }

      setTags(nextTags);
      setIsPickerOpen(false);
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

  function handleTogglePicker() {
    if (disabled || isBusy || isLoading || availableTags.length === 0) {
      return;
    }

    setIsPickerOpen((current) => !current);
  }

  return (
    <section className={styles.manager}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>当前标签</p>
        </div>
      </div>

      {isLoading ? (
        <p className={styles.stateText}>正在读取标签…</p>
      ) : tags.length === 0 ? (
        <p className={styles.stateText}>这个文件还没有标签。</p>
      ) : (
        <div className={styles.tagList}>
          {tags.map((tag) => {
            const normalizedColor = normalizeTagColor(tag.color);

            return (
              <span
                key={tag.id}
                className={styles.tagChip}
                style={{
                  color: normalizedColor,
                  borderColor: `${normalizedColor}40`,
                  backgroundColor: `${normalizedColor}18`,
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
            );
          })}
        </div>
      )}

      <div ref={pickerRef} className={styles.pickerArea}>
        <button
          type="button"
          className={styles.addTagTrigger}
          onClick={handleTogglePicker}
          disabled={disabled || isBusy || isLoading || availableTags.length === 0}
          aria-haspopup="menu"
          aria-expanded={isPickerOpen}
        >
          添加标签
        </button>

        {isPickerOpen ? (
          <div className={styles.tagPicker} role="menu" aria-label="可选标签">
            {availableTags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={styles.tagPickerItem}
                onClick={() => {
                  void handleAddTag(tag);
                }}
              >
                <span
                  className={styles.tagPickerDot}
                  style={{ backgroundColor: normalizeTagColor(tag.color) }}
                />
                <span className={styles.tagPickerName}>{tag.name}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

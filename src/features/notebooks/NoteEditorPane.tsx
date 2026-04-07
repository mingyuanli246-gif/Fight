import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import {
  EditorContent,
  useEditor,
  type Editor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { NoteTagManager } from "./NoteTagManager";
import { NoteReviewPlanManager } from "../review/NoteReviewPlanManager";
import { RichTextToolbar } from "./RichTextToolbar";
import { getNoteById, updateNoteContent } from "./repository";
import {
  normalizeEditorHtmlForStorage,
  toEditorDocumentContent,
  toEditorHtml,
} from "./richTextContent";
import type { Folder, Note, NoteSaveStatus, Notebook } from "./types";
import styles from "./NotebookWorkspace.module.css";

const AUTOSAVE_DELAY_MS = 800;
const SAVED_STATUS_DURATION_MS = 1500;

export interface NoteEditorPaneRef {
  flushPendingSave: () => Promise<boolean>;
  hasUnsavedChanges: () => boolean;
}

interface NoteEditorPaneProps {
  notebook: Notebook;
  note: Note;
  folders: Folder[];
  disabled: boolean;
  onRenameNote: (id: number, title: string) => Promise<void>;
  onDeleteNote: (id: number) => Promise<void>;
  onNoteUpdated: (note: Note) => void;
  onError: (message: string) => void;
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

function getSaveStatusLabel(status: NoteSaveStatus) {
  switch (status) {
    case "dirty":
      return "编辑中 / 待保存";
    case "saving":
      return "保存中";
    case "saved":
      return "已保存";
    case "error":
      return "保存失败";
    case "unchanged":
    default:
      return "未修改";
  }
}

export const NoteEditorPane = forwardRef<NoteEditorPaneRef, NoteEditorPaneProps>(
  function NoteEditorPane(
    {
      notebook,
      note,
      folders,
      disabled,
      onRenameNote,
      onDeleteNote,
      onNoteUpdated,
      onError,
    },
    ref,
  ) {
    const [renameValue, setRenameValue] = useState(note.title);
    const [draftContent, setDraftContent] = useState("");
    const [lastSavedContent, setLastSavedContent] = useState("");
    const [saveStatus, setSaveStatus] = useState<NoteSaveStatus>("unchanged");
    const [lastSavedAt, setLastSavedAt] = useState(note.updatedAt);
    const [isLoadingNote, setIsLoadingNote] = useState(true);
    const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

    const activeNoteIdRef = useRef(note.id);
    const pendingSaveTimerRef = useRef<number | null>(null);
    const savedStatusTimerRef = useRef<number | null>(null);
    const requestVersionRef = useRef(0);
    const draftContentRef = useRef("");
    const lastSavedContentRef = useRef("");
    const onNoteUpdatedRef = useRef(onNoteUpdated);
    const onErrorRef = useRef(onError);
    const ongoingSaveRef = useRef<Promise<boolean> | null>(null);
    const ongoingSaveContentRef = useRef<string | null>(null);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: {
            levels: [1, 2],
          },
        }),
        Underline,
        TextAlign.configure({
          types: ["heading", "paragraph"],
          alignments: ["center"],
        }),
      ],
      content: toEditorDocumentContent(note.contentPlaintext),
      immediatelyRender: false,
      autofocus: false,
      editorProps: {
        attributes: {
          class: styles.proseMirrorRoot,
        },
      },
      onUpdate({ editor: currentEditor }) {
        const normalizedHtml = normalizeEditorHtmlForStorage(
          currentEditor.getHTML(),
        );
        draftContentRef.current = normalizedHtml;
        setDraftContent(normalizedHtml);
      },
    });

    const noteFolder =
      note.folderId === null
        ? null
        : folders.find((folder) => folder.id === note.folderId) ?? null;

    const notePath =
      note.folderId === null
        ? `${notebook.name} / 未归档笔记`
        : `${notebook.name} / ${noteFolder?.name ?? "文件夹"}`;

    function setDraftState(value: string) {
      draftContentRef.current = value;
      setDraftContent(value);
    }

    function setLastSavedState(value: string) {
      lastSavedContentRef.current = value;
      setLastSavedContent(value);
    }

    function syncEditorContent(currentEditor: Editor | null, content: string) {
      if (!currentEditor) {
        return;
      }

      currentEditor.commands.setContent(toEditorDocumentContent(content), {
        emitUpdate: false,
      });
    }

    function clearPendingSaveTimer() {
      if (pendingSaveTimerRef.current !== null) {
        window.clearTimeout(pendingSaveTimerRef.current);
        pendingSaveTimerRef.current = null;
      }
    }

    function clearSavedStatusTimer() {
      if (savedStatusTimerRef.current !== null) {
        window.clearTimeout(savedStatusTimerRef.current);
        savedStatusTimerRef.current = null;
      }
    }

    function scheduleSavedReset() {
      clearSavedStatusTimer();
      savedStatusTimerRef.current = window.setTimeout(() => {
        if (activeNoteIdRef.current !== note.id) {
          return;
        }

        setSaveStatus("unchanged");
        savedStatusTimerRef.current = null;
      }, SAVED_STATUS_DURATION_MS);
    }

    async function executeSave(expectedNoteId: number, content: string) {
      try {
        const savedNote = await updateNoteContent(expectedNoteId, content);

        if (activeNoteIdRef.current !== expectedNoteId) {
          return false;
        }

        const savedContent = toEditorHtml(savedNote.contentPlaintext);
        setLastSavedState(savedContent);
        setLastSavedAt(savedNote.updatedAt);
        onNoteUpdatedRef.current(savedNote);

        if (draftContentRef.current === content) {
          setDraftState(savedContent);
          setSaveStatus("saved");
          scheduleSavedReset();
        } else {
          setSaveStatus("dirty");
        }

        return true;
      } catch (error) {
        if (activeNoteIdRef.current !== expectedNoteId) {
          return false;
        }

        setSaveStatus("error");
        onErrorRef.current(
          error instanceof Error ? error.message : "保存正文失败，请稍后重试。",
        );
        return false;
      }
    }

    async function performSave(expectedNoteId: number, content: string) {
      if (
        ongoingSaveRef.current !== null &&
        ongoingSaveContentRef.current === content &&
        activeNoteIdRef.current === expectedNoteId
      ) {
        return ongoingSaveRef.current;
      }

      clearPendingSaveTimer();
      clearSavedStatusTimer();

      const baseSave = ongoingSaveRef.current ?? Promise.resolve(true);
      const savePromise = baseSave.then(async () => {
        if (activeNoteIdRef.current !== expectedNoteId) {
          return false;
        }

        setSaveStatus("saving");
        return executeSave(expectedNoteId, content);
      });

      ongoingSaveRef.current = savePromise;
      ongoingSaveContentRef.current = content;

      try {
        return await savePromise;
      } finally {
        if (ongoingSaveRef.current === savePromise) {
          ongoingSaveRef.current = null;
          ongoingSaveContentRef.current = null;
        }
      }
    }

    async function flushPendingSave() {
      if (activeNoteIdRef.current !== note.id) {
        return true;
      }

      const currentDraft = draftContentRef.current;
      const currentLastSaved = lastSavedContentRef.current;

      if (currentDraft === currentLastSaved) {
        clearPendingSaveTimer();
        return true;
      }

      return performSave(note.id, currentDraft);
    }

    useImperativeHandle(
      ref,
      () => ({
        flushPendingSave,
        hasUnsavedChanges: () =>
          draftContentRef.current !== lastSavedContentRef.current,
      }),
      [note.id],
    );

    useEffect(() => {
      onNoteUpdatedRef.current = onNoteUpdated;
    }, [onNoteUpdated]);

    useEffect(() => {
      onErrorRef.current = onError;
    }, [onError]);

    useEffect(() => {
      if (!editor) {
        return;
      }

      editor.setEditable(!(disabled || isLoadingNote), false);
    }, [disabled, editor, isLoadingNote]);

    useEffect(() => {
      activeNoteIdRef.current = note.id;
      requestVersionRef.current += 1;
      const requestVersion = requestVersionRef.current;

      clearPendingSaveTimer();
      clearSavedStatusTimer();
      ongoingSaveRef.current = null;
      ongoingSaveContentRef.current = null;
      setIsLoadingNote(true);
      setSaveStatus("unchanged");
      setRenameValue(note.title);
      setIsConfirmingDelete(false);

      void (async () => {
        try {
          const loadedNote = await getNoteById(note.id);

          if (
            activeNoteIdRef.current !== note.id ||
            requestVersion !== requestVersionRef.current
          ) {
            return;
          }

          const normalizedContent = toEditorHtml(loadedNote.contentPlaintext);
          setDraftState(normalizedContent);
          setLastSavedState(normalizedContent);
          setLastSavedAt(loadedNote.updatedAt);
          setSaveStatus("unchanged");
          syncEditorContent(editor, normalizedContent);
          onNoteUpdatedRef.current(loadedNote);
        } catch (error) {
          if (
            activeNoteIdRef.current !== note.id ||
            requestVersion !== requestVersionRef.current
          ) {
            return;
          }

          setDraftState("");
          setLastSavedState("");
          setSaveStatus("error");
          syncEditorContent(editor, "");
          onErrorRef.current(
            error instanceof Error ? error.message : "读取文件正文失败，请稍后重试。",
          );
        } finally {
          if (
            activeNoteIdRef.current === note.id &&
            requestVersion === requestVersionRef.current
          ) {
            setIsLoadingNote(false);
          }
        }
      })();

      return () => {
        clearPendingSaveTimer();
        clearSavedStatusTimer();
      };
    }, [editor, note.id, note.title]);

    useEffect(() => {
      if (isLoadingNote) {
        return;
      }

      if (draftContent === lastSavedContent) {
        if (saveStatus === "dirty" || saveStatus === "error") {
          setSaveStatus("unchanged");
        }
        return;
      }

      clearSavedStatusTimer();

      if (saveStatus !== "saving") {
        setSaveStatus("dirty");
      }

      clearPendingSaveTimer();
      pendingSaveTimerRef.current = window.setTimeout(() => {
        void performSave(note.id, draftContentRef.current);
      }, AUTOSAVE_DELAY_MS);

      return () => {
        clearPendingSaveTimer();
      };
    }, [draftContent, isLoadingNote, lastSavedContent, note.id, saveStatus]);

    async function handleRename() {
      try {
        if (draftContentRef.current !== lastSavedContentRef.current) {
          const saved = await flushPendingSave();

          if (!saved) {
            onErrorRef.current(
              "当前笔记保存失败，请先重试保存或复制内容后再重命名。",
            );
            return;
          }
        }

        await onRenameNote(note.id, renameValue);
      } catch {
        // 错误由上层统一展示
      }
    }

    async function handleDelete() {
      try {
        await onDeleteNote(note.id);
      } catch {
        // 错误由上层统一展示
      }
    }

    return (
      <section className={styles.panel}>
        <header className={styles.panelHeader}>
          <div className={styles.editorHeader}>
            <p className={styles.infoLabel}>文件正文</p>
            <h3 className={styles.editorTitle}>{note.title}</h3>
            <p className={styles.editorPath}>{notePath}</p>
            <div
              className={`${styles.saveStatusBadge} ${
                saveStatus === "error"
                  ? styles.saveStatusError
                  : saveStatus === "saving"
                    ? styles.saveStatusSaving
                    : saveStatus === "saved"
                      ? styles.saveStatusSaved
                      : saveStatus === "dirty"
                        ? styles.saveStatusDirty
                        : ""
              }`}
            >
              {getSaveStatusLabel(saveStatus)}
            </div>
            <p className={styles.editorMeta}>
              最近更新时间：{formatDate(lastSavedAt)}
            </p>
          </div>
        </header>

        <div className={styles.editorBody}>
          <NoteTagManager
            noteId={note.id}
            disabled={disabled || isLoadingNote}
            onError={onError}
          />
          <NoteReviewPlanManager
            noteId={note.id}
            disabled={disabled || isLoadingNote}
            onError={onError}
          />

          <div className={styles.editorSurface}>
            <RichTextToolbar editor={editor} disabled={disabled || isLoadingNote} />
            <div className={styles.editorContent}>
              <EditorContent editor={editor} className={styles.editorCanvas} />
            </div>
          </div>

          <div className={styles.editorFooter}>
            <section className={styles.actionCard}>
              <h4 className={styles.cardTitle}>重命名</h4>
              <div className={styles.editorForm}>
                <input
                  className={styles.input}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.currentTarget.value)}
                  placeholder="输入新的名称"
                  maxLength={120}
                />
                <div className={styles.formActions}>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={handleRename}
                    disabled={disabled}
                  >
                    保存名称
                  </button>
                </div>
              </div>
            </section>

            <section className={styles.actionCard}>
              <h4 className={styles.cardTitle}>删除确认</h4>
              <p className={styles.cardText}>
                删除后，这个文件会从数据库中移除，当前阶段不提供恢复。
              </p>
              {!isConfirmingDelete ? (
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={() => setIsConfirmingDelete(true)}
                  disabled={disabled}
                >
                  删除当前项
                </button>
              ) : (
                <div className={styles.confirmBox}>
                  <p className={styles.confirmText}>确认删除当前文件吗？</p>
                  <div className={styles.formActions}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => setIsConfirmingDelete(false)}
                      disabled={disabled}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className={styles.dangerButton}
                      onClick={handleDelete}
                      disabled={disabled}
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </section>
    );
  },
);

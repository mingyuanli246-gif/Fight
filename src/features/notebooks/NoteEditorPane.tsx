import {
  EditorContent,
  useEditor,
  type Editor,
} from "@tiptap/react";
import { undoDepth } from "@tiptap/pm/history";
import {
  type CSSProperties,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { MathEditorDialog } from "./MathEditorDialog";
import { RichTextToolbar } from "./RichTextToolbar";
import {
  TextSizeDecreaseIcon,
  TextSizeIncreaseIcon,
  TrashIcon,
} from "./NotebookUiIcons";
import {
  insertNoteImage,
  insertBlockMath,
  insertInlineMath,
  updateMathNodeLatex,
} from "./editorCommands";
import {
  clearManagedResourceResolution,
  primeManagedResourceResolution,
} from "./editorResources";
import {
  deleteManagedResource,
  selectAndImportImage,
} from "./resourceCommands";
import { getNoteById, updateNoteContent } from "./repository";
import {
  normalizeEditorHtmlForStorage,
  toEditorDocumentContent,
  toEditorHtml,
} from "./richTextContent";
import {
  createNotebookEditorExtensions,
  NOTE_EDITOR_ENABLED_INPUT_RULES,
} from "./editorExtensions";
import {
  clearSearchHighlight,
  createSearchHighlightExtension,
  findHighlightRanges,
  setSearchHighlight,
} from "./searchHighlight";
import type { EditorMathBridge, MathEditRequest } from "./mathNodes";
import {
  getMathNodeName,
  type MathDisplayMode,
  type MathNodeName,
} from "./mathSerialization";
import type {
  Folder,
  Note,
  NoteSaveStatus,
  Notebook,
  NotebookHighlightRequest,
} from "./types";
import editorStyles from "./NoteEditorSurface.module.css";
import styles from "./NotebookWorkspace.module.css";

const AUTOSAVE_DELAY_MS = 800;
const SAVED_STATUS_DURATION_MS = 1500;
const SEARCH_HIGHLIGHT_DURATION_MS = 5000;
const EDITOR_FONT_SIZE_STORAGE_KEY_PREFIX = "notebooks.editor.font-size.note.";
const MIN_EDITOR_FONT_SIZE = 12;
const MAX_EDITOR_FONT_SIZE = 20;
const DEFAULT_EDITOR_FONT_SIZE = 16;
const LEGACY_DEFAULT_EDITOR_FONT_SIZE = 14;

export interface NoteEditorPaneRef {
  flushPendingSave: () => Promise<boolean>;
  hasUnsavedChanges: () => boolean;
}

interface NoteEditorPaneProps {
  notebook: Notebook;
  note: Note;
  folders: Folder[];
  disabled: boolean;
  highlightRequest?: NotebookHighlightRequest | null;
  onNoteUpdated: (note: Note) => void;
  onError: (message: string) => void;
}

interface MathDialogState {
  intent: "insert" | "edit";
  displayMode: MathDisplayMode;
  nodeType: MathNodeName;
  position: number | null;
}

interface FontSizeHistoryEntry {
  from: number;
  to: number;
  anchorUndoDepth: number;
}

interface EditorFontSizeState {
  noteId: number;
  fontSize: number;
}

function formatDate(value: string) {
  const normalized = value.trim();
  const isoLikeValue = normalized.includes("T")
    ? normalized
    : normalized.replace(" ", "T");
  const parsedDate = /(?:Z|[+-]\d{2}:\d{2})$/i.test(isoLikeValue)
    ? new Date(isoLikeValue)
    : new Date(`${isoLikeValue}Z`);

  if (Number.isNaN(parsedDate.getTime())) {
    return value;
  }

  return parsedDate.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
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

function clampEditorFontSize(value: number) {
  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, value));
}

function getEditorFontSizeStorageKey(noteId: number) {
  return `${EDITOR_FONT_SIZE_STORAGE_KEY_PREFIX}${noteId}`;
}

function getStoredEditorFontSize(noteId: number) {
  if (typeof window === "undefined") {
    return DEFAULT_EDITOR_FONT_SIZE;
  }

  const storedValue = Number.parseInt(
    window.localStorage.getItem(getEditorFontSizeStorageKey(noteId)) ?? "",
    10,
  );

  if (!Number.isFinite(storedValue)) {
    return DEFAULT_EDITOR_FONT_SIZE;
  }

  if (storedValue === LEGACY_DEFAULT_EDITOR_FONT_SIZE) {
    return DEFAULT_EDITOR_FONT_SIZE;
  }

  return clampEditorFontSize(storedValue);
}

export const NoteEditorPane = forwardRef<NoteEditorPaneRef, NoteEditorPaneProps>(
  function NoteEditorPane(
    {
      notebook,
      note,
      folders,
      disabled,
      highlightRequest = null,
      onNoteUpdated,
      onError,
    },
    ref,
  ) {
    const [draftContent, setDraftContent] = useState("");
    const [lastSavedContent, setLastSavedContent] = useState("");
    const [saveStatus, setSaveStatus] = useState<NoteSaveStatus>("unchanged");
    const [lastSavedAt, setLastSavedAt] = useState(note.updatedAt);
    const [isLoadingNote, setIsLoadingNote] = useState(true);
    const [editorSessionKey, setEditorSessionKey] = useState(0);
    const [editorSessionContent, setEditorSessionContent] = useState(() =>
      toEditorHtml(note.contentPlaintext),
    );
    const [editorFontState, setEditorFontState] = useState<EditorFontSizeState>(() => ({
      noteId: note.id,
      fontSize: getStoredEditorFontSize(note.id),
    }));
    const [fontUndoStack, setFontUndoStack] = useState<FontSizeHistoryEntry[]>([]);
    const [fontRedoStack, setFontRedoStack] = useState<FontSizeHistoryEntry[]>([]);
    const [mathDialogState, setMathDialogState] = useState<MathDialogState | null>(
      null,
    );
    const [mathDraftLatex, setMathDraftLatex] = useState("");
    const [mathDialogError, setMathDialogError] = useState<string | null>(null);

    const activeNoteIdRef = useRef(note.id);
    const pendingSaveTimerRef = useRef<number | null>(null);
    const savedStatusTimerRef = useRef<number | null>(null);
    const requestVersionRef = useRef(0);
    const draftContentRef = useRef("");
    const lastSavedContentRef = useRef("");
    const editorRef = useRef<Editor | null>(null);
    const onNoteUpdatedRef = useRef(onNoteUpdated);
    const onErrorRef = useRef(onError);
    const ongoingSaveRef = useRef<Promise<boolean> | null>(null);
    const ongoingSaveContentRef = useRef<string | null>(null);
    const highlightTimerRef = useRef<number | null>(null);
    const lastHandledHighlightRequestRef = useRef<number | null>(null);
    const mathBridgeRef = useRef<EditorMathBridge>({
      onEditMathRequest() {
        // 运行时由当前组件覆写。
      },
    });
    mathBridgeRef.current.onEditMathRequest = (request: MathEditRequest) => {
      setMathDialogState({
        intent: "edit",
        displayMode: request.displayMode,
        nodeType: request.nodeType,
        position: request.position,
      });
      setMathDraftLatex(request.latex);
      setMathDialogError(null);
    };
    mathBridgeRef.current.onMathRenderError = ({ nodeType, message, latex }) => {
      console.error(`[notebooks.math] ${nodeType}渲染失败`, {
        message,
        latex,
      });
    };
    const editorExtensionsRef = useRef(
      [
        ...createNotebookEditorExtensions({
          mathBridge: mathBridgeRef.current,
        }),
        createSearchHighlightExtension(editorStyles.searchHighlight),
      ],
    );
    const enabledInputRulesRef = useRef([...NOTE_EDITOR_ENABLED_INPUT_RULES]);

    const editor = useEditor({
      extensions: editorExtensionsRef.current,
      enableInputRules: enabledInputRulesRef.current,
      content: toEditorDocumentContent(editorSessionContent),
      immediatelyRender: false,
      autofocus: false,
      editorProps: {
        attributes: {
          class: editorStyles.proseMirrorRoot,
        },
      },
      onUpdate({ editor: currentEditor }) {
        const normalizedHtml = normalizeEditorHtmlForStorage(
          currentEditor.getHTML(),
        );
        draftContentRef.current = normalizedHtml;
        setDraftContent(normalizedHtml);
      },
    }, [editorSessionKey]);

    useEffect(() => {
      editorRef.current = editor;
    }, [editor]);

    const noteFolder =
      note.folderId === null
        ? null
        : folders.find((folder) => folder.id === note.folderId) ?? null;
    const editorFontSize =
      editorFontState.noteId === note.id
        ? editorFontState.fontSize
        : getStoredEditorFontSize(note.id);

    const notePath =
      note.folderId === null
        ? `${notebook.name} / 未归档笔记`
        : `${notebook.name} / ${noteFolder?.name ?? "文件夹"}`;
    const isDecreaseFontDisabled =
      editorFontSize <= MIN_EDITOR_FONT_SIZE;
    const isIncreaseFontDisabled =
      editorFontSize >= MAX_EDITOR_FONT_SIZE;
    const isClearContentDisabled =
      disabled || isLoadingNote || draftContent === "";
    const editorCanvasStyle = {
      "--editor-font-size": `${editorFontSize}px`,
    } as CSSProperties;

    function getEditorUndoDepth(currentEditor: Editor | null) {
      return currentEditor ? undoDepth(currentEditor.state) : 0;
    }

    function canUndoEditor(currentEditor: Editor | null) {
      return currentEditor?.can().chain().focus().undo().run() ?? false;
    }

    function canRedoEditor(currentEditor: Editor | null) {
      return currentEditor?.can().chain().focus().redo().run() ?? false;
    }

    function recordFontSizeChange(nextFontSize: number) {
      if (nextFontSize === editorFontSize) {
        return;
      }

      setFontUndoStack((currentStack) => [
        ...currentStack,
        {
          from: editorFontSize,
          to: nextFontSize,
          anchorUndoDepth: getEditorUndoDepth(editor),
        },
      ]);
      setFontRedoStack([]);
      setEditorFontState({
        noteId: note.id,
        fontSize: nextFontSize,
      });
    }

    function handleToolbarUndo() {
      const latestFontChange = fontUndoStack[fontUndoStack.length - 1];
      const currentUndoDepth = getEditorUndoDepth(editor);
      const shouldUndoEditorFirst =
        latestFontChange !== undefined &&
        canUndoEditor(editor) &&
        currentUndoDepth > latestFontChange.anchorUndoDepth;

      if (shouldUndoEditorFirst) {
        editor?.chain().focus().undo().run();
        return;
      }

      if (latestFontChange) {
        setEditorFontState({
          noteId: note.id,
          fontSize: latestFontChange.from,
        });
        setFontUndoStack((currentStack) => currentStack.slice(0, -1));
        setFontRedoStack((currentStack) => [...currentStack, latestFontChange]);
        return;
      }

      editor?.chain().focus().undo().run();
    }

    function handleToolbarRedo() {
      const latestFontChange = fontRedoStack[fontRedoStack.length - 1];
      const currentUndoDepth = getEditorUndoDepth(editor);
      const shouldRedoEditorFirst =
        latestFontChange !== undefined &&
        canRedoEditor(editor) &&
        currentUndoDepth < latestFontChange.anchorUndoDepth;

      if (shouldRedoEditorFirst) {
        editor?.chain().focus().redo().run();
        return;
      }

      if (latestFontChange) {
        setEditorFontState({
          noteId: note.id,
          fontSize: latestFontChange.to,
        });
        setFontRedoStack((currentStack) => currentStack.slice(0, -1));
        setFontUndoStack((currentStack) => [...currentStack, latestFontChange]);
        return;
      }

      editor?.chain().focus().redo().run();
    }

    function openMathInsertDialog(displayMode: MathDisplayMode) {
      setMathDialogState({
        intent: "insert",
        displayMode,
        nodeType: getMathNodeName(displayMode),
        position: null,
      });
      setMathDraftLatex("");
      setMathDialogError(null);
    }

    function closeMathDialog() {
      setMathDialogState(null);
      setMathDraftLatex("");
      setMathDialogError(null);
    }

    async function cleanupImportedResourceOnFailure(resourcePath: string) {
      clearManagedResourceResolution(resourcePath);

      try {
        await deleteManagedResource(resourcePath);
      } catch (error) {
        console.error("[notebooks.resources] 清理未引用图片失败", {
          resourcePath,
          error,
        });
      }
    }

    function setDraftState(value: string) {
      draftContentRef.current = value;
      setDraftContent(value);
    }

    function setLastSavedState(value: string) {
      lastSavedContentRef.current = value;
      setLastSavedContent(value);
    }

    function handleConfirmMathDialog() {
      if (!mathDialogState) {
        return;
      }

      const result =
        mathDialogState.intent === "insert"
          ? mathDialogState.displayMode === "inline"
            ? insertInlineMath(editor, mathDraftLatex)
            : insertBlockMath(editor, mathDraftLatex)
          : updateMathNodeLatex(editor, {
              position: mathDialogState.position ?? -1,
              nodeType: mathDialogState.nodeType,
              latex: mathDraftLatex,
            });

      if (result.status === "handled") {
        closeMathDialog();
        return;
      }

      setMathDialogError(result.message);
    }

    async function handleInsertImage() {
      try {
        const importResult = await selectAndImportImage("note-image");

        if (importResult.status === "cancelled") {
          return;
        }

        clearManagedResourceResolution(importResult.resourcePath);
        primeManagedResourceResolution(importResult);
        const insertResult = insertNoteImage(editor, {
          resourcePath: importResult.resourcePath,
          alt: "",
        });

        if (insertResult.status === "handled") {
          return;
        }

        await cleanupImportedResourceOnFailure(importResult.resourcePath);
        onErrorRef.current(insertResult.message);
      } catch (error) {
        onErrorRef.current(
          error instanceof Error ? error.message : "图片导入失败，请稍后重试。",
        );
      }
    }

    function handleClearEditorContent() {
      if (!editor || isLoadingNote || draftContentRef.current === "") {
        return;
      }

      clearHighlightTimer();
      clearSearchHighlight(editor);
      closeMathDialog();
      editor.chain().focus().clearContent().run();
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

    function clearHighlightTimer() {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
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

    function applySearchHighlight(request: NotebookHighlightRequest) {
      if (!editor) {
        return;
      }

      clearHighlightTimer();
      clearSearchHighlight(editor);

      const queryRanges = findHighlightRanges(editor.state.doc, request.query ?? "");
      const ranges =
        queryRanges.length > 0
          ? queryRanges
          : findHighlightRanges(editor.state.doc, request.excerpt ?? "");

      if (ranges.length === 0) {
        return;
      }

      setSearchHighlight(editor, ranges);

      window.requestAnimationFrame(() => {
        const matchElement = editor.view.dom.querySelector(
          `.${editorStyles.searchHighlight}`,
        );

        if (matchElement instanceof HTMLElement) {
          matchElement.scrollIntoView({
            block: "center",
            behavior: "smooth",
          });
        }
      });

      highlightTimerRef.current = window.setTimeout(() => {
        clearSearchHighlight(editor);
        highlightTimerRef.current = null;
      }, SEARCH_HIGHLIGHT_DURATION_MS);
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
      setLastSavedAt(note.updatedAt);
    }, [note.id, note.updatedAt]);

    useEffect(() => {
      if (!editor) {
        return;
      }

      editor.setEditable(!(disabled || isLoadingNote), false);
    }, [disabled, editor, isLoadingNote]);

    useEffect(() => {
      if (editorFontState.noteId !== note.id || typeof window === "undefined") {
        return;
      }

      window.localStorage.setItem(
        getEditorFontSizeStorageKey(note.id),
        String(editorFontState.fontSize),
      );
    }, [editorFontState, note.id]);

    useEffect(() => {
      activeNoteIdRef.current = note.id;
      requestVersionRef.current += 1;
      const requestVersion = requestVersionRef.current;
      const nextFontSize = getStoredEditorFontSize(note.id);

      clearPendingSaveTimer();
      clearSavedStatusTimer();
      clearHighlightTimer();
      clearSearchHighlight(editorRef.current);
      ongoingSaveRef.current = null;
      ongoingSaveContentRef.current = null;
      setFontUndoStack([]);
      setFontRedoStack([]);
      setEditorFontState({
        noteId: note.id,
        fontSize: nextFontSize,
      });
      setIsLoadingNote(true);
      setSaveStatus("unchanged");
      setMathDialogState(null);
      setMathDraftLatex("");
      setMathDialogError(null);

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
          setEditorSessionContent(normalizedContent);
          setEditorSessionKey((current) => current + 1);
          setSaveStatus("unchanged");
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
          setEditorSessionContent("");
          setEditorSessionKey((current) => current + 1);
          setSaveStatus("error");
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
        clearHighlightTimer();
      };
    }, [note.id]);

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

    useEffect(() => {
      if (
        !editor ||
        isLoadingNote ||
        highlightRequest === null ||
        highlightRequest.requestId === lastHandledHighlightRequestRef.current
      ) {
        return;
      }

      lastHandledHighlightRequestRef.current = highlightRequest.requestId;
      applySearchHighlight(highlightRequest);
    }, [applySearchHighlight, editor, highlightRequest, isLoadingNote]);

    return (
      <section
        className={`${styles.panel} ${styles.workspacePanel} ${styles.workspacePanelShell}`}
      >
        <header className={`${styles.panelHeader} ${editorStyles.editorPanelHeader}`}>
          <div className={editorStyles.editorHeader}>
            <h3 className={editorStyles.editorTitle}>{note.title}</h3>
            <div className={editorStyles.editorSubline}>
              <p className={editorStyles.editorPath}>{notePath}</p>
              <div
                className={`${editorStyles.saveStatusBadge} ${
                  saveStatus === "error"
                    ? editorStyles.saveStatusError
                    : saveStatus === "saving"
                      ? editorStyles.saveStatusSaving
                      : saveStatus === "saved"
                        ? editorStyles.saveStatusSaved
                        : saveStatus === "dirty"
                          ? editorStyles.saveStatusDirty
                          : ""
                }`}
              >
                {getSaveStatusLabel(saveStatus)}
              </div>
            </div>
            <p className={editorStyles.editorMeta}>
              最近更新时间：{formatDate(lastSavedAt)}
            </p>
          </div>
        </header>

        <div className={editorStyles.editorBody}>
          <div className={editorStyles.editorSurface}>
            <RichTextToolbar
              editor={editor}
              disabled={disabled || isLoadingNote}
              hasFontUndo={fontUndoStack.length > 0}
              hasFontRedo={fontRedoStack.length > 0}
              onUndo={handleToolbarUndo}
              onRedo={handleToolbarRedo}
              onInsertInlineMath={() => openMathInsertDialog("inline")}
              onInsertBlockMath={() => openMathInsertDialog("block")}
              onInsertImage={() => {
                void handleInsertImage();
              }}
              trailingContent={
                <>
                  <button
                    type="button"
                    className={editorStyles.toolbarIconButton}
                    onClick={handleClearEditorContent}
                    disabled={isClearContentDisabled}
                    aria-label="清空正文"
                    title="清空正文"
                  >
                    <TrashIcon className={editorStyles.toolbarIcon} />
                  </button>
                  <button
                    type="button"
                    className={editorStyles.toolbarIconButton}
                    onClick={() =>
                      recordFontSizeChange(
                        clampEditorFontSize(editorFontSize - 1),
                      )
                    }
                    disabled={isDecreaseFontDisabled}
                    aria-label="缩小正文字号"
                    title="缩小正文字号"
                  >
                    <TextSizeDecreaseIcon className={editorStyles.toolbarIcon} />
                  </button>
                  <button
                    type="button"
                    className={editorStyles.toolbarIconButton}
                    onClick={() =>
                      recordFontSizeChange(
                        clampEditorFontSize(editorFontSize + 1),
                      )
                    }
                    disabled={isIncreaseFontDisabled}
                    aria-label="放大正文字号"
                    title="放大正文字号"
                  >
                    <TextSizeIncreaseIcon className={editorStyles.toolbarIcon} />
                  </button>
                </>
              }
            />
            <div className={editorStyles.editorContent}>
              <EditorContent
                editor={editor}
                className={editorStyles.editorCanvas}
                style={editorCanvasStyle}
              />
            </div>
          </div>
        </div>

        <MathEditorDialog
          open={mathDialogState !== null}
          intent={mathDialogState?.intent ?? "insert"}
          displayMode={mathDialogState?.displayMode ?? "inline"}
          latex={mathDraftLatex}
          errorMessage={mathDialogError}
          onLatexChange={(value) => {
            setMathDraftLatex(value);
            if (mathDialogError) {
              setMathDialogError(null);
            }
          }}
          onCancel={closeMathDialog}
          onConfirm={handleConfirmMathDialog}
        />
      </section>
    );
  },
);

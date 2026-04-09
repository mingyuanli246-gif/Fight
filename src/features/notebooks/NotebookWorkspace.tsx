import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clearNotebookCoverImage,
  createFolder,
  createNote,
  createNotebook,
  deleteFolder,
  deleteNote,
  deleteNotebook,
  getNoteById,
  initializeNotebookDatabase,
  listFoldersByNotebook,
  listNotesByNotebook,
  listNotebooks,
  renameFolder,
  renameNote,
  renameNotebook,
  updateNotebookCoverImage,
} from "./repository";
import {
  clearManagedResourceResolution,
  primeManagedResourceResolution,
} from "./editorResources";
import type { NoteEditorPaneRef } from "./NoteEditorPane";
import { NotebookDetailWorkspace } from "./NotebookDetailWorkspace";
import { NotebookHomeWorkspace } from "./NotebookHomeWorkspace";
import {
  deleteManagedResource,
  ensureResourceDirectories,
  selectAndImportImage,
} from "./resourceCommands";
import type {
  Folder,
  Note,
  NoteOpenRequest,
  NoteOpenTarget,
  Notebook,
  NotebookHighlightRequest,
  NotebookHomeSort,
  NotebookShellMode,
  SelectedEntity,
} from "./types";
import styles from "./NotebookWorkspaceShell.module.css";

const SECTION_LEAVE_BLOCKED_MESSAGE =
  "当前笔记保存失败，已阻止切换。请先重试保存或复制内容后再操作。";
const WINDOW_LEAVE_BLOCKED_MESSAGE =
  "当前笔记仍有未保存内容，已阻止关闭或刷新。请先等待保存完成，或复制内容后再操作。";
const RESTORE_BLOCKED_MESSAGE =
  "恢复备份前保存失败，已阻止恢复操作。请先等待保存完成，或复制内容后再操作。";
const HOME_SORT_STORAGE_KEY = "notebooks.home.sort";
const RIGHT_PANEL_COLLAPSED_STORAGE_KEY =
  "notebooks.detail.right-panel-collapsed";

interface DeleteTarget {
  kind: "notebook" | "folder" | "note";
  id: number;
  title: string;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "操作失败，请稍后重试。";
}

function readStoredHomeSort(): NotebookHomeSort {
  if (typeof window === "undefined") {
    return "updated-desc";
  }

  const value = window.localStorage.getItem(HOME_SORT_STORAGE_KEY);

  if (
    value === "updated-desc" ||
    value === "created-desc" ||
    value === "name-asc" ||
    value === "name-desc"
  ) {
    return value;
  }

  return "updated-desc";
}

function readStoredRightPanelCollapsed() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(RIGHT_PANEL_COLLAPSED_STORAGE_KEY) === "true";
}

function entityExists(
  selection: SelectedEntity,
  notebookId: number,
  folders: Folder[],
  notes: Note[],
) {
  switch (selection.kind) {
    case "notebook":
      return selection.id === notebookId;
    case "folder":
      return folders.some((folder) => folder.id === selection.id);
    case "note":
      return notes.some((note) => note.id === selection.id);
    default:
      return false;
  }
}

function resolveSelection(
  notebookId: number,
  folders: Folder[],
  notes: Note[],
  preferredSelection: SelectedEntity | null,
) {
  if (
    preferredSelection !== null &&
    entityExists(preferredSelection, notebookId, folders, notes)
  ) {
    return preferredSelection;
  }

  return { kind: "notebook", id: notebookId } as const;
}

function createUniqueName(baseName: string, existingValues: string[]) {
  const existing = new Set(existingValues);

  if (!existing.has(baseName)) {
    return baseName;
  }

  let index = 2;
  let next = `${baseName} ${index}`;

  while (existing.has(next)) {
    index += 1;
    next = `${baseName} ${index}`;
  }

  return next;
}

function collatorCompare(left: string, right: string) {
  return new Intl.Collator(["zh-Hans-CN-u-co-pinyin", "zh-CN", "en"], {
    numeric: true,
    sensitivity: "base",
  }).compare(left, right);
}

function sortNotebooks(notebooks: Notebook[], sort: NotebookHomeSort) {
  return [...notebooks].sort((left, right) => {
    if (sort === "created-desc") {
      const createdDiff =
        Date.parse(right.createdAt.replace(" ", "T")) -
        Date.parse(left.createdAt.replace(" ", "T"));
      return createdDiff || collatorCompare(left.name, right.name);
    }

    if (sort === "name-asc") {
      return collatorCompare(left.name, right.name);
    }

    if (sort === "name-desc") {
      return collatorCompare(right.name, left.name);
    }

    const updatedDiff =
      Date.parse(right.updatedAt.replace(" ", "T")) -
      Date.parse(left.updatedAt.replace(" ", "T"));
    return updatedDiff || collatorCompare(left.name, right.name);
  });
}

function isEditableElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest(
      'input, textarea, select, button, [contenteditable="true"], .ProseMirror',
    ),
  );
}

interface NotebookWorkspaceProps {
  openRequest: NoteOpenRequest | null;
  onOpenNote: (target: NoteOpenTarget) => void;
  onChromeModeChange?: (mode: NotebookShellMode) => void;
}

export type NotebookChromeMode = NotebookShellMode;

export type NotebookLeaveReason =
  | "section-change"
  | "window-close"
  | "before-unload"
  | "restore-backup";

export interface NotebookWorkspaceRef {
  hasUnsavedChanges: () => boolean;
  flushBeforeLeave: (reason?: NotebookLeaveReason) => Promise<boolean>;
}

export const NotebookWorkspace = forwardRef<
  NotebookWorkspaceRef,
  NotebookWorkspaceProps
>(function NotebookWorkspace(
  { openRequest, onOpenNote, onChromeModeChange },
  ref,
) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNotebookId, setSelectedNotebookId] = useState<number | null>(
    null,
  );
  const [homeSelectedNotebookId, setHomeSelectedNotebookId] = useState<number | null>(
    null,
  );
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity | null>(
    null,
  );
  const [shellMode, setShellMode] = useState<NotebookShellMode>("home");
  const [homeSort, setHomeSort] = useState<NotebookHomeSort>(() =>
    readStoredHomeSort(),
  );
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(() =>
    readStoredRightPanelCollapsed(),
  );
  const [highlightRequest, setHighlightRequest] =
    useState<NotebookHighlightRequest | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const noteEditorRef = useRef<NoteEditorPaneRef | null>(null);
  const lastHandledOpenRequestRef = useRef<number | null>(null);

  const sortedNotebooks = useMemo(
    () => sortNotebooks(notebooks, homeSort),
    [homeSort, notebooks],
  );

  const currentNotebook =
    selectedNotebookId === null
      ? null
      : notebooks.find((notebook) => notebook.id === selectedNotebookId) ?? null;

  const selectedFolder =
    selectedEntity?.kind === "folder"
      ? folders.find((folder) => folder.id === selectedEntity.id) ?? null
      : null;

  const selectedNote =
    selectedEntity?.kind === "note"
      ? notes.find((note) => note.id === selectedEntity.id) ?? null
      : null;

  const activeFolderId =
    selectedFolder?.id ?? (selectedNote?.folderId ?? null);

  useEffect(() => {
    onChromeModeChange?.(shellMode);
  }, [onChromeModeChange, shellMode]);

  useEffect(() => {
    window.localStorage.setItem(HOME_SORT_STORAGE_KEY, homeSort);
  }, [homeSort]);

  useEffect(() => {
    window.localStorage.setItem(
      RIGHT_PANEL_COLLAPSED_STORAGE_KEY,
      String(isRightPanelCollapsed),
    );
  }, [isRightPanelCollapsed]);

  function hasUnsavedChanges() {
    return (
      selectedEntity?.kind === "note" &&
      (noteEditorRef.current?.hasUnsavedChanges() ?? false)
    );
  }

  function getLeaveBlockedMessage(reason: NotebookLeaveReason) {
    switch (reason) {
      case "window-close":
      case "before-unload":
        return WINDOW_LEAVE_BLOCKED_MESSAGE;
      case "restore-backup":
        return RESTORE_BLOCKED_MESSAGE;
      case "section-change":
      default:
        return SECTION_LEAVE_BLOCKED_MESSAGE;
    }
  }

  async function flushCurrentNoteIfNeeded(
    reason: NotebookLeaveReason = "section-change",
  ) {
    if (!hasUnsavedChanges()) {
      return true;
    }

    const saved = (await noteEditorRef.current?.flushPendingSave()) ?? true;

    if (!saved) {
      setErrorMessage(getLeaveBlockedMessage(reason));
      return false;
    }

    setErrorMessage(null);
    return true;
  }

  useImperativeHandle(
    ref,
    () => ({
      hasUnsavedChanges,
      async flushBeforeLeave(reason = "section-change") {
        return flushCurrentNoteIfNeeded(reason);
      },
    }),
    [selectedEntity],
  );

  async function syncWorkspace(
    preferredNotebookId: number | null = null,
    preferredSelection: SelectedEntity | null = null,
  ) {
    const notebookList = await listNotebooks();
    setNotebooks(notebookList);

    if (notebookList.length === 0) {
      setSelectedNotebookId(null);
      setHomeSelectedNotebookId(null);
      setSelectedEntity(null);
      setFolders([]);
      setNotes([]);
      return;
    }

    const nextNotebookId =
      preferredNotebookId !== null &&
      notebookList.some((notebook) => notebook.id === preferredNotebookId)
        ? preferredNotebookId
        : selectedNotebookId !== null &&
            notebookList.some((notebook) => notebook.id === selectedNotebookId)
          ? selectedNotebookId
          : notebookList[0].id;

    const [folderList, noteList] = await Promise.all([
      listFoldersByNotebook(nextNotebookId),
      listNotesByNotebook(nextNotebookId),
    ]);

    setSelectedNotebookId(nextNotebookId);
    setHomeSelectedNotebookId((current) =>
      current !== null &&
      notebookList.some((notebook) => notebook.id === current)
        ? current
        : nextNotebookId,
    );
    setFolders(folderList);
    setNotes(noteList);
    setSelectedEntity(
      resolveSelection(nextNotebookId, folderList, noteList, preferredSelection),
    );
  }

  async function initializeWorkspace() {
    setInitializationError(null);
    setErrorMessage(null);
    setIsInitializing(true);

    try {
      await ensureResourceDirectories();
      await initializeNotebookDatabase();
      await syncWorkspace();
      setShellMode("home");
    } catch (error) {
      setInitializationError(getErrorMessage(error));
      setNotebooks([]);
      setFolders([]);
      setNotes([]);
      setSelectedNotebookId(null);
      setHomeSelectedNotebookId(null);
      setSelectedEntity(null);
    } finally {
      setIsInitializing(false);
    }
  }

  useEffect(() => {
    void initializeWorkspace();
  }, []);

  useEffect(() => {
    if (openRequest === null || isInitializing) {
      return;
    }

    if (lastHandledOpenRequestRef.current === openRequest.requestId) {
      return;
    }

    lastHandledOpenRequestRef.current = openRequest.requestId;

    void (async () => {
      const saved = await flushCurrentNoteIfNeeded();

      if (!saved) {
        return;
      }

      setIsBusy(true);

      try {
        const targetNote = await getNoteById(openRequest.noteId);
        await syncWorkspace(targetNote.notebookId, {
          kind: "note",
          id: targetNote.id,
        });
        setHomeSelectedNotebookId(targetNote.notebookId);
        setShellMode("detail");
        setHighlightRequest(
          openRequest.highlightQuery || openRequest.highlightExcerpt
            ? {
                requestId: openRequest.requestId,
                query: openRequest.highlightQuery,
                excerpt: openRequest.highlightExcerpt,
                source: openRequest.source,
              }
            : null,
        );
      } catch (error) {
        const message = getErrorMessage(error);
        setErrorMessage(
          message.includes("目标文件不存在")
            ? "目标文件不存在或已被删除"
            : message,
        );
      } finally {
        setIsBusy(false);
      }
    })();
  }, [isInitializing, openRequest, selectedEntity]);

  async function requestSelectionChange(
    nextSelection: SelectedEntity,
    nextNotebookId: number | null = selectedNotebookId,
  ) {
    if (
      selectedEntity !== null &&
      selectedEntity.kind === nextSelection.kind &&
      selectedEntity.id === nextSelection.id &&
      (nextSelection.kind !== "notebook" || nextNotebookId === selectedNotebookId)
    ) {
      return;
    }

    if (!(await flushCurrentNoteIfNeeded())) {
      return;
    }

    if (nextSelection.kind === "notebook" && nextNotebookId !== null) {
      await handleEnterNotebook(nextNotebookId);
      return;
    }

    setErrorMessage(null);
    setHighlightRequest(null);
    setSelectedEntity(nextSelection);
  }

  async function runMutation(operation: () => Promise<void>) {
    setErrorMessage(null);
    setIsBusy(true);

    try {
      await operation();
    } catch (error) {
      const message = getErrorMessage(error);
      setErrorMessage(message);
      throw error;
    } finally {
      setIsBusy(false);
    }
  }

  async function cleanupManagedResourceBestEffort(
    resourcePath: string | null,
    reason: string,
  ) {
    if (!resourcePath) {
      return;
    }

    clearManagedResourceResolution(resourcePath);

    try {
      await deleteManagedResource(resourcePath);
    } catch (error) {
      console.error(`[notebooks.resources] ${reason}失败`, {
        resourcePath,
        error,
      });
    }
  }

  async function handleEnterNotebook(notebookId: number) {
    const saved = await flushCurrentNoteIfNeeded();

    if (!saved) {
      return;
    }

    setErrorMessage(null);
    setIsBusy(true);

    try {
      setHomeSelectedNotebookId(notebookId);

      if (selectedNotebookId === notebookId) {
        setShellMode("detail");
        setHighlightRequest(null);
        return;
      }

      await syncWorkspace(notebookId, { kind: "notebook", id: notebookId });
      setShellMode("detail");
      setHighlightRequest(null);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleReturnHome() {
    const saved = await flushCurrentNoteIfNeeded();

    if (!saved) {
      return;
    }

    setHomeSelectedNotebookId(selectedNotebookId);
    setShellMode("home");
    setHighlightRequest(null);
  }

  async function handleCreateNotebook(name: string) {
    return runMutation(async () => {
      const notebook = await createNotebook(name);
      await syncWorkspace(notebook.id, { kind: "notebook", id: notebook.id });
      setHomeSelectedNotebookId(notebook.id);
    });
  }

  async function handleCreateFolder() {
    if (selectedNotebookId === null) {
      throw new Error("请先选择笔记本，再创建文件夹。");
    }

    return runMutation(async () => {
      const defaultName = createUniqueName(
        "新文件夹",
        folders.map((folder) => folder.name),
      );
      const folder = await createFolder(selectedNotebookId, defaultName);
      await syncWorkspace(selectedNotebookId, { kind: "folder", id: folder.id });
    });
  }

  async function handleCreateNote() {
    if (selectedNotebookId === null) {
      throw new Error("请先选择笔记本，再创建文件。");
    }

    if (activeFolderId === null) {
      throw new Error("请先选择文件夹，再创建文件。");
    }

    return runMutation(async () => {
      const defaultTitle = createUniqueName(
        "新文件",
        notes
          .filter((note) => note.folderId === activeFolderId)
          .map((note) => note.title),
      );
      const note = await createNote(selectedNotebookId, activeFolderId, defaultTitle);
      await syncWorkspace(selectedNotebookId, { kind: "note", id: note.id });
    });
  }

  async function handleRenameNotebook(id: number, name: string) {
    return runMutation(async () => {
      await renameNotebook(id, name);
      await syncWorkspace(id, { kind: "notebook", id });
      setHomeSelectedNotebookId(id);
    });
  }

  async function handleDeleteNotebook(id: number) {
    return runMutation(async () => {
      await deleteNotebook(id);
      await syncWorkspace();
      setShellMode("home");
      setHighlightRequest(null);
    });
  }

  async function handleSetNotebookCoverImage(id: number) {
    const notebook = notebooks.find((candidate) => candidate.id === id) ?? null;

    if (!notebook) {
      throw new Error("目标笔记本不存在。");
    }

    return runMutation(async () => {
      const importResult = await selectAndImportImage("notebook-cover");

      if (importResult.status === "cancelled") {
        return;
      }

      const nextCoverPath = importResult.resourcePath;
      const previousCoverPath = notebook.coverImagePath;
      clearManagedResourceResolution(nextCoverPath);
      primeManagedResourceResolution(importResult);

      try {
        const updatedNotebook = await updateNotebookCoverImage(id, nextCoverPath);
        setNotebooks((currentNotebooks) =>
          currentNotebooks.map((currentNotebook) =>
            currentNotebook.id === id ? updatedNotebook : currentNotebook,
          ),
        );
      } catch {
        await cleanupManagedResourceBestEffort(nextCoverPath, "清理未保存的新封面");
        throw new Error("笔记本封面保存失败，请稍后重试。");
      }

      if (previousCoverPath && previousCoverPath !== nextCoverPath) {
        clearManagedResourceResolution(previousCoverPath);
        await cleanupManagedResourceBestEffort(previousCoverPath, "清理旧封面");
      }

      await syncWorkspace(id, { kind: "notebook", id });
      setHomeSelectedNotebookId(id);
    });
  }

  async function handleClearNotebookCoverImage(id: number) {
    const notebook = notebooks.find((candidate) => candidate.id === id) ?? null;

    if (!notebook) {
      throw new Error("目标笔记本不存在。");
    }

    return runMutation(async () => {
      const previousCoverPath = notebook.coverImagePath;
      const updatedNotebook = await clearNotebookCoverImage(id);
      setNotebooks((currentNotebooks) =>
        currentNotebooks.map((currentNotebook) =>
          currentNotebook.id === id ? updatedNotebook : currentNotebook,
        ),
      );
      clearManagedResourceResolution(previousCoverPath ?? undefined);
      await cleanupManagedResourceBestEffort(previousCoverPath, "清理旧封面");
      await syncWorkspace(id, { kind: "notebook", id });
      setHomeSelectedNotebookId(id);
    });
  }

  async function handleRenameFolder(id: number, name: string) {
    if (selectedNotebookId === null) {
      throw new Error("请先选择笔记本，再修改文件夹。");
    }

    return runMutation(async () => {
      await renameFolder(id, name);
      await syncWorkspace(selectedNotebookId, { kind: "folder", id });
    });
  }

  async function handleDeleteFolder(id: number) {
    if (selectedNotebookId === null) {
      throw new Error("请先选择笔记本，再删除文件夹。");
    }

    return runMutation(async () => {
      await deleteFolder(id);
      await syncWorkspace(selectedNotebookId, {
        kind: "notebook",
        id: selectedNotebookId,
      });
    });
  }

  async function handleRenameNote(id: number, title: string) {
    if (selectedNotebookId === null) {
      throw new Error("请先选择笔记本，再修改文件。");
    }

    return runMutation(async () => {
      await renameNote(id, title);
      await syncWorkspace(selectedNotebookId, { kind: "note", id });
    });
  }

  async function handleDeleteNote(id: number) {
    if (selectedNotebookId === null) {
      throw new Error("请先选择笔记本，再删除文件。");
    }

    const fallbackSelection =
      selectedNote !== null && selectedNote.folderId !== null
        ? ({ kind: "folder", id: selectedNote.folderId } as const)
        : ({ kind: "notebook", id: selectedNotebookId } as const);

    return runMutation(async () => {
      await deleteNote(id);
      await syncWorkspace(selectedNotebookId, fallbackSelection);
    });
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) {
      return;
    }

    try {
      if (deleteTarget.kind === "notebook") {
        await handleDeleteNotebook(deleteTarget.id);
      }

      if (deleteTarget.kind === "folder") {
        await handleDeleteFolder(deleteTarget.id);
      }

      if (deleteTarget.kind === "note") {
        await handleDeleteNote(deleteTarget.id);
      }

      setDeleteTarget(null);
    } catch {
      // 错误由上层统一展示
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isDeleteShortcut =
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "Backspace" || event.key === "Delete");

      if (!isDeleteShortcut || isEditableElement(event.target) || isBusy) {
        return;
      }

      if (shellMode === "home") {
        const notebook =
          homeSelectedNotebookId === null
            ? null
            : notebooks.find((item) => item.id === homeSelectedNotebookId) ?? null;

        if (!notebook) {
          return;
        }

        event.preventDefault();
        setDeleteTarget({
          kind: "notebook",
          id: notebook.id,
          title: "确定删除这个笔记本吗",
        });
        return;
      }

      if (selectedEntity?.kind === "folder") {
        event.preventDefault();
        setDeleteTarget({
          kind: "folder",
          id: selectedEntity.id,
          title: "确定删除这个文件夹吗",
        });
      }

      if (selectedEntity?.kind === "note") {
        event.preventDefault();
        setDeleteTarget({
          kind: "note",
          id: selectedEntity.id,
          title: "确定删除这个文件吗",
        });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    homeSelectedNotebookId,
    isBusy,
    notebooks,
    selectedEntity,
    shellMode,
  ]);

  if (isInitializing) {
    return (
      <div className={styles.statusCard}>
        <strong className={styles.statusTitle}>正在初始化本地数据库</strong>
        <p className={styles.statusText}>正在连接 SQLite 并读取笔记本结构。</p>
      </div>
    );
  }

  if (initializationError) {
    return (
      <div className={styles.statusCard}>
        <strong className={styles.statusTitle}>数据库初始化失败</strong>
        <p className={styles.statusText}>{initializationError}</p>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => {
            void initializeWorkspace();
          }}
        >
          重试加载
        </button>
      </div>
    );
  }

  return (
    <div
      className={`${styles.workspaceShell} ${
        shellMode === "detail" ? styles.workspaceShellDetailMode : ""
      }`}
    >
      {errorMessage ? (
        <div className={styles.noticeBanner}>
          <div>
            <p className={styles.noticeTitle}>操作失败</p>
            <p className={styles.noticeText}>{errorMessage}</p>
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

      {shellMode === "home" ? (
        <NotebookHomeWorkspace
          notebooks={sortedNotebooks}
          selectedNotebookId={homeSelectedNotebookId}
          disabled={isBusy}
          sort={homeSort}
          onSortChange={setHomeSort}
          onSelectNotebook={setHomeSelectedNotebookId}
          onOpenNotebook={(notebookId) => {
            void handleEnterNotebook(notebookId);
          }}
          onOpenSearchResult={(target) => {
            setErrorMessage(null);
            setHighlightRequest(null);
            onOpenNote(target);
          }}
          onCreateNotebook={handleCreateNotebook}
          onRenameNotebook={handleRenameNotebook}
          onRequestDeleteNotebook={(notebook) =>
            setDeleteTarget({
              kind: "notebook",
              id: notebook.id,
              title: "确定删除这个笔记本吗",
            })
          }
          onSetNotebookCoverImage={handleSetNotebookCoverImage}
          onClearNotebookCoverImage={handleClearNotebookCoverImage}
        />
      ) : (
        <NotebookDetailWorkspace
          notebook={currentNotebook}
          folders={folders}
          notes={notes}
          selectedEntity={selectedEntity}
          selectedNote={selectedNote}
          activeFolderId={activeFolderId}
          disabled={isBusy}
          rightPanelCollapsed={isRightPanelCollapsed}
          highlightRequest={highlightRequest}
          noteEditorRef={noteEditorRef}
          onReturnHome={() => {
            void handleReturnHome();
          }}
          onSelectEntity={(entity) => {
            void requestSelectionChange(entity);
          }}
          onCreateFolder={handleCreateFolder}
          onCreateNote={handleCreateNote}
          onRenameFolder={handleRenameFolder}
          onRenameNote={handleRenameNote}
          onToggleRightPanel={() =>
            setIsRightPanelCollapsed((current) => !current)
          }
          onNoteUpdated={(updatedNote) => {
            setNotes((currentNotes) =>
              currentNotes.map((note) =>
                note.id === updatedNote.id ? updatedNote : note,
              ),
            );
            setNotebooks((currentNotebooks) =>
              currentNotebooks.map((notebook) =>
                notebook.id === updatedNote.notebookId
                  ? { ...notebook, updatedAt: updatedNote.updatedAt }
                  : notebook,
              ),
            );
          }}
          onError={setErrorMessage}
        />
      )}

      {deleteTarget ? (
        <div className={styles.dialogOverlay}>
          <div className={styles.deleteDialog}>
            <h3 className={styles.dialogTitle}>删除确认</h3>
            <p className={styles.dialogText}>{deleteTarget.title}</p>
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setDeleteTarget(null)}
                disabled={isBusy}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => {
                  void handleConfirmDelete();
                }}
                disabled={isBusy}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

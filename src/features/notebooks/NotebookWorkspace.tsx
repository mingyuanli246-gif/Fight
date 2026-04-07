import {
  forwardRef,
  useEffect,
  useImperativeHandle,
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
import { clearManagedResourceResolution } from "./editorResources";
import {
  NoteEditorPane,
  type NoteEditorPaneRef,
} from "./NoteEditorPane";
import { NotebookDetailsPane } from "./NotebookDetailsPane";
import { NotebookSidebar } from "./NotebookSidebar";
import { NotebookTreePane } from "./NotebookTreePane";
import {
  deleteManagedResource,
  selectAndImportImage,
} from "./resourceCommands";
import type {
  Folder,
  Note,
  Notebook,
  NoteOpenRequest,
  SelectedEntity,
} from "./types";
import styles from "./NotebookWorkspace.module.css";

const SECTION_LEAVE_BLOCKED_MESSAGE =
  "当前笔记保存失败，已阻止切换。请先重试保存或复制内容后再操作。";
const WINDOW_LEAVE_BLOCKED_MESSAGE =
  "当前笔记仍有未保存内容，已阻止关闭或刷新。请先等待保存完成，或复制内容后再操作。";
const RESTORE_BLOCKED_MESSAGE =
  "恢复备份前保存失败，已阻止恢复操作。请先等待保存完成，或复制内容后再操作。";

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "操作失败，请稍后重试。";
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

interface NotebookWorkspaceProps {
  openRequest: NoteOpenRequest | null;
}

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
>(function NotebookWorkspace({ openRequest }, ref) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNotebookId, setSelectedNotebookId] = useState<number | null>(
    null,
  );
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity | null>(
    null,
  );
  const [initializationError, setInitializationError] = useState<string | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const noteEditorRef = useRef<NoteEditorPaneRef | null>(null);
  const lastHandledOpenRequestRef = useRef<number | null>(null);

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
      await initializeNotebookDatabase();
      await syncWorkspace();
    } catch (error) {
      setInitializationError(getErrorMessage(error));
      setNotebooks([]);
      setFolders([]);
      setNotes([]);
      setSelectedNotebookId(null);
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

  const currentNotebook =
    selectedNotebookId === null
      ? null
      : notebooks.find((notebook) => notebook.id === selectedNotebookId) ?? null;

  const selectedNotebook =
    selectedEntity?.kind === "notebook" ? currentNotebook : null;

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

  const selectedFolderNoteCount =
    selectedFolder === null
      ? 0
      : notes.filter((note) => note.folderId === selectedFolder.id).length;

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
      await handleSelectNotebook(nextNotebookId);
      return;
    }

    setErrorMessage(null);
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

  async function handleSelectNotebook(notebookId: number) {
    setErrorMessage(null);
    setIsBusy(true);

    try {
      await syncWorkspace(notebookId, { kind: "notebook", id: notebookId });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreateNotebook(name: string) {
    return runMutation(async () => {
      const notebook = await createNotebook(name);
      await syncWorkspace(notebook.id, { kind: "notebook", id: notebook.id });
    });
  }

  async function handleCreateFolder(name: string) {
    if (selectedNotebookId === null) {
      throw new Error("请先选择笔记本，再创建文件夹。");
    }

    return runMutation(async () => {
      const folder = await createFolder(selectedNotebookId, name);
      await syncWorkspace(selectedNotebookId, { kind: "folder", id: folder.id });
    });
  }

  async function handleCreateNote(title: string) {
    if (selectedNotebookId === null) {
      throw new Error("请先选择笔记本，再创建文件。");
    }

    return runMutation(async () => {
      const note = await createNote(selectedNotebookId, activeFolderId, title);
      await syncWorkspace(selectedNotebookId, { kind: "note", id: note.id });
    });
  }

  async function handleRenameNotebook(id: number, name: string) {
    return runMutation(async () => {
      await renameNotebook(id, name);
      await syncWorkspace(id, { kind: "notebook", id });
    });
  }

  async function handleDeleteNotebook(id: number) {
    return runMutation(async () => {
      await deleteNotebook(id);
      await syncWorkspace();
    });
  }

  async function handleSetNotebookCoverImage(id: number) {
    const notebook =
      notebooks.find((candidate) => candidate.id === id) ?? null;

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

      try {
        await updateNotebookCoverImage(id, nextCoverPath);
      } catch {
        await cleanupManagedResourceBestEffort(nextCoverPath, "清理未保存的新封面");
        throw new Error("笔记本封面保存失败，请稍后重试。");
      }

      if (previousCoverPath && previousCoverPath !== nextCoverPath) {
        await cleanupManagedResourceBestEffort(previousCoverPath, "清理旧封面");
      }

      await syncWorkspace(id, { kind: "notebook", id });
    });
  }

  async function handleClearNotebookCoverImage(id: number) {
    const notebook =
      notebooks.find((candidate) => candidate.id === id) ?? null;

    if (!notebook) {
      throw new Error("目标笔记本不存在。");
    }

    return runMutation(async () => {
      const previousCoverPath = notebook.coverImagePath;
      await clearNotebookCoverImage(id);
      await cleanupManagedResourceBestEffort(previousCoverPath, "清理旧封面");
      await syncWorkspace(id, { kind: "notebook", id });
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
          className={styles.actionButton}
          onClick={initializeWorkspace}
        >
          重试加载
        </button>
      </div>
    );
  }

  return (
    <>
      {errorMessage ? (
        <div className={styles.errorBanner}>
          <div>
            <p className={styles.errorTitle}>操作失败</p>
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
        <NotebookSidebar
          notebooks={notebooks}
          selectedNotebookId={selectedNotebookId}
          disabled={isBusy}
          onSelectNotebook={(notebookId) => {
            void requestSelectionChange(
              { kind: "notebook", id: notebookId },
              notebookId,
            );
          }}
          onCreateNotebook={handleCreateNotebook}
        />
        <NotebookTreePane
          notebook={currentNotebook}
          folders={folders}
          notes={notes}
          selectedEntity={selectedEntity}
          activeFolderId={activeFolderId}
          disabled={isBusy}
          onSelectEntity={(entity) => {
            void requestSelectionChange(entity);
          }}
          onCreateFolder={handleCreateFolder}
          onCreateNote={handleCreateNote}
        />
        {currentNotebook !== null && selectedNote !== null ? (
          <NoteEditorPane
            ref={noteEditorRef}
            notebook={currentNotebook}
            note={selectedNote}
            folders={folders}
            disabled={isBusy}
            onRenameNote={handleRenameNote}
            onDeleteNote={handleDeleteNote}
            onNoteUpdated={(updatedNote) => {
              setNotes((currentNotes) =>
                currentNotes.map((note) =>
                  note.id === updatedNote.id ? updatedNote : note,
                ),
              );
            }}
            onError={setErrorMessage}
          />
        ) : (
          <NotebookDetailsPane
            notebook={currentNotebook}
            folders={folders}
            selectedNotebook={selectedNotebook}
            selectedFolder={selectedFolder}
            noteCount={selectedFolder !== null ? selectedFolderNoteCount : notes.length}
            disabled={isBusy}
            onRenameNotebook={handleRenameNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onSetNotebookCoverImage={handleSetNotebookCoverImage}
            onClearNotebookCoverImage={handleClearNotebookCoverImage}
            onRenameFolder={handleRenameFolder}
            onDeleteFolder={handleDeleteFolder}
          />
        )}
      </div>
    </>
  );
});

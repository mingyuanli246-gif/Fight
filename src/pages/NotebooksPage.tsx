import type { RefObject } from "react";
import type {
  NoteOpenRequest,
  NoteOpenTarget,
  NotebookShellMode,
} from "../features/notebooks/types";
import {
  NotebookWorkspace,
  type NotebookWorkspaceRef,
} from "../features/notebooks/NotebookWorkspace";
import styles from "./PageLayout.module.css";

interface NotebooksPageProps {
  openRequest: NoteOpenRequest | null;
  workspaceRef: RefObject<NotebookWorkspaceRef | null>;
  onChromeModeChange: (mode: NotebookShellMode) => void;
  onOpenNote: (target: NoteOpenTarget) => void;
}

export function NotebooksPage({
  openRequest,
  workspaceRef,
  onChromeModeChange,
  onOpenNote,
}: NotebooksPageProps) {
  return (
    <section
      className={`${styles.page} ${styles.pageFill} ${styles.pageNotebookWorkspace}`}
    >
      <NotebookWorkspace
        ref={workspaceRef}
        openRequest={openRequest}
        onChromeModeChange={onChromeModeChange}
        onOpenNote={onOpenNote}
      />
    </section>
  );
}

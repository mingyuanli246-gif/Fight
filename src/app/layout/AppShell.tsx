import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  NoteOpenRequest,
  NoteOpenTarget,
} from "../../features/notebooks/types";
import type {
  NotebookChromeMode,
  NotebookLeaveReason,
  NotebookWorkspaceRef,
} from "../../features/notebooks/NotebookWorkspace";
import type { SettingsNotice } from "../../features/settings/types";
import { NavigationRail } from "../../features/navigation/NavigationRail";
import { NotebooksPage } from "../../pages/NotebooksPage";
import { ReviewCalendarPage } from "../../pages/ReviewCalendarPage";
import { SettingsPage } from "../../pages/SettingsPage";
import { TagPlazaPage } from "../../pages/TagPlazaPage";
import type { AppSection } from "../sections";
import styles from "./AppShell.module.css";

interface AppShellProps {
  currentSection: AppSection;
  onSectionChange: (section: AppSection) => void;
  noteOpenRequest: NoteOpenRequest | null;
  onOpenNote: (target: NoteOpenTarget) => void;
  settingsStartupNotice: SettingsNotice | null;
}

function renderPage(
  section: AppSection,
  noteOpenRequest: NoteOpenRequest | null,
  onOpenNote: (target: NoteOpenTarget) => void,
  settingsStartupNotice: SettingsNotice | null,
  notebookWorkspaceRef: RefObject<NotebookWorkspaceRef | null>,
  beforeRestoreBackup: () => Promise<boolean>,
  onNotebookChromeModeChange: (mode: NotebookChromeMode) => void,
) {
  switch (section) {
    case "notebooks":
      return (
        <NotebooksPage
          openRequest={noteOpenRequest}
          workspaceRef={notebookWorkspaceRef}
          onChromeModeChange={onNotebookChromeModeChange}
          onOpenNote={onOpenNote}
        />
      );
    case "reviewCalendar":
      return <ReviewCalendarPage onOpenNote={onOpenNote} />;
    case "tagPlaza":
      return <TagPlazaPage onOpenNote={onOpenNote} />;
    case "settings":
      return (
        <SettingsPage
          startupNotice={settingsStartupNotice}
          beforeRestoreBackup={beforeRestoreBackup}
        />
      );
    default:
      return (
        <NotebooksPage
          openRequest={noteOpenRequest}
          workspaceRef={notebookWorkspaceRef}
          onChromeModeChange={onNotebookChromeModeChange}
          onOpenNote={onOpenNote}
        />
      );
  }
}

export default function AppShell({
  currentSection,
  onSectionChange,
  noteOpenRequest,
  onOpenNote,
  settingsStartupNotice,
}: AppShellProps) {
  const notebookWorkspaceRef = useRef<NotebookWorkspaceRef | null>(null);
  const currentSectionRef = useRef(currentSection);
  const allowNextWindowCloseRef = useRef(false);
  const [isSectionChanging, setIsSectionChanging] = useState(false);
  const [notebookChromeMode, setNotebookChromeMode] =
    useState<NotebookChromeMode>("home");
  currentSectionRef.current = currentSection;

  const isNotebookDetailView =
    currentSection === "notebooks" && notebookChromeMode === "detail";
  const shouldShowRail = !isNotebookDetailView;

  async function guardNotebookBeforeDangerousLeave(
    reason: NotebookLeaveReason,
  ) {
    if (currentSectionRef.current !== "notebooks") {
      return true;
    }

    const notebookWorkspace = notebookWorkspaceRef.current;

    if (!notebookWorkspace?.hasUnsavedChanges()) {
      return true;
    }

    return notebookWorkspace.flushBeforeLeave(reason);
  }

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (currentSectionRef.current !== "notebooks") {
        return;
      }

      if (!notebookWorkspaceRef.current?.hasUnsavedChanges()) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
      void guardNotebookBeforeDangerousLeave("before-unload");
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const currentWindow = getCurrentWindow();
    let isDisposed = false;
    let unlisten: (() => void) | null = null;

    void currentWindow
      .onCloseRequested(async (event) => {
        if (allowNextWindowCloseRef.current) {
          allowNextWindowCloseRef.current = false;
          return;
        }

        if (
          currentSectionRef.current !== "notebooks" ||
          !notebookWorkspaceRef.current?.hasUnsavedChanges()
        ) {
          return;
        }

        event.preventDefault();
        const canClose = await guardNotebookBeforeDangerousLeave("window-close");

        if (!canClose) {
          return;
        }

        allowNextWindowCloseRef.current = true;

        try {
          await currentWindow.destroy();
        } catch (error) {
          allowNextWindowCloseRef.current = false;
          console.error("[app] 关闭窗口失败", error);
        }
      })
      .then((nextUnlisten) => {
        if (isDisposed) {
          nextUnlisten();
          return;
        }

        unlisten = nextUnlisten;
      })
      .catch((error) => {
        console.error("[app] 注册窗口关闭保护失败", error);
      });

    return () => {
      isDisposed = true;
      unlisten?.();
    };
  }, []);

  async function requestSectionChange(nextSection: AppSection) {
    if (nextSection === currentSection || isSectionChanging) {
      return;
    }

    setIsSectionChanging(true);

    try {
      if (currentSection === "notebooks" && nextSection !== "notebooks") {
        const canLeave = await guardNotebookBeforeDangerousLeave("section-change");

        if (!canLeave) {
          return;
        }
      }

      onSectionChange(nextSection);
    } finally {
      setIsSectionChanging(false);
    }
  }

  return (
    <div
      className={`${styles.shell} ${shouldShowRail ? "" : styles.shellNoRail}`}
    >
      {shouldShowRail ? (
        <NavigationRail
          currentSection={currentSection}
          disabled={isSectionChanging}
          onSectionChange={(section) => {
            void requestSectionChange(section);
          }}
        />
      ) : null}
      <main
        className={`${styles.content} ${
          isNotebookDetailView ? styles.contentImmersive : ""
        }`}
      >
        <div
          className={`${styles.contentInner} ${
            isNotebookDetailView ? styles.contentInnerImmersive : ""
          }`}
        >
          {renderPage(
            currentSection,
            noteOpenRequest,
            onOpenNote,
            settingsStartupNotice,
            notebookWorkspaceRef,
            () => guardNotebookBeforeDangerousLeave("restore-backup"),
            setNotebookChromeMode,
          )}
        </div>
      </main>
    </div>
  );
}

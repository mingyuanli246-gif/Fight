import { useRef, useState, type RefObject } from "react";
import type {
  NoteOpenRequest,
} from "../../features/notebooks/types";
import type { NotebookWorkspaceRef } from "../../features/notebooks/NotebookWorkspace";
import type { SettingsNotice } from "../../features/settings/types";
import { GlobalSearch } from "./GlobalSearch";
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
  onOpenNote: (target: Pick<NoteOpenRequest, "noteId" | "notebookId">) => void;
  settingsStartupNotice: SettingsNotice | null;
}

function renderPage(
  section: AppSection,
  noteOpenRequest: NoteOpenRequest | null,
  onOpenNote: (target: Pick<NoteOpenRequest, "noteId" | "notebookId">) => void,
  settingsStartupNotice: SettingsNotice | null,
  notebookWorkspaceRef: RefObject<NotebookWorkspaceRef | null>,
) {
  switch (section) {
    case "notebooks":
      return (
        <NotebooksPage
          openRequest={noteOpenRequest}
          workspaceRef={notebookWorkspaceRef}
        />
      );
    case "reviewCalendar":
      return <ReviewCalendarPage onOpenNote={onOpenNote} />;
    case "tagPlaza":
      return <TagPlazaPage onOpenNote={onOpenNote} />;
    case "settings":
      return <SettingsPage startupNotice={settingsStartupNotice} />;
    default:
      return (
        <NotebooksPage
          openRequest={noteOpenRequest}
          workspaceRef={notebookWorkspaceRef}
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
  const [isSectionChanging, setIsSectionChanging] = useState(false);

  async function requestSectionChange(nextSection: AppSection) {
    if (nextSection === currentSection || isSectionChanging) {
      return;
    }

    setIsSectionChanging(true);

    try {
      if (currentSection === "notebooks" && nextSection !== "notebooks") {
        const canLeave =
          (await notebookWorkspaceRef.current?.flushBeforeLeave()) ?? true;

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
    <div className={styles.shell}>
      <NavigationRail
        currentSection={currentSection}
        disabled={isSectionChanging}
        onSectionChange={(section) => {
          void requestSectionChange(section);
        }}
      />
      <main className={styles.content}>
        <div className={styles.topBar}>
          <GlobalSearch onOpenResult={onOpenNote} />
        </div>
        <div className={styles.contentInner}>
          {renderPage(
            currentSection,
            noteOpenRequest,
            onOpenNote,
            settingsStartupNotice,
            notebookWorkspaceRef,
          )}
        </div>
      </main>
    </div>
  );
}

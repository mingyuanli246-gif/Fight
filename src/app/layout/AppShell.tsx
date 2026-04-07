import type {
  NoteOpenRequest,
} from "../../features/notebooks/types";
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
) {
  switch (section) {
    case "notebooks":
      return <NotebooksPage openRequest={noteOpenRequest} />;
    case "reviewCalendar":
      return <ReviewCalendarPage onOpenNote={onOpenNote} />;
    case "tagPlaza":
      return <TagPlazaPage onOpenNote={onOpenNote} />;
    case "settings":
      return <SettingsPage startupNotice={settingsStartupNotice} />;
    default:
      return <NotebooksPage openRequest={noteOpenRequest} />;
  }
}

export default function AppShell({
  currentSection,
  onSectionChange,
  noteOpenRequest,
  onOpenNote,
  settingsStartupNotice,
}: AppShellProps) {
  return (
    <div className={styles.shell}>
      <NavigationRail
        currentSection={currentSection}
        onSectionChange={onSectionChange}
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
          )}
        </div>
      </main>
    </div>
  );
}

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
}

function renderPage(section: AppSection) {
  switch (section) {
    case "notebooks":
      return <NotebooksPage />;
    case "reviewCalendar":
      return <ReviewCalendarPage />;
    case "tagPlaza":
      return <TagPlazaPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <NotebooksPage />;
  }
}

export default function AppShell({
  currentSection,
  onSectionChange,
}: AppShellProps) {
  return (
    <div className={styles.shell}>
      <NavigationRail
        currentSection={currentSection}
        onSectionChange={onSectionChange}
      />
      <main className={styles.content}>
        <div className={styles.contentInner}>{renderPage(currentSection)}</div>
      </main>
    </div>
  );
}

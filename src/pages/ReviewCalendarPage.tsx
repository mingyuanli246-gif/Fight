import type { NoteOpenTarget } from "../features/notebooks/types";
import { ReviewCalendarWorkspace } from "../features/review/ReviewCalendarWorkspace";
import styles from "./PageLayout.module.css";

interface ReviewCalendarPageProps {
  onOpenNote: (target: NoteOpenTarget) => void;
}

export function ReviewCalendarPage({ onOpenNote }: ReviewCalendarPageProps) {
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h2 className={styles.title}>复习任务</h2>
      </header>

      <ReviewCalendarWorkspace onOpenNote={onOpenNote} />
    </section>
  );
}

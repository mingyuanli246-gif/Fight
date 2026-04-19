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
        <p className={styles.eyebrow}>复习任务</p>
        <h2 className={styles.title}>今日复习任务</h2>
        <p className={styles.description}>今天到期的文件会集中显示在这里，点开就能直接回到对应文件。</p>
      </header>

      <ReviewCalendarWorkspace onOpenNote={onOpenNote} />
    </section>
  );
}

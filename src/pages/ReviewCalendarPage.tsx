import type { NoteOpenRequest } from "../features/notebooks/types";
import { ReviewCalendarWorkspace } from "../features/review/ReviewCalendarWorkspace";
import styles from "./PageLayout.module.css";

interface ReviewCalendarPageProps {
  onOpenNote: (target: Pick<NoteOpenRequest, "noteId" | "notebookId">) => void;
}

export function ReviewCalendarPage({ onOpenNote }: ReviewCalendarPageProps) {
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>复习日历</p>
        <h2 className={styles.title}>复习方案与月历任务视图</h2>
        <p className={styles.description}>
          当前阶段已经接入复习方案、任务生成与月历展示。这里负责管理方案、查看任务并直接打开对应文件。
        </p>
      </header>

      <ReviewCalendarWorkspace onOpenNote={onOpenNote} />
    </section>
  );
}

import { TagPlazaWorkspace } from "../features/tags/TagPlazaWorkspace";
import type { NoteOpenTarget } from "../features/notebooks/types";
import styles from "./PageLayout.module.css";

interface TagPlazaPageProps {
  onOpenNote: (target: NoteOpenTarget) => void;
}

export function TagPlazaPage({ onOpenNote }: TagPlazaPageProps) {
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h2 className={styles.title}>标签工作区与关联文件视图</h2>
      </header>

      <TagPlazaWorkspace onOpenNote={onOpenNote} />
    </section>
  );
}

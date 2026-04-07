import { TagPlazaWorkspace } from "../features/tags/TagPlazaWorkspace";
import type { NoteOpenRequest } from "../features/notebooks/types";
import styles from "./PageLayout.module.css";

interface TagPlazaPageProps {
  onOpenNote: (target: Pick<NoteOpenRequest, "noteId" | "notebookId">) => void;
}

export function TagPlazaPage({ onOpenNote }: TagPlazaPageProps) {
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>标签广场</p>
        <h2 className={styles.title}>标签工作区与关联文件视图</h2>
        <p className={styles.description}>
          当前阶段已经接入 note 级标签系统。这里负责创建、管理标签，并查看标签下的关联文件。
        </p>
      </header>

      <TagPlazaWorkspace onOpenNote={onOpenNote} />
    </section>
  );
}

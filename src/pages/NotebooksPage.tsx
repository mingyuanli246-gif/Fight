import type { RefObject } from "react";
import type { NoteOpenRequest } from "../features/notebooks/types";
import {
  NotebookWorkspace,
  type NotebookWorkspaceRef,
} from "../features/notebooks/NotebookWorkspace";
import styles from "./PageLayout.module.css";

interface NotebooksPageProps {
  openRequest: NoteOpenRequest | null;
  workspaceRef: RefObject<NotebookWorkspaceRef | null>;
}

export function NotebooksPage({
  openRequest,
  workspaceRef,
}: NotebooksPageProps) {
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>笔记本</p>
        <h2 className={styles.title}>笔记本三层结构工作区</h2>
        <p className={styles.description}>
          当前阶段已经接入本地 SQLite、富文本正文、最小 FTS 搜索与 note 级标签绑定。
          这里仍然只处理“笔记本 - 文件夹 - 文件”的本地结构、编辑、标签与打开链路。
        </p>
      </header>

      <NotebookWorkspace ref={workspaceRef} openRequest={openRequest} />
    </section>
  );
}

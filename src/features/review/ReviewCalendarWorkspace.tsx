import { useEffect, useRef, useState } from "react";
import type { NoteOpenTarget } from "../notebooks/types";
import { listTodayReviewTasks } from "./repository";
import type { TodayReviewTaskItem } from "./types";
import styles from "./ReviewCalendarWorkspace.module.css";

interface ReviewCalendarWorkspaceProps {
  onOpenNote: (target: NoteOpenTarget) => void;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "读取今日复习任务失败，请稍后重试。";
}

function formatTaskPath(task: TodayReviewTaskItem) {
  return `${task.notebookName} / ${task.folderPath}`;
}

export function ReviewCalendarWorkspace({
  onOpenNote,
}: ReviewCalendarWorkspaceProps) {
  const [tasks, setTasks] = useState<TodayReviewTaskItem[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;
    setIsLoading(true);
    setErrorMessage(null);

    void (async () => {
      try {
        const nextTasks = await listTodayReviewTasks();

        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTasks(nextTasks);
      } catch (error) {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTasks([]);
        setErrorMessage(getErrorMessage(error));
      } finally {
        if (requestVersion === requestVersionRef.current) {
          setIsLoading(false);
        }
      }
    })();
  }, []);

  if (isLoading) {
    return (
      <section className={styles.panel}>
        <div className={styles.statusCard}>
          <h3 className={styles.statusTitle}>正在整理今日复习任务</h3>
          <p className={styles.statusText}>正在从本地数据库读取今天到期的文件。</p>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.panel}>
      {errorMessage ? (
        <div className={styles.errorBanner}>
          <div>
            <h3 className={styles.errorTitle}>读取失败</h3>
            <p className={styles.errorText}>{errorMessage}</p>
          </div>
        </div>
      ) : null}

      {tasks.length === 0 ? (
        <div className={styles.emptyState}>
          <h3 className={styles.emptyTitle}>今天没有复习任务</h3>
          <p className={styles.emptyText}>正好把注意力留给今天的新内容。</p>
        </div>
      ) : (
        <div className={styles.taskList}>
          {tasks.map((task) => (
            <button
              key={task.noteId}
              type="button"
              className={styles.taskCard}
              onClick={() =>
                onOpenNote({
                  noteId: task.noteId,
                  notebookId: task.notebookId,
                  source: "review-tasks",
                })
              }
            >
              <span className={styles.taskTitle}>{task.title}</span>
              <span className={styles.taskPath}>{formatTaskPath(task)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

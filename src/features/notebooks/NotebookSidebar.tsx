import { useState } from "react";
import type { Notebook } from "./types";
import styles from "./NotebookWorkspace.module.css";

function formatDate(value: string) {
  return new Date(value.replace(" ", "T")).toLocaleDateString("zh-CN");
}

interface NotebookSidebarProps {
  notebooks: Notebook[];
  selectedNotebookId: number | null;
  disabled: boolean;
  onSelectNotebook: (notebookId: number) => void;
  onCreateNotebook: (name: string) => Promise<void>;
}

export function NotebookSidebar({
  notebooks,
  selectedNotebookId,
  disabled,
  onSelectNotebook,
  onCreateNotebook,
}: NotebookSidebarProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");

  async function handleSubmit() {
    try {
      await onCreateNotebook(draftName);
      setDraftName("");
      setIsCreating(false);
    } catch {
      // 错误信息由上层统一展示
    }
  }

  return (
    <section className={styles.panel}>
      <header className={styles.panelHeader}>
        <div>
          <h3 className={styles.panelTitle}>笔记本列表</h3>
          <p className={styles.panelDescription}>本地数据库中的笔记本集合</p>
        </div>
        <button
          type="button"
          className={styles.actionButton}
          onClick={() => setIsCreating(true)}
          disabled={disabled || isCreating}
        >
          新建笔记本
        </button>
      </header>

      {isCreating ? (
        <div className={styles.createForm}>
          <input
            className={styles.input}
            value={draftName}
            onChange={(event) => setDraftName(event.currentTarget.value)}
            placeholder="输入笔记本名称"
            maxLength={80}
            autoFocus
          />
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                setDraftName("");
                setIsCreating(false);
              }}
              disabled={disabled}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.actionButton}
              onClick={handleSubmit}
              disabled={disabled}
            >
              保存
            </button>
          </div>
        </div>
      ) : null}

      <div className={styles.panelBody}>
        {notebooks.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>还没有笔记本</strong>
            <span>先在这里创建一个笔记本，再继续建立文件夹和文件。</span>
          </div>
        ) : (
          <ul className={styles.sidebarList}>
            {notebooks.map((notebook) => {
              const isActive = notebook.id === selectedNotebookId;

              return (
                <li key={notebook.id}>
                  <button
                    type="button"
                    className={`${styles.sidebarItem} ${
                      isActive ? styles.sidebarItemActive : ""
                    }`}
                    onClick={() => onSelectNotebook(notebook.id)}
                    disabled={disabled}
                  >
                    <span className={styles.sidebarItemTitle}>{notebook.name}</span>
                    <span className={styles.sidebarItemMeta}>
                      创建于 {formatDate(notebook.createdAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

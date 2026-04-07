import { useEffect, useState } from "react";
import type { Folder, Notebook } from "./types";
import styles from "./NotebookWorkspace.module.css";

interface NotebookDetailsPaneProps {
  notebook: Notebook | null;
  folders: Folder[];
  selectedNotebook: Notebook | null;
  selectedFolder: Folder | null;
  noteCount: number;
  disabled: boolean;
  onRenameNotebook: (id: number, name: string) => Promise<void>;
  onDeleteNotebook: (id: number) => Promise<void>;
  onRenameFolder: (id: number, name: string) => Promise<void>;
  onDeleteFolder: (id: number) => Promise<void>;
}

function formatDate(value: string) {
  return new Date(value.replace(" ", "T")).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function NotebookDetailsPane({
  notebook,
  folders,
  selectedNotebook,
  selectedFolder,
  noteCount,
  disabled,
  onRenameNotebook,
  onDeleteNotebook,
  onRenameFolder,
  onDeleteFolder,
}: NotebookDetailsPaneProps) {
  const [renameValue, setRenameValue] = useState("");
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  useEffect(() => {
    if (selectedNotebook) {
      setRenameValue(selectedNotebook.name);
    } else if (selectedFolder) {
      setRenameValue(selectedFolder.name);
    } else {
      setRenameValue("");
    }

    setIsConfirmingDelete(false);
  }, [selectedNotebook, selectedFolder]);

  async function handleRename() {
    try {
      if (selectedNotebook) {
        await onRenameNotebook(selectedNotebook.id, renameValue);
      }

      if (selectedFolder) {
        await onRenameFolder(selectedFolder.id, renameValue);
      }

    } catch {
      // 错误由上层统一展示
    }
  }

  async function handleDelete() {
    try {
      if (selectedNotebook) {
        await onDeleteNotebook(selectedNotebook.id);
      }

      if (selectedFolder) {
        await onDeleteFolder(selectedFolder.id);
      }

    } catch {
      // 错误由上层统一展示
    }
  }

  const folderNoteCount =
    selectedFolder === null
      ? 0
      : noteCount;

  return (
    <section className={styles.panel}>
      <header className={styles.panelHeader}>
        <div>
          <h3 className={styles.panelTitle}>当前选中项</h3>
          <p className={styles.panelDescription}>详情、重命名与删除确认</p>
        </div>
      </header>

      <div className={styles.panelBody}>
        {!notebook || (!selectedNotebook && !selectedFolder) ? (
          <div className={styles.emptyState}>
            <strong>尚未选中对象</strong>
            <span>从左侧或中间区域选择一个对象后，这里会显示详情。</span>
          </div>
        ) : (
          <div className={styles.detailsStack}>
            {selectedNotebook ? (
              <section className={styles.infoCard}>
                <p className={styles.infoLabel}>笔记本</p>
                <h4 className={styles.infoTitle}>{selectedNotebook.name}</h4>
                <dl className={styles.infoGrid}>
                  <div>
                    <dt>创建时间</dt>
                    <dd>{formatDate(selectedNotebook.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>更新时间</dt>
                    <dd>{formatDate(selectedNotebook.updatedAt)}</dd>
                  </div>
                  <div>
                    <dt>文件夹数量</dt>
                    <dd>{folders.length}</dd>
                  </div>
                  <div>
                    <dt>文件数量</dt>
                    <dd>{noteCount}</dd>
                  </div>
                </dl>
              </section>
            ) : null}

            {selectedFolder ? (
              <section className={styles.infoCard}>
                <p className={styles.infoLabel}>文件夹</p>
                <h4 className={styles.infoTitle}>{selectedFolder.name}</h4>
                <dl className={styles.infoGrid}>
                  <div>
                    <dt>所属笔记本</dt>
                    <dd>{notebook.name}</dd>
                  </div>
                  <div>
                    <dt>文件数量</dt>
                    <dd>{folderNoteCount}</dd>
                  </div>
                  <div>
                    <dt>创建时间</dt>
                    <dd>{formatDate(selectedFolder.createdAt)}</dd>
                  </div>
                </dl>
              </section>
            ) : null}

            <section className={styles.actionCard}>
              <h4 className={styles.cardTitle}>重命名</h4>
              <div className={styles.createForm}>
                <input
                  className={styles.input}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.currentTarget.value)}
                  placeholder="输入新的名称"
                  maxLength={120}
                />
                <div className={styles.formActions}>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={handleRename}
                    disabled={disabled}
                  >
                    保存名称
                  </button>
                </div>
              </div>
            </section>

            <section className={styles.actionCard}>
              <h4 className={styles.cardTitle}>删除确认</h4>
              {selectedNotebook ? (
                <p className={styles.cardText}>
                  删除后，该笔记本及其全部文件夹和文件会一起移除。
                </p>
              ) : null}
              {selectedFolder ? (
                <p className={styles.cardText}>
                  删除后，该文件夹会被移除，其中的文件会转入“未归档笔记”。
                </p>
              ) : null}

              {!isConfirmingDelete ? (
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={() => setIsConfirmingDelete(true)}
                  disabled={disabled}
                >
                  删除当前项
                </button>
              ) : (
                <div className={styles.confirmBox}>
                  <p className={styles.confirmText}>确认删除当前选中对象吗？</p>
                  <div className={styles.formActions}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => setIsConfirmingDelete(false)}
                      disabled={disabled}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className={styles.dangerButton}
                      onClick={handleDelete}
                      disabled={disabled}
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </section>
  );
}

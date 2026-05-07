import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cleanupExpiredTrash,
  listTrashRoots,
  purgeTrashedItem,
  restoreTrashedItem,
} from "../features/notebooks/repository";
import type { TrashRootItem } from "../features/notebooks/types";
import pageStyles from "./PageLayout.module.css";
import styles from "./TrashPage.module.css";

function formatDeletedAt(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function getItemTypeLabel(itemType: TrashRootItem["itemType"]) {
  switch (itemType) {
    case "note":
      return "文件";
    case "folder":
      return "文件夹";
    case "notebook":
      return "笔记本";
    default:
      return itemType;
  }
}

function buildScopeSummary(item: TrashRootItem) {
  const parts: string[] = [];

  if (item.descendantFolderCount > 0) {
    parts.push(`${item.descendantFolderCount} 个文件夹`);
  }

  if (item.descendantNoteCount > 0) {
    parts.push(`${item.descendantNoteCount} 个文件`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `包含 ${parts.join("，")}`;
}

function getRestoreLocationLabel(item: TrashRootItem) {
  return item.canRestoreToOriginalLocation
    ? "可恢复到原位置"
    : "原位置不可用时，将自动恢复到安全位置";
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "操作失败，请稍后重试。";
}

export function TrashPage() {
  const [items, setItems] = useState<TrashRootItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);

  const pendingKeySet = useMemo(() => new Set(pendingKeys), [pendingKeys]);

  const loadTrash = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      await cleanupExpiredTrash();
      const nextItems = await listTrashRoots();
      setItems(nextItems);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  async function runItemAction(
    item: TrashRootItem,
    action: () => Promise<string | null | void>,
  ) {
    const key = `${item.itemType}:${item.id}`;
    if (pendingKeySet.has(key)) {
      return;
    }

    setPendingKeys((current) => [...current, key]);
    setErrorMessage(null);
    setNoticeMessage(null);

    try {
      const message = await action();
      await loadTrash();
      setNoticeMessage(message ?? "操作已完成。");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setPendingKeys((current) => current.filter((currentKey) => currentKey !== key));
    }
  }

  return (
    <section className={pageStyles.page}>
      <header className={pageStyles.header}>
        <p className={pageStyles.eyebrow}>回收站</p>
        <h2 className={pageStyles.title}>最近删除</h2>
        <p className={pageStyles.description}>
          这里显示你删除的笔记本、文件夹和文件。恢复后，其中的正文图片和封面会一起恢复。永久删除后，相关图片资源会由系统自动处理，不需要手动扫描。
        </p>
      </header>

      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.refreshButton}
          disabled={isLoading}
          onClick={() => {
            void loadTrash();
          }}
        >
          刷新
        </button>
      </div>

      {noticeMessage ? <div className={styles.notice}>{noticeMessage}</div> : null}
      {errorMessage ? <div className={styles.error}>{errorMessage}</div> : null}

      <div className={pageStyles.surface}>
        <h3 className={pageStyles.surfaceTitle}>可恢复项目</h3>
        <p className={styles.surfaceLead}>
          这里只显示你直接删除的笔记本、文件夹和文件。超过 30 天的项目会在进入回收站时自动清理。
        </p>
        {isLoading ? (
          <p className={pageStyles.surfaceText}>正在读取最近删除…</p>
        ) : items.length === 0 ? (
          <p className={pageStyles.surfaceText}>
            最近删除为空。你删除的笔记本、文件夹和文件会显示在这里。
          </p>
        ) : (
          <ul className={pageStyles.list}>
            {items.map((item) => {
              const itemKey = `${item.itemType}:${item.id}`;
              const isPending = pendingKeySet.has(itemKey);
              const scopeSummary = buildScopeSummary(item);

              return (
                <li key={itemKey} className={pageStyles.listItem}>
                  <div className={styles.itemHeader}>
                    <div className={styles.itemMeta}>
                      <span className={styles.typeBadge}>
                        {getItemTypeLabel(item.itemType)}
                      </span>
                      <strong>{item.title}</strong>
                    </div>
                    <div className={styles.itemActions}>
                      <button
                        type="button"
                        className={styles.actionButton}
                        disabled={isPending}
                        onClick={() => {
                          void runItemAction(item, async () => {
                            const result = await restoreTrashedItem(item.itemType, item.id);
                            return result.userMessage ?? "已恢复";
                          });
                        }}
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        className={styles.dangerButton}
                        disabled={isPending}
                        onClick={() => {
                          void runItemAction(item, async () => {
                            await purgeTrashedItem(item.itemType, item.id);
                            return "已永久删除。";
                          });
                        }}
                      >
                        永久删除
                      </button>
                    </div>
                  </div>
                  <div className={styles.itemDetails}>
                    <span>删除时间：{formatDeletedAt(item.deletedAt)}</span>
                    {item.trashOriginPath ? (
                      <span>原位置：{item.trashOriginPath}</span>
                    ) : null}
                    {scopeSummary ? <span>{scopeSummary}</span> : null}
                    <span>{getRestoreLocationLabel(item)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

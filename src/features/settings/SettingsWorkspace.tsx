import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { closeNotebookDatabase } from "../notebooks/db";
import { ThemeContext } from "../theme/ThemeProvider";
import { themeOptions } from "../theme/themeOptions";
import {
  createBackup,
  getDataEnvironmentInfo,
  listBackups,
  loadAppSettings,
  rebuildSearchIndex,
  restoreBackup,
  saveAppSettings,
  validateBackup,
} from "./commands";
import type {
  AppSettings,
  BackupListItem,
  BackupOperationState,
  BackupValidationStatus,
  DataEnvironmentInfo,
  SettingsNotice,
} from "./types";
import styles from "./SettingsWorkspace.module.css";

const RETENTION_OPTIONS = [3, 5, 10] as const;
const BACKGROUND_VALIDATION_LIMIT = 5;
const RESTORE_BLOCKED_MESSAGE =
  "恢复备份前保存失败，已阻止恢复操作。请先等待保存完成，或复制内容后再操作。";
type BackupRefreshReason = "initial-load" | "post-create";
type BackupValidationSource = "background" | "manual" | "restore";

interface SettingsWorkspaceProps {
  startupNotice: SettingsNotice | null;
  beforeRestoreBackup: () => Promise<boolean>;
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateLabel(value: string | null) {
  if (!value) {
    return "尚未自动备份";
  }

  return value;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

function buildNotice(
  tone: SettingsNotice["tone"],
  message: string,
): SettingsNotice {
  return { tone, message };
}

function sortBackups(items: BackupListItem[]) {
  return [...items].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) ||
    right.fileName.localeCompare(left.fileName),
  );
}

function mergeBackupItem(
  currentItem: BackupListItem | undefined,
  nextItem: BackupListItem,
) {
  if (!currentItem || nextItem.validationStatus !== "unknown") {
    return nextItem;
  }

  if (currentItem.validationStatus === "unknown") {
    return nextItem;
  }

  return {
    ...nextItem,
    validationStatus: currentItem.validationStatus,
    invalidReason: currentItem.invalidReason,
    note: currentItem.note ?? nextItem.note,
  } satisfies BackupListItem;
}

function mergeBackupLists(
  currentBackups: BackupListItem[],
  nextBackups: BackupListItem[],
) {
  const currentByFileName = new Map(
    currentBackups.map((item) => [item.fileName, item]),
  );

  return sortBackups(
    nextBackups.map((item) =>
      mergeBackupItem(currentByFileName.get(item.fileName), item),
    ),
  );
}

function insertBackupItem(
  currentBackups: BackupListItem[],
  nextBackup: BackupListItem,
) {
  return sortBackups([
    nextBackup,
    ...currentBackups.filter((item) => item.fileName !== nextBackup.fileName),
  ]);
}

function logBackupRefreshStart(reason: BackupRefreshReason) {
  console.info(`[backup.perf] refresh start reason=${reason}`);
  return performance.now();
}

function logBackupRefreshComplete(
  reason: BackupRefreshReason,
  startedAt: number,
) {
  console.info(
    `[backup.perf] refresh complete reason=${reason} ${Math.round(
      performance.now() - startedAt,
    )}ms`,
  );
}

function getStatusLabel(status: BackupValidationStatus) {
  switch (status) {
    case "valid":
      return "可恢复";
    case "invalid":
      return "损坏不可恢复";
    case "validating":
      return "校验中";
    case "unknown":
    default:
      return "待校验";
  }
}

export function SettingsWorkspace({
  startupNotice,
  beforeRestoreBackup,
}: SettingsWorkspaceProps) {
  const themeContext = useContext(ThemeContext);

  if (!themeContext) {
    throw new Error("ThemeContext 未初始化");
  }

  const { theme, setTheme } = themeContext;

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [environmentInfo, setEnvironmentInfo] = useState<DataEnvironmentInfo | null>(
    null,
  );
  const [backups, setBackups] = useState<BackupListItem[]>([]);
  const [isLoadingBackups, setIsLoadingBackups] = useState(true);
  const [isInitializing, setIsInitializing] = useState(true);
  const [operationState, setOperationState] =
    useState<BackupOperationState>("idle");
  const [notice, setNotice] = useState<SettingsNotice | null>(startupNotice);
  const [confirmRestoreFileName, setConfirmRestoreFileName] = useState<
    string | null
  >(null);
  const backupsRef = useRef<BackupListItem[]>([]);
  const latestBackupRefreshRequestRef = useRef(0);
  const backupValidationSessionRef = useRef(0);
  const isBusyRef = useRef(false);
  const isMountedRef = useRef(true);

  const isBusy = operationState !== "idle";

  const backupSummary = useMemo(() => {
    const validCount = backups.filter(
      (item) => item.validationStatus === "valid",
    ).length;
    const unknownCount = backups.filter(
      (item) =>
        item.validationStatus === "unknown" ||
        item.validationStatus === "validating",
    ).length;
    const invalidCount = backups.filter(
      (item) => item.validationStatus === "invalid",
    ).length;

    return {
      total: backups.length,
      validCount,
      unknownCount,
      invalidCount,
    };
  }, [backups]);

  useEffect(() => {
    setNotice(startupNotice);
  }, [startupNotice]);

  useEffect(() => {
    backupsRef.current = backups;
  }, [backups]);

  useEffect(() => {
    isBusyRef.current = isBusy;

    if (isBusy) {
      backupValidationSessionRef.current += 1;
      setBackups((currentBackups) => {
        const nextBackups = currentBackups.map((item) =>
          item.validationStatus === "validating"
            ? { ...item, validationStatus: "unknown" as const }
            : item,
        );
        backupsRef.current = nextBackups;
        return nextBackups;
      });
    }
  }, [isBusy]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setIsInitializing(true);
      setIsLoadingBackups(true);

      try {
        const [loadedSettings, loadedEnvironmentInfo] = await Promise.all([
          loadAppSettings(),
          getDataEnvironmentInfo(),
        ]);

        if (cancelled) {
          return;
        }

        setSettings(loadedSettings);
        setEnvironmentInfo(loadedEnvironmentInfo);
        void refreshBackups("initial-load").catch((error) => {
          if (cancelled) {
            return;
          }

          setNotice(
            buildNotice(
              "error",
              getErrorMessage(error, "读取备份列表失败，请稍后重试。"),
            ),
          );
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setNotice(
          buildNotice(
            "error",
            getErrorMessage(error, "读取设置与备份信息失败，请稍后重试。"),
          ),
        );
      } finally {
        if (!cancelled) {
          setIsInitializing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      isMountedRef.current = false;
      latestBackupRefreshRequestRef.current += 1;
      backupValidationSessionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    setSettings((currentSettings) =>
      currentSettings && currentSettings.theme !== theme
        ? { ...currentSettings, theme }
        : currentSettings,
    );
  }, [theme]);

  async function fetchBackups(reason: BackupRefreshReason) {
    const requestId = latestBackupRefreshRequestRef.current + 1;
    latestBackupRefreshRequestRef.current = requestId;
    const startedAt = logBackupRefreshStart(reason);

    try {
      return {
        requestId,
        items: sortBackups(await listBackups()),
      };
    } finally {
      logBackupRefreshComplete(reason, startedAt);
    }
  }

  function shouldApplyBackupRefresh(requestId: number) {
    return latestBackupRefreshRequestRef.current === requestId;
  }

  function shouldApplyValidationResult(requestId: number, sessionId: number) {
    return (
      isMountedRef.current &&
      !isBusyRef.current &&
      shouldApplyBackupRefresh(requestId) &&
      backupValidationSessionRef.current === sessionId
    );
  }

  function applyBackupRefreshResult(result: {
    requestId: number;
    items: BackupListItem[];
  }) {
    if (!shouldApplyBackupRefresh(result.requestId)) {
      return;
    }

    const mergedItems = mergeBackupLists(backupsRef.current, result.items);
    backupsRef.current = mergedItems;
    setBackups(mergedItems);
    setIsLoadingBackups(false);
    startBackgroundValidation(result.requestId, mergedItems);
  }

  async function refreshBackups(reason: BackupRefreshReason) {
    backupValidationSessionRef.current += 1;
    setBackups((currentBackups) => {
      const nextBackups = currentBackups.map((item) =>
        item.validationStatus === "validating"
          ? { ...item, validationStatus: "unknown" as const }
          : item,
      );
      backupsRef.current = nextBackups;
      return nextBackups;
    });
    setIsLoadingBackups(true);

    try {
      const result = await fetchBackups(reason);
      applyBackupRefreshResult(result);
      return result;
    } catch (error) {
      setIsLoadingBackups(false);
      throw error;
    }
  }

  function updateBackupItem(
    fileName: string,
    updater: (item: BackupListItem) => BackupListItem,
  ) {
    setBackups((currentBackups) => {
      const nextBackups = currentBackups.map((item) =>
        item.fileName === fileName ? updater(item) : item,
      );
      backupsRef.current = nextBackups;
      return nextBackups;
    });
  }

  function applyValidatedBackupItem(validatedItem: BackupListItem) {
    setBackups((currentBackups) => {
      const nextBackups = sortBackups(
        currentBackups.map((item) =>
          item.fileName === validatedItem.fileName ? validatedItem : item,
        ),
      );
      backupsRef.current = nextBackups;
      return nextBackups;
    });
  }

  function startBackgroundValidation(
    requestId: number,
    currentBackups: BackupListItem[],
  ) {
    if (isBusyRef.current) {
      return;
    }

    const targets = currentBackups
      .filter((item) => item.validationStatus === "unknown")
      .slice(0, BACKGROUND_VALIDATION_LIMIT)
      .map((item) => item.fileName);

    if (targets.length === 0) {
      return;
    }

    const sessionId = backupValidationSessionRef.current + 1;
    backupValidationSessionRef.current = sessionId;

    void (async () => {
      for (const fileName of targets) {
        if (!shouldApplyValidationResult(requestId, sessionId)) {
          return;
        }

        updateBackupItem(fileName, (item) =>
          item.validationStatus === "unknown"
            ? {
                ...item,
                validationStatus: "validating" as const,
                invalidReason: null,
              }
            : item,
        );

        try {
          const validatedItem = await validateBackup(fileName);

          if (!shouldApplyValidationResult(requestId, sessionId)) {
            return;
          }

          applyValidatedBackupItem(validatedItem);
        } catch (error) {
          if (!shouldApplyValidationResult(requestId, sessionId)) {
            return;
          }

          console.error("[settings] 后台校验备份失败", { fileName, error });
          updateBackupItem(fileName, (item) =>
            item.validationStatus === "validating"
              ? { ...item, validationStatus: "unknown" as const }
              : item,
          );
        }
      }
    })();
  }

  async function validateSingleBackup(
    fileName: string,
    source: BackupValidationSource,
  ) {
    const requestId = latestBackupRefreshRequestRef.current;
    const sessionId = backupValidationSessionRef.current;
    updateBackupItem(fileName, (item) => ({
      ...item,
      validationStatus: "validating" as const,
      invalidReason: null,
    }));

    try {
      const validatedItem = await validateBackup(fileName);

      if (!shouldApplyValidationResult(requestId, sessionId)) {
        return null;
      }

      applyValidatedBackupItem(validatedItem);

      if (
        source !== "background" &&
        validatedItem.validationStatus === "invalid" &&
        validatedItem.invalidReason
      ) {
        setNotice(buildNotice("error", validatedItem.invalidReason));
      }

      return validatedItem;
    } catch (error) {
      if (!shouldApplyValidationResult(requestId, sessionId)) {
        return null;
      }

      updateBackupItem(fileName, (item) => ({
        ...item,
        validationStatus: "unknown" as const,
      }));

      if (source !== "background") {
        setNotice(
          buildNotice(
            "error",
            getErrorMessage(error, "校验备份失败，请稍后重试。"),
          ),
        );
      }

      return null;
    }
  }

  async function handleAutoBackupToggle(enabled: boolean) {
    if (!settings) {
      return;
    }

    try {
      const nextSettings = await saveAppSettings({
        autoBackupEnabled: enabled,
      });
      setSettings(nextSettings);
      setNotice(
        buildNotice(
          "info",
          enabled ? "已开启自动备份。" : "已关闭自动备份。",
        ),
      );
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "更新自动备份设置失败，请稍后重试。"),
        ),
      );
    }
  }

  async function handleRetentionChange(value: (typeof RETENTION_OPTIONS)[number]) {
    if (!settings) {
      return;
    }

    try {
      const nextSettings = await saveAppSettings({
        backupRetentionCount: value,
      });
      setSettings(nextSettings);
      setNotice(buildNotice("info", `自动备份保留份数已更新为 ${value} 份。`));
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "更新备份保留策略失败，请稍后重试。"),
        ),
      );
    }
  }

  async function handleThemeChange(nextTheme: AppSettings["theme"]) {
    setTheme(nextTheme);
    setSettings((currentSettings) =>
      currentSettings ? { ...currentSettings, theme: nextTheme } : currentSettings,
    );
  }

  async function handleCreateBackup() {
    setOperationState("creating");
    setConfirmRestoreFileName(null);
    setNotice(buildNotice("info", "正在创建本地备份，请稍候…"));

    try {
      const result = await createBackup();
      setBackups((currentBackups) => {
        const nextBackups = insertBackupItem(currentBackups, result.backup);
        backupsRef.current = nextBackups;
        return nextBackups;
      });

      setNotice(
        buildNotice(
          result.warning ? "warning" : "info",
          result.warning
            ? `备份已创建，但清理旧备份时出现提示：${result.warning}`
            : `备份已创建：${result.backup.fileName}`,
        ),
      );

      void (async () => {
        try {
          await refreshBackups("post-create");
        } catch (error) {
          console.error("[settings] 后台刷新备份列表失败", error);
        }
      })();
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "创建本地备份失败，请稍后重试。"),
        ),
      );
    } finally {
      setOperationState("idle");
    }
  }

  async function handleValidateBackup(fileName: string) {
    setConfirmRestoreFileName((currentFileName) =>
      currentFileName === fileName ? null : currentFileName,
    );
    await validateSingleBackup(fileName, "manual");
  }

  async function handlePrepareRestore(backup: BackupListItem) {
    if (backup.validationStatus === "valid") {
      setConfirmRestoreFileName(backup.fileName);
      return;
    }

    if (backup.validationStatus === "validating") {
      return;
    }

    const validatedItem = await validateSingleBackup(backup.fileName, "restore");

    if (validatedItem?.validationStatus === "valid") {
      setConfirmRestoreFileName(validatedItem.fileName);
      return;
    }

    setConfirmRestoreFileName(null);
  }

  async function handleRebuildSearchIndex() {
    setOperationState("rebuildingSearch");
    setConfirmRestoreFileName(null);
    setNotice(buildNotice("info", "正在重建搜索索引，请稍候…"));

    try {
      await rebuildSearchIndex();
      setNotice(buildNotice("info", "搜索索引已重建完成。"));
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "重建搜索索引失败，请稍后重试。"),
        ),
      );
    } finally {
      setOperationState("idle");
    }
  }

  async function handleRestoreBackup(fileName: string) {
    try {
      const canRestore = await beforeRestoreBackup();

      if (!canRestore) {
        setNotice(buildNotice("error", RESTORE_BLOCKED_MESSAGE));
        return;
      }
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, RESTORE_BLOCKED_MESSAGE),
        ),
      );
      return;
    }

    setOperationState("restoring");
    setConfirmRestoreFileName(null);
    setNotice(
      buildNotice(
        "warning",
        "正在恢复备份并重新加载应用，请勿关闭窗口…",
      ),
    );

    try {
      await closeNotebookDatabase();
      await restoreBackup(fileName);
      setNotice(buildNotice("info", "恢复成功，正在重新加载应用…"));
      window.setTimeout(() => {
        window.location.reload();
      }, 280);
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "恢复备份失败，请稍后重试。"),
        ),
      );
      setOperationState("idle");
    }
  }

  if (isInitializing && !settings && !environmentInfo) {
    return (
      <section className={styles.workspace}>
        <div className={styles.panel}>
          <p className={styles.loadingText}>正在加载本地设置与备份信息…</p>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.workspace}>
      {notice ? (
        <div
          className={`${styles.notice} ${
            notice.tone === "error"
              ? styles.noticeError
              : notice.tone === "warning"
                ? styles.noticeWarning
                : styles.noticeInfo
          }`}
        >
          <strong className={styles.noticeTitle}>
            {notice.tone === "error"
              ? "操作失败"
              : notice.tone === "warning"
                ? "状态提示"
                : "操作提示"}
          </strong>
          <span>{notice.message}</span>
        </div>
      ) : null}

      <section className={styles.panel}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>外观设置</h3>
            <p className={styles.sectionDescription}>
              主题切换现在会持久化到本地设置文件，刷新应用后仍会保持当前配色。
            </p>
          </div>
          <span className={styles.metaText}>
            当前主题：{
              themeOptions.find((option) => option.name === theme)?.label ?? "蓝白主题"
            }
          </span>
        </div>

        <div className={styles.themeGrid}>
          {themeOptions.map((option) => {
            const previewStyle = {
              "--preview-rail": option.preview.rail,
              "--preview-accent": option.preview.accent,
              "--preview-background": option.preview.background,
              "--preview-surface": option.preview.surface,
            } as CSSProperties;

            return (
              <button
                key={option.name}
                type="button"
                className={`${styles.themeButton} ${
                  theme === option.name ? styles.themeButtonActive : ""
                }`}
                disabled={isBusy}
                onClick={() => void handleThemeChange(option.name)}
              >
                <div className={styles.themeMeta}>
                  <p className={styles.themeLabel}>{option.label}</p>
                  <p className={styles.themeDescription}>{option.description}</p>
                </div>
                <div className={styles.themePreview} style={previewStyle}>
                  <div className={styles.themePreviewRail} />
                  <div className={styles.themePreviewContent}>
                    <div className={styles.themePreviewLine} />
                    <div
                      className={`${styles.themePreviewLine} ${styles.themePreviewLineShort}`}
                    />
                    <div className={styles.themePreviewCard} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <div className={styles.grid}>
        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div>
              <h3 className={styles.sectionTitle}>数据与目录</h3>
              <p className={styles.sectionDescription}>
                当前阶段会显示应用数据目录、数据库文件、设置文件、资源目录和备份目录。
              </p>
            </div>
            {environmentInfo ? (
              <span className={styles.metaText}>
                当前版本：{environmentInfo.appVersion}
              </span>
            ) : null}
          </div>

          <dl className={styles.pathList}>
            <div className={styles.pathRow}>
              <dt>数据目录</dt>
              <dd>{environmentInfo?.dataDir ?? "读取失败"}</dd>
            </div>
            <div className={styles.pathRow}>
              <dt>数据库文件</dt>
              <dd>{environmentInfo?.databasePath ?? "读取失败"}</dd>
            </div>
            <div className={styles.pathRow}>
              <dt>设置文件</dt>
              <dd>{environmentInfo?.settingsPath ?? "读取失败"}</dd>
            </div>
            <div className={styles.pathRow}>
              <dt>资源目录</dt>
              <dd>{environmentInfo?.resourcesDir ?? "读取失败"}</dd>
            </div>
            <div className={styles.pathRow}>
              <dt>备份目录</dt>
              <dd>{environmentInfo?.backupsDir ?? "读取失败"}</dd>
            </div>
          </dl>
        </section>

        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div>
              <h3 className={styles.sectionTitle}>备份策略</h3>
              <p className={styles.sectionDescription}>
                自动备份采用应用启动时按本地日期检查的最小策略。当天已执行则不会重复触发。
              </p>
            </div>
            <span className={styles.metaText}>
              最近自动备份：{formatDateLabel(settings?.lastAutoBackupDate ?? null)}
            </span>
          </div>

          <div className={styles.controlGroup}>
            <label className={styles.toggleRow}>
              <div>
                <span className={styles.controlLabel}>自动备份</span>
                <span className={styles.controlHint}>
                  开启后，应用启动时若今天还未自动备份，将自动创建一份备份。
                </span>
              </div>
              <input
                type="checkbox"
                checked={settings?.autoBackupEnabled ?? false}
                disabled={isBusy || !settings}
                onChange={(event) =>
                  void handleAutoBackupToggle(event.currentTarget.checked)
                }
              />
            </label>

            <label className={styles.selectRow}>
              <span className={styles.controlLabel}>保留份数</span>
              <select
                value={settings?.backupRetentionCount ?? 5}
                disabled={isBusy || !settings}
                onChange={(event) =>
                  void handleRetentionChange(
                    Number(event.currentTarget.value) as (typeof RETENTION_OPTIONS)[number],
                  )
                }
              >
                {RETENTION_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    保留 {option} 份
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className={styles.primaryButton}
              disabled={isBusy || !settings}
              onClick={() => void handleCreateBackup()}
            >
              {operationState === "creating" ? "备份中…" : "立即创建备份"}
            </button>

            <button
              type="button"
              className={styles.secondaryButton}
              disabled={isBusy || !settings}
              onClick={() => void handleRebuildSearchIndex()}
            >
              {operationState === "rebuildingSearch"
                ? "重建中…"
                : "手动重建搜索索引"}
            </button>
          </div>
        </section>
      </div>

      <section className={styles.panel}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>备份列表</h3>
            <p className={styles.sectionDescription}>
              备份列表首开优先显示目录基础信息；严格校验会在单项操作或首屏前几项后台补校验时进行。
            </p>
          </div>
          <span className={styles.metaText}>
            共 {backupSummary.total} 份，{backupSummary.validCount} 份可恢复，
            {backupSummary.unknownCount} 份待校验
            {backupSummary.invalidCount > 0
              ? `，${backupSummary.invalidCount} 份损坏`
              : ""}
          </span>
        </div>

        {isLoadingBackups && backups.length === 0 ? (
          <p className={styles.loadingText}>正在读取备份列表…</p>
        ) : backups.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>还没有本地备份</strong>
            <span>点击“立即创建备份”后，这里会显示可恢复的备份列表。</span>
          </div>
        ) : (
          <div className={styles.backupList}>
            {backups.map((backup) => {
              const isConfirming = confirmRestoreFileName === backup.fileName;
              const isValid = backup.validationStatus === "valid";
              const isInvalid = backup.validationStatus === "invalid";
              const isValidating = backup.validationStatus === "validating";
              const canRestore = isValid;
              const canValidate =
                !isBusy &&
                (backup.validationStatus === "unknown" ||
                  backup.validationStatus === "invalid");
              const statusClassName =
                backup.validationStatus === "valid"
                  ? styles.statusValid
                  : backup.validationStatus === "invalid"
                    ? styles.statusInvalid
                    : backup.validationStatus === "validating"
                      ? styles.statusValidating
                      : styles.statusUnknown;

              return (
                <article
                  key={backup.fileName}
                  className={`${styles.backupItem} ${
                    isInvalid ? styles.backupItemInvalid : ""
                  }`}
                >
                  <div className={styles.backupMeta}>
                    <div className={styles.backupTitleRow}>
                      <strong className={styles.backupName}>{backup.fileName}</strong>
                      <span className={`${styles.statusBadge} ${statusClassName}`}>
                        {getStatusLabel(backup.validationStatus)}
                      </span>
                    </div>

                    <div className={styles.backupInfoRow}>
                      <span>创建时间：{backup.createdAt}</span>
                      <span>文件大小：{formatBytes(backup.sizeBytes)}</span>
                    </div>

                    {backup.note ? (
                      <p className={styles.backupNote}>备注：{backup.note}</p>
                    ) : null}

                    {backup.invalidReason ? (
                      <p className={styles.backupError}>{backup.invalidReason}</p>
                    ) : null}

                    {isConfirming ? (
                      <div className={styles.restoreWarning}>
                        <p>
                          恢复会覆盖当前本地数据。建议先手动备份当前状态，再继续恢复。
                        </p>
                        <div className={styles.actionRow}>
                          <button
                            type="button"
                            className={styles.dangerButton}
                            disabled={isBusy}
                            onClick={() => void handleRestoreBackup(backup.fileName)}
                          >
                            {operationState === "restoring" ? "恢复中…" : "确认恢复"}
                          </button>
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            disabled={isBusy}
                            onClick={() => setConfirmRestoreFileName(null)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className={styles.actionRow}>
                        {backup.validationStatus === "unknown" ? (
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            disabled={!canValidate}
                            onClick={() => void handleValidateBackup(backup.fileName)}
                          >
                            校验备份
                          </button>
                        ) : backup.validationStatus === "invalid" ? (
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            disabled={!canValidate}
                            onClick={() => void handleValidateBackup(backup.fileName)}
                          >
                            重新校验
                          </button>
                        ) : backup.validationStatus === "validating" ? (
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            disabled
                          >
                            校验中…
                          </button>
                        ) : null}

                        <button
                          type="button"
                          className={styles.secondaryButton}
                          disabled={isBusy || isInvalid || isValidating}
                          onClick={() => void handlePrepareRestore(backup)}
                        >
                          {canRestore ? "恢复备份" : "校验后恢复"}
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}

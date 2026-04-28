import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { closeNotebookDatabase } from "../notebooks/db";
import { ThemeContext } from "../theme/ThemeProvider";
import { themeOptions } from "../theme/themeOptions";
import {
  DEFAULT_EDITOR_FONT_FAMILY,
  EDITOR_FONT_FAMILY_OPTIONS,
  NOTE_EDITOR_PREVIEW_HTML,
  applyEditorFontFamilyPreference,
  getEditorFontFamilyStack,
  type EditorFontFamilyName,
} from "../notebooks/editorTypography";
import editorSurfaceStyles from "../notebooks/NoteEditorSurface.module.css";
import {
  createBackup,
  deleteBackup,
  getDataEnvironmentInfo,
  listBackups,
  loadAppSettings,
  openBackupsDirectory,
  openDataDirectory,
  previewRestoreBackup,
  restoreBackup,
  saveAppSettings,
  selectRestoreBackupFile,
} from "./commands";
import type {
  AppSettings,
  BackupListItem,
  BackupOperationState,
  DataEnvironmentInfo,
  RestoreBackupPreview,
  RestoreProgressEvent,
  RestoreProgressStage,
  SettingsNotice,
} from "./types";
import styles from "./SettingsWorkspace.module.css";

const RETENTION_OPTIONS = [1, 3, 5] as const;
const BACKUP_FREQUENCY_OPTIONS = [1, 3, 5, 7] as const;
const RESTORE_BLOCKED_MESSAGE =
  "恢复备份前保存失败，已阻止恢复操作。请先等待保存完成，或复制内容后再操作。";
type BackupRefreshReason = "initial-load" | "post-create";

type RestoreDialogState =
  | {
      status: "confirm";
      preview: RestoreBackupPreview;
    }
  | {
      status: "progress";
      percent: number;
    }
  | {
      status: "error";
      message: string;
    };

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

function getRestoreProgressPercent(stage: RestoreProgressStage) {
  switch (stage) {
    case "reading-backup-info":
      return 10;
    case "checking-backup-format":
      return 20;
    case "extracting-backup":
      return 45;
    case "checking-database":
      return 65;
    case "replacing-local-data":
      return 85;
    case "reloading":
      return 95;
    case "completed":
      return 100;
    default:
      return 0;
  }
}

function getRestoreCreatedAt(preview: RestoreBackupPreview) {
  return preview.createdAt.trim() || "未知时间";
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
  const [isRefreshingStorage, setIsRefreshingStorage] = useState(false);
  const [operationState, setOperationState] =
    useState<BackupOperationState>("idle");
  const [notice, setNotice] = useState<SettingsNotice | null>(startupNotice);
  const [restoreDialog, setRestoreDialog] =
    useState<RestoreDialogState | null>(null);
  const [deleteDialogFileName, setDeleteDialogFileName] = useState<string | null>(
    null,
  );
  const backupsRef = useRef<BackupListItem[]>([]);
  const latestBackupRefreshRequestRef = useRef(0);
  const isMountedRef = useRef(true);

  const isBusy = operationState !== "idle";

  const selectedEditorFontFamily =
    settings?.editorFontFamily ?? DEFAULT_EDITOR_FONT_FAMILY;

  const editorPreviewStyle = useMemo(
    () =>
      ({
        "--editor-font-size": "15px",
        "--editor-font-family": getEditorFontFamilyStack(selectedEditorFontFamily),
        "--editor-top-padding": "14px",
        "--editor-bottom-padding": "16px",
        "--editor-inline-padding": "18px",
        "--editor-reading-width": "560px",
        "--editor-shell-max-width": "620px",
      }) as CSSProperties,
    [selectedEditorFontFamily],
  );

  useEffect(() => {
    setNotice(startupNotice);
  }, [startupNotice]);

  useEffect(() => {
    backupsRef.current = backups;
  }, [backups]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void listen<RestoreProgressEvent>(
      "backup-restore-progress",
      (event) => {
        if (!isMountedRef.current) {
          return;
        }

        const nextPercent = getRestoreProgressPercent(event.payload.stage);
        setRestoreDialog((currentDialog) =>
          currentDialog?.status === "progress"
            ? {
                ...currentDialog,
                percent: Math.max(currentDialog.percent, nextPercent),
              }
            : currentDialog,
        );
      },
    ).then((nextUnlisten) => {
      if (cancelled) {
        nextUnlisten();
        return;
      }

      unlisten = nextUnlisten;
    });

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

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

  function applyBackupRefreshResult(result: {
    requestId: number;
    items: BackupListItem[];
  }) {
    if (!shouldApplyBackupRefresh(result.requestId)) {
      return;
    }

    backupsRef.current = result.items;
    setBackups(result.items);
    setIsLoadingBackups(false);
  }

  async function refreshBackups(reason: BackupRefreshReason) {
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

  async function refreshStorageInfo(showNotice = true) {
    setIsRefreshingStorage(true);

    try {
      const nextEnvironmentInfo = await getDataEnvironmentInfo();
      setEnvironmentInfo(nextEnvironmentInfo);
      if (showNotice) {
        setNotice(buildNotice("info", "存储信息已刷新。"));
      }
      return nextEnvironmentInfo;
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "刷新存储信息失败，请稍后重试。"),
        ),
      );
      return null;
    } finally {
      setIsRefreshingStorage(false);
    }
  }

  async function handleOpenDataDirectory() {
    try {
      await openDataDirectory();
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "打开数据目录失败，请稍后重试。"),
        ),
      );
    }
  }

  async function handleOpenBackupsDirectory() {
    try {
      await openBackupsDirectory();
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "打开备份目录失败，请稍后重试。"),
        ),
      );
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
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "更新自动备份设置失败，请稍后重试。"),
        ),
      );
    }
  }

  async function handleBackupFrequencyChange(
    value: (typeof BACKUP_FREQUENCY_OPTIONS)[number],
  ) {
    if (!settings) {
      return;
    }

    try {
      const nextSettings = await saveAppSettings({
        backupFrequencyDays: value,
      });
      setSettings(nextSettings);
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "更新自动备份频率失败，请稍后重试。"),
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
      await refreshBackups("initial-load");
      await refreshStorageInfo(false);
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

  async function handleEditorFontFamilyChange(
    nextFontFamily: EditorFontFamilyName,
  ) {
    try {
      const nextSettings = await saveAppSettings({
        editorFontFamily: nextFontFamily,
      });
      applyEditorFontFamilyPreference(nextSettings.editorFontFamily);
      setSettings(nextSettings);
      setNotice(buildNotice("info", `编辑器字体已切换为“${
        EDITOR_FONT_FAMILY_OPTIONS.find(
          (option) => option.value === nextSettings.editorFontFamily,
        )?.label ?? "现代无衬线"
      }”。`));
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "更新编辑器字体失败，请稍后重试。"),
        ),
      );
    }
  }

  async function handleCreateBackup() {
    setOperationState("creating");
    setNotice(buildNotice("info", "正在创建本地备份，请稍候…"));

    try {
      const result = await createBackup();
      setBackups((currentBackups) => {
        const nextBackups = insertBackupItem(currentBackups, result.backup);
        backupsRef.current = nextBackups;
        return nextBackups;
      });
      setNotice(result.warning ? buildNotice("warning", result.warning) : null);
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "创建本地备份失败，请稍后重试。"),
        ),
      );
      return;
    } finally {
      setOperationState("idle");
    }

    try {
      await refreshBackups("post-create");
      await refreshStorageInfo(false);
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "刷新备份列表失败，请稍后重试。"),
        ),
      );
    }
  }

  function getListedBackupPath(fileName: string) {
    if (!environmentInfo) {
      return null;
    }

    const normalizedBackupsDir = environmentInfo.backupsDir.replace(/[\\/]+$/, "");
    const separator =
      environmentInfo.backupsDir.includes("\\") &&
      !environmentInfo.backupsDir.includes("/")
        ? "\\"
        : "/";

    return `${normalizedBackupsDir}${separator}${fileName}`;
  }

  async function openRestorePreview(backupPath: string) {
    setRestoreDialog(null);
    setNotice(buildNotice("info", "正在读取备份信息…"));

    try {
      const preview = await previewRestoreBackup(backupPath);
      setRestoreDialog({ status: "confirm", preview });
      setNotice(null);
    } catch (error) {
      setRestoreDialog(null);
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "读取备份信息失败，请选择其他备份。"),
        ),
      );
    }
  }

  async function handleSelectRestoreBackup() {
    if (isBusy) {
      return;
    }

    setRestoreDialog(null);

    try {
      const result = await selectRestoreBackupFile();
      if (result.status === "cancelled") {
        return;
      }

      await openRestorePreview(result.backupPath);
    } catch (error) {
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "选择备份文件失败，请稍后重试。"),
        ),
      );
    }
  }

  async function handlePrepareRestore(backup: BackupListItem) {
    const backupPath = getListedBackupPath(backup.fileName);
    if (!backupPath) {
      setNotice(buildNotice("error", "读取备份目录失败，请稍后重试。"));
      return;
    }

    await openRestorePreview(backupPath);
  }

  function handleRequestDeleteBackup(fileName: string) {
    if (isBusy) {
      return;
    }

    setDeleteDialogFileName(fileName);
  }

  function handleCloseDeleteDialog() {
    if (operationState !== "deleting") {
      setDeleteDialogFileName(null);
    }
  }

  async function handleConfirmDeleteBackup() {
    if (!deleteDialogFileName || isBusy) {
      return;
    }

    const fileName = deleteDialogFileName;
    setOperationState("deleting");
    setNotice(null);

    try {
      await deleteBackup(fileName);
      setDeleteDialogFileName(null);
      await refreshBackups("initial-load");
      await refreshStorageInfo(false);
    } catch (error) {
      setDeleteDialogFileName(null);
      setNotice(
        buildNotice(
          "error",
          getErrorMessage(error, "删除备份文件失败，请稍后重试。"),
        ),
      );
    } finally {
      setOperationState("idle");
    }
  }

  async function handleRestoreBackup() {
    if (restoreDialog?.status !== "confirm") {
      return;
    }

    const backupPath = restoreDialog.preview.backupPath;
    setOperationState("restoring");
    setRestoreDialog({ status: "progress", percent: 10 });
    setNotice(null);

    try {
      const canRestore = await beforeRestoreBackup();

      if (!canRestore) {
        setRestoreDialog({ status: "error", message: RESTORE_BLOCKED_MESSAGE });
        setOperationState("idle");
        return;
      }
    } catch (error) {
      setRestoreDialog({
        status: "error",
        message: getErrorMessage(error, RESTORE_BLOCKED_MESSAGE),
      });
      setOperationState("idle");
      return;
    }

    try {
      await closeNotebookDatabase();
      await restoreBackup(backupPath);
      setRestoreDialog((currentDialog) =>
        currentDialog?.status === "progress"
          ? { ...currentDialog, percent: Math.max(currentDialog.percent, 95) }
          : currentDialog,
      );
      window.setTimeout(() => {
        setRestoreDialog({ status: "progress", percent: 100 });
        window.setTimeout(() => {
          setRestoreDialog(null);
          window.location.reload();
        }, 180);
      }, 180);
    } catch (error) {
      setRestoreDialog({
        status: "error",
        message: getErrorMessage(error, "恢复备份失败，请稍后重试。"),
      });
      setOperationState("idle");
    }
  }

  function handleCloseRestoreDialog() {
    setRestoreDialog((currentDialog) =>
      currentDialog?.status === "progress" ? currentDialog : null,
    );
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

        <section className={styles.typographyPanel}>
          <div className={styles.typographyHeader}>
            <div>
              <h4 className={styles.typographyTitle}>编辑器排版</h4>
              <p className={styles.typographyDescription}>
                字体族偏好会同步作用于正式编辑区和下方预览样本，方便直接比对中文正文的松紧、行长和段距。
              </p>
            </div>
            <span className={styles.metaText}>
              当前字体：{
                EDITOR_FONT_FAMILY_OPTIONS.find(
                  (option) => option.value === selectedEditorFontFamily,
                )?.label ?? "现代无衬线"
              }
            </span>
          </div>

          <div className={styles.fontFamilyGrid}>
            {EDITOR_FONT_FAMILY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`${styles.fontFamilyButton} ${
                  selectedEditorFontFamily === option.value
                    ? styles.fontFamilyButtonActive
                    : ""
                }`}
                disabled={isBusy || !settings}
                onClick={() => void handleEditorFontFamilyChange(option.value)}
                style={{ fontFamily: getEditorFontFamilyStack(option.value) }}
              >
                <span className={styles.fontFamilyLabel}>{option.label}</span>
              </button>
            ))}
          </div>

          <div className={styles.editorPreviewShell}>
            <div
              className={editorSurfaceStyles.editorDocument}
              style={editorPreviewStyle}
              dangerouslySetInnerHTML={{ __html: NOTE_EDITOR_PREVIEW_HTML }}
            />
          </div>
        </section>
      </section>

      <div className={styles.grid}>
        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div>
              <h3 className={styles.sectionTitle}>存储管理</h3>
              <p className={styles.sectionDescription}>
                备份文件保存在 macOS 文稿中，方便你手动复制、迁移或长期保存。
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
              <dd>
                <span className={styles.pathDisplayName}>文稿 / 本地笔记备份</span>
                <span className={styles.pathHint}>
                  {environmentInfo?.backupsDir ?? "读取失败"}
                </span>
              </dd>
            </div>
          </dl>

          <div className={styles.storageStats}>
            <div className={styles.storageStat}>
              <span>数据库大小</span>
              <strong>
                {formatBytes(environmentInfo?.databaseSizeBytes ?? 0)}
              </strong>
            </div>
            <div className={styles.storageStat}>
              <span>图片资源大小</span>
              <strong>
                {formatBytes(environmentInfo?.resourcesSizeBytes ?? 0)}
              </strong>
            </div>
            <div className={styles.storageStat}>
              <span>备份大小</span>
              <strong>{formatBytes(environmentInfo?.backupsSizeBytes ?? 0)}</strong>
            </div>
            <div className={styles.storageStat}>
              <span>缓存大小</span>
              <strong>{formatBytes(environmentInfo?.cacheSizeBytes ?? 0)}</strong>
            </div>
          </div>

          <div className={styles.storageActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={isBusy || !environmentInfo}
              onClick={() => void handleOpenDataDirectory()}
            >
              打开数据目录
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={isBusy || !environmentInfo}
              onClick={() => void handleOpenBackupsDirectory()}
            >
              打开备份目录
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={isRefreshingStorage}
              onClick={() => void refreshStorageInfo()}
            >
              {isRefreshingStorage ? "刷新中…" : "刷新存储信息"}
            </button>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div>
              <h3 className={styles.sectionTitle}>备份策略</h3>
              <p className={styles.sectionDescription}>
                自动备份只在应用启动时检查一次，达到所选间隔才会创建新备份。
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
                  开启后，应用启动时会根据频率设置自动创建备份。
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
              <div>
                <span className={styles.controlLabel}>自动备份频率</span>
                <span className={styles.controlHint}>
                  仅在应用启动时检查，不会在后台定时运行。
                </span>
              </div>
              <select
                value={settings?.backupFrequencyDays ?? 1}
                disabled={isBusy || !settings}
                onChange={(event) =>
                  void handleBackupFrequencyChange(
                    Number(event.currentTarget.value) as (typeof BACKUP_FREQUENCY_OPTIONS)[number],
                  )
                }
              >
                {BACKUP_FREQUENCY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    每 {option} 天
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.selectRow}>
              <div>
                <span className={styles.controlLabel}>保留份数</span>
                <span className={styles.controlHint}>
                  保留份数会作用于所有备份文件，超过数量后会自动删除最旧备份。
                </span>
              </div>
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
          </div>
        </section>
      </div>

      <section className={styles.panel}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>备份列表</h3>
            <p className={styles.sectionDescription}>
              选择已有备份恢复，或在没有本地备份时选择外部备份文件恢复。
            </p>
          </div>
          <span className={styles.metaText}>共 {backups.length} 份</span>
        </div>

        {isLoadingBackups && backups.length === 0 ? (
          <p className={styles.loadingText}>正在读取备份列表…</p>
        ) : backups.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>还没有本地备份</strong>
            <span>点击“立即创建备份”后，这里会显示可恢复的备份列表。</span>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={isBusy || !settings}
              onClick={() => void handleSelectRestoreBackup()}
            >
              选择外部备份文件恢复
            </button>
          </div>
        ) : (
          <div className={styles.backupList}>
            {backups.map((backup) => (
              <article key={backup.fileName} className={styles.backupItem}>
                <div className={styles.backupMeta}>
                  <div className={styles.backupTitleRow}>
                    <strong className={styles.backupName}>{backup.fileName}</strong>
                  </div>

                  <div className={styles.backupInfoRow}>
                    <span>创建时间：{backup.createdAt}</span>
                    <span>文件大小：{formatBytes(backup.sizeBytes)}</span>
                  </div>

                  <div className={styles.actionRow}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={isBusy}
                      onClick={() => void handlePrepareRestore(backup)}
                    >
                      恢复备份
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={isBusy}
                      onClick={() => handleRequestDeleteBackup(backup.fileName)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {restoreDialog ? (
        <div className={styles.modalBackdrop} role="presentation">
          <section
            className={styles.restoreDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-dialog-title"
          >
            <div className={styles.restoreDialogHeader}>
              <h3 id="restore-dialog-title" className={styles.restoreDialogTitle}>
                {restoreDialog.status === "error" ? "恢复失败" : "恢复备份"}
              </h3>
              {restoreDialog.status === "confirm" ? (
                <p className={styles.restoreDialogDescription}>
                  数据备份于 {getRestoreCreatedAt(restoreDialog.preview)}。继续执行会用该备份
                  <span className={styles.restoreDangerText}>完全替换</span>
                  掉当前现有数据，是否确认恢复？
                </p>
              ) : restoreDialog.status === "progress" ? (
                <p className={styles.restoreDialogDescription}>
                  正在恢复，请勿关闭应用
                </p>
              ) : (
                <p className={styles.restoreDialogDescription}>
                  {restoreDialog.message}
                </p>
              )}
            </div>

            {restoreDialog.status === "progress" ? (
              <div
                className={styles.restoreProgressTrack}
                aria-label="恢复进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={restoreDialog.percent}
                role="progressbar"
              >
                <div
                  className={styles.restoreProgressBar}
                  style={
                    {
                      "--restore-progress": `${restoreDialog.percent}%`,
                    } as CSSProperties
                  }
                />
              </div>
            ) : null}

            {restoreDialog.status === "confirm" ? (
              <div className={styles.restoreDialogActions}>
                <button
                  type="button"
                  className={`${styles.dangerButton} ${styles.restoreDialogButton}`}
                  disabled={isBusy}
                  onClick={() => void handleRestoreBackup()}
                >
                  确认
                </button>
                <button
                  type="button"
                  className={`${styles.secondaryButton} ${styles.restoreDialogButton}`}
                  disabled={isBusy}
                  onClick={handleCloseRestoreDialog}
                >
                  取消
                </button>
              </div>
            ) : restoreDialog.status === "error" ? (
              <div className={styles.restoreDialogActions}>
                <button
                  type="button"
                  className={`${styles.secondaryButton} ${styles.restoreDialogButton}`}
                  onClick={handleCloseRestoreDialog}
                >
                  关闭
                </button>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {deleteDialogFileName ? (
        <div className={styles.modalBackdrop} role="presentation">
          <section
            className={styles.restoreDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-backup-dialog-title"
          >
            <div className={styles.restoreDialogHeader}>
              <h3 id="delete-backup-dialog-title" className={styles.restoreDialogTitle}>
                删除备份
              </h3>
              <p className={styles.restoreDialogDescription}>
                确认删除该备份文件？此操作不可恢复。
              </p>
              <p className={styles.deleteBackupFileName}>{deleteDialogFileName}</p>
            </div>

            <div className={styles.restoreDialogActions}>
              <button
                type="button"
                className={`${styles.dangerButton} ${styles.restoreDialogButton}`}
                disabled={operationState === "deleting"}
                onClick={() => void handleConfirmDeleteBackup()}
              >
                {operationState === "deleting" ? "删除中…" : "确认删除"}
              </button>
              <button
                type="button"
                className={`${styles.secondaryButton} ${styles.restoreDialogButton}`}
                disabled={operationState === "deleting"}
                onClick={handleCloseDeleteDialog}
              >
                取消
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

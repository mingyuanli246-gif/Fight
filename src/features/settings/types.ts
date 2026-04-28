import type { EditorFontFamilyName } from "../notebooks/editorTypography";
import type { ThemeName } from "../theme/types";

export interface AppSettings {
  theme: ThemeName;
  editorFontFamily: EditorFontFamilyName;
  autoBackupEnabled: boolean;
  backupFrequencyDays: 1 | 3 | 5 | 7;
  backupRetentionCount: 1 | 3 | 5;
  lastAutoBackupDate: string | null;
}

export interface AppSettingsUpdate {
  theme?: ThemeName;
  editorFontFamily?: EditorFontFamilyName;
  autoBackupEnabled?: boolean;
  backupFrequencyDays?: 1 | 3 | 5 | 7;
  backupRetentionCount?: 1 | 3 | 5;
}

export interface DataEnvironmentInfo {
  dataDir: string;
  databasePath: string;
  settingsPath: string;
  resourcesDir: string;
  backupsDir: string;
  legacyBackupsDir: string;
  cacheDir: string;
  logDir: string;
  tempDir: string;
  appVersion: string;
  databaseSizeBytes: number;
  resourcesSizeBytes: number;
  backupsSizeBytes: number;
  cacheSizeBytes: number;
  legacyBackupsSizeBytes: number;
}

export interface BackupManifest {
  formatVersion: number;
  schemaVersion?: number;
  appVersion: string;
  createdAt: string;
  databaseFile: string;
  resourceDirectory: string;
  settingsFile: string;
  note: string;
  noteCount?: number | null;
  resourceCount?: number | null;
}

export interface BackupListItem {
  fileName: string;
  createdAt: string;
  sizeBytes: number;
}

export interface CreateBackupResult {
  backup: BackupListItem;
  warning: string | null;
}

export interface RestoreBackupResult {
  restoredFileName: string;
}

export interface RestoreBackupPreview {
  backupPath: string;
  fileName: string;
  createdAt: string;
  appVersion: string;
  schemaVersion?: number | null;
  databaseFile: string;
  settingsFile: string;
  resourceDirectory: string;
  noteCount?: number | null;
  resourceCount?: number | null;
  note: string | null;
  sizeBytes: number;
}

export type SelectRestoreBackupFileResult =
  | {
      status: "selected";
      backupPath: string;
      fileName: string;
    }
  | {
      status: "cancelled";
    };

export type RestoreProgressStage =
  | "reading-backup-info"
  | "checking-backup-format"
  | "extracting-backup"
  | "checking-database"
  | "replacing-local-data"
  | "reloading"
  | "completed";

export interface RestoreProgressEvent {
  stage: RestoreProgressStage;
  message: string;
}

export interface AutoBackupResult {
  status:
    | "created"
    | "skipped-busy"
    | "skipped-disabled"
    | "skipped-already-ran"
    | "skipped-not-due"
    | "skipped-missing-database";
  backup: BackupListItem | null;
  warning: string | null;
}

export interface SettingsNotice {
  tone: "info" | "warning" | "error";
  message: string;
}

export type BackupOperationState =
  | "idle"
  | "creating"
  | "restoring"
  | "deleting";

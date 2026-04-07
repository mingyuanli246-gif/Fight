import type { ThemeName } from "../theme/types";

export interface AppSettings {
  theme: ThemeName;
  autoBackupEnabled: boolean;
  backupRetentionCount: 3 | 5 | 10;
  lastAutoBackupDate: string | null;
}

export interface AppSettingsUpdate {
  theme?: ThemeName;
  autoBackupEnabled?: boolean;
  backupRetentionCount?: 3 | 5 | 10;
}

export interface DataEnvironmentInfo {
  dataDir: string;
  databasePath: string;
  settingsPath: string;
  resourcesDir: string;
  backupsDir: string;
  appVersion: string;
}

export interface BackupManifest {
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  databaseFile: string;
  resourceDirectory: string;
  settingsFile: string;
  note: string;
}

export interface BackupListItem {
  fileName: string;
  createdAt: string;
  sizeBytes: number;
  isValid: boolean;
  invalidReason: string | null;
  note: string | null;
}

export interface CreateBackupResult {
  backup: BackupListItem;
  warning: string | null;
}

export interface RestoreBackupResult {
  restoredFileName: string;
}

export interface AutoBackupResult {
  status:
    | "created"
    | "skipped-busy"
    | "skipped-disabled"
    | "skipped-already-ran"
    | "skipped-missing-database";
  backup: BackupListItem | null;
  warning: string | null;
}

export interface SettingsNotice {
  tone: "info" | "warning" | "error";
  message: string;
}

export type BackupOperationState = "idle" | "creating" | "restoring";

import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  AppSettingsUpdate,
  AutoBackupResult,
  BackupListItem,
  CreateBackupResult,
  DataEnvironmentInfo,
  RestoreBackupPreview,
  RestoreBackupResult,
  SelectRestoreBackupFileResult,
} from "./types";

export async function loadAppSettings() {
  return invoke<AppSettings>("load_app_settings");
}

export async function saveAppSettings(update: AppSettingsUpdate) {
  return invoke<AppSettings>("save_app_settings", { update });
}

export async function getDataEnvironmentInfo() {
  return invoke<DataEnvironmentInfo>("get_data_environment_info");
}

export async function listBackups() {
  return invoke<BackupListItem[]>("list_backups");
}

export async function selectRestoreBackupFile() {
  return invoke<SelectRestoreBackupFileResult>("select_restore_backup_file");
}

export async function previewRestoreBackup(backupPath: string) {
  return invoke<RestoreBackupPreview>("preview_restore_backup", { backupPath });
}

export async function createBackup() {
  return invoke<CreateBackupResult>("create_backup");
}

export async function deleteBackup(fileName: string) {
  return invoke<void>("delete_backup", { fileName });
}

export async function maybeRunAutoBackup() {
  return invoke<AutoBackupResult>("maybe_run_auto_backup");
}

export async function restoreBackup(backupPath: string) {
  return invoke<RestoreBackupResult>("restore_backup", { backupPath });
}

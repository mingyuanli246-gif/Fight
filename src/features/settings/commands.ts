import { invoke } from "@tauri-apps/api/core";
import { rebuildNoteSearchIndex } from "../notebooks/repository";
import type {
  AppSettings,
  AppSettingsUpdate,
  AutoBackupResult,
  BackupListItem,
  CreateBackupResult,
  DataEnvironmentInfo,
  ManagedResourceCleanupResult,
  RestoreBackupResult,
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

export async function validateBackup(fileName: string) {
  return invoke<BackupListItem>("validate_backup", { fileName });
}

export async function createBackup() {
  return invoke<CreateBackupResult>("create_backup");
}

export async function maybeRunAutoBackup() {
  return invoke<AutoBackupResult>("maybe_run_auto_backup");
}

export async function restoreBackup(fileName: string) {
  return invoke<RestoreBackupResult>("restore_backup", { fileName });
}

export async function rebuildSearchIndex() {
  return rebuildNoteSearchIndex();
}

export async function cleanupUnreferencedManagedResources() {
  return invoke<ManagedResourceCleanupResult>(
    "cleanup_unreferenced_managed_resources",
  );
}

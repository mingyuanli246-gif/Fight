use chrono::{DateTime, Local, NaiveDate};
use rfd::FileDialog;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tempfile::{tempdir_in, NamedTempFile, TempDir};
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const DATABASE_FILE_NAME: &str = "fight-notes.db";
const SETTINGS_FILE_NAME: &str = "app-settings.json";
const RESOURCES_DIR_NAME: &str = "resources";
const BACKUPS_DIR_NAME: &str = "backups";
const DOCUMENT_BACKUPS_DIR_NAME: &str = "本地笔记备份";
const LEGACY_BACKUPS_CLEANUP_MARKER_FILE_NAME: &str = ".legacy-backups-cleanup-v1";
const APP_TEMP_DIR_NAME: &str = "com.lihongxia.fight";
const BACKUP_FILE_PREFIX: &str = "fight-notes-backup";
const RESTORE_PROGRESS_EVENT: &str = "backup-restore-progress";
const DOCUMENT_DIR_UNAVAILABLE_MESSAGE: &str = "无法读取文稿目录，暂时无法创建备份。";
const BACKUP_FORMAT_VERSION: u32 = 1;
const CURRENT_SCHEMA_VERSION: u32 = 7;
const STORED_RESOURCE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
const VALID_THEMES: &[&str] = &["blue", "pink", "red", "yellow"];
const VALID_EDITOR_FONT_FAMILIES: &[&str] = &[
    "modernSans",
    "elegantSerif",
    "systemDefault",
    "sourceSans",
    "sourceSerif",
    "lxgwWenkai",
    "pingfangSans",
    "songtiReading",
];
const VALID_RETENTION_COUNTS: &[u32] = &[1, 3, 5];
const VALID_BACKUP_FREQUENCY_DAYS: &[u32] = &[1, 3, 5, 7];
const SCHEMA_V1_REQUIRED_TABLES: &[&str] = &["notebooks", "folders", "notes"];
const SCHEMA_V2_REQUIRED_TABLES: &[&str] = &["note_search"];
const SCHEMA_V3_REQUIRED_TABLES: &[&str] = &["tags", "note_tags"];
const SCHEMA_V4_REQUIRED_TABLES: &[&str] = &[
    "review_plans",
    "review_plan_steps",
    "note_review_bindings",
    "review_tasks",
];
const SCHEMA_V5_REQUIRED_TABLES: &[&str] = &["app_meta"];
const SCHEMA_V6_REQUIRED_TABLES: &[&str] = &["note_tag_occurrences"];
const SCHEMA_V7_REQUIRED_TABLES: &[&str] = &["note_tag_occurrences"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_editor_font_family")]
    pub editor_font_family: String,
    #[serde(default)]
    pub auto_backup_enabled: bool,
    #[serde(default = "default_backup_retention_count")]
    pub backup_retention_count: u32,
    #[serde(default = "default_backup_frequency_days")]
    pub backup_frequency_days: u32,
    #[serde(default)]
    pub last_auto_backup_date: Option<String>,
}

fn default_theme() -> String {
    "blue".to_string()
}

fn default_editor_font_family() -> String {
    "modernSans".to_string()
}

fn default_backup_retention_count() -> u32 {
    5
}

fn default_backup_frequency_days() -> u32 {
    1
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            editor_font_family: default_editor_font_family(),
            auto_backup_enabled: false,
            backup_retention_count: default_backup_retention_count(),
            backup_frequency_days: default_backup_frequency_days(),
            last_auto_backup_date: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsUpdate {
    pub theme: Option<String>,
    pub editor_font_family: Option<String>,
    pub auto_backup_enabled: Option<bool>,
    pub backup_retention_count: Option<u32>,
    pub backup_frequency_days: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataEnvironmentInfo {
    pub data_dir: String,
    pub database_path: String,
    pub settings_path: String,
    pub resources_dir: String,
    pub backups_dir: String,
    pub legacy_backups_dir: String,
    pub cache_dir: String,
    pub webview_cache_dir: Option<String>,
    pub log_dir: String,
    pub temp_dir: String,
    pub app_version: String,
    pub database_size_bytes: u64,
    pub resources_size_bytes: u64,
    pub backups_size_bytes: u64,
    pub cache_size_bytes: u64,
    pub webview_cache_size_bytes: u64,
    pub legacy_backups_size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub format_version: u32,
    pub schema_version: Option<u32>,
    pub app_version: String,
    pub created_at: String,
    pub database_file: String,
    pub resource_directory: String,
    pub settings_file: String,
    pub note: String,
    #[serde(default)]
    pub note_count: Option<u64>,
    #[serde(default)]
    pub resource_count: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBackupPreview {
    pub backup_path: String,
    pub file_name: String,
    pub created_at: String,
    pub app_version: String,
    pub schema_version: Option<u32>,
    pub database_file: String,
    pub settings_file: String,
    pub resource_directory: String,
    pub note_count: Option<u64>,
    pub resource_count: Option<u64>,
    pub note: Option<String>,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SelectRestoreBackupFileResult {
    Selected {
        #[serde(rename = "backupPath")]
        backup_path: String,
        #[serde(rename = "fileName")]
        file_name: String,
    },
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupValidationStatus {
    Unknown,
    Validating,
    Valid,
    Invalid,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupListItem {
    pub file_name: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub validation_status: BackupValidationStatus,
    pub invalid_reason: Option<String>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBackupResult {
    pub backup: BackupListItem,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBackupResult {
    pub restored_file_name: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RestoreProgressStage {
    ReadingBackupInfo,
    CheckingBackupFormat,
    ExtractingBackup,
    CheckingDatabase,
    ReplacingLocalData,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreProgressEvent {
    pub stage: RestoreProgressStage,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupResult {
    pub status: String,
    pub backup: Option<BackupListItem>,
    pub warning: Option<String>,
}

#[derive(Default)]
pub struct BackupOperationLock {
    current: Mutex<Option<BackupOperation>>,
}

#[derive(Clone, Copy)]
enum BackupOperation {
    Backup,
    Restore,
    Delete,
}

struct OperationGuard<'a> {
    lock: &'a BackupOperationLock,
}

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut current) = self.lock.current.lock() {
            *current = None;
        }
    }
}

struct AppPaths {
    root: PathBuf,
    database: PathBuf,
    settings: PathBuf,
    resources: PathBuf,
    backups: PathBuf,
    legacy_backups: PathBuf,
    cache: PathBuf,
    webview_cache: Option<PathBuf>,
    log: PathBuf,
    temp: PathBuf,
}

#[derive(Debug)]
struct ValidatedBackup {
    manifest: BackupManifest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackupErrorKind {
    BackupFileInvalid,
    ZipReadFailed,
    ManifestInvalid,
    SchemaVersionUnsupported,
    DatabaseInvalid,
    SettingsInvalid,
    ResourcesInvalid,
    RestorePreparationFailed,
    DatabaseRestoreFailed,
    SettingsRestoreFailed,
    ResourcesRestoreFailed,
    RollbackFailed,
}

#[derive(Debug)]
struct BackupError {
    kind: BackupErrorKind,
    detail: String,
}

impl BackupError {
    fn new(kind: BackupErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }

    fn code(&self) -> &'static str {
        match self.kind {
            BackupErrorKind::BackupFileInvalid => "backup-file-invalid",
            BackupErrorKind::ZipReadFailed => "zip-read-failed",
            BackupErrorKind::ManifestInvalid => "manifest-invalid",
            BackupErrorKind::SchemaVersionUnsupported => "schema-version-unsupported",
            BackupErrorKind::DatabaseInvalid => "database-invalid",
            BackupErrorKind::SettingsInvalid => "settings-invalid",
            BackupErrorKind::ResourcesInvalid => "resources-invalid",
            BackupErrorKind::RestorePreparationFailed => "restore-preparation-failed",
            BackupErrorKind::DatabaseRestoreFailed => "database-restore-failed",
            BackupErrorKind::SettingsRestoreFailed => "settings-restore-failed",
            BackupErrorKind::ResourcesRestoreFailed => "resources-restore-failed",
            BackupErrorKind::RollbackFailed => "rollback-failed",
        }
    }

    fn user_message(&self) -> &'static str {
        match self.kind {
            BackupErrorKind::BackupFileInvalid => "备份文件无效，无法恢复。",
            BackupErrorKind::ZipReadFailed => "备份压缩包无法读取或已损坏。",
            BackupErrorKind::ManifestInvalid => "备份清单缺失或损坏，无法恢复。",
            BackupErrorKind::SchemaVersionUnsupported => "当前应用不支持恢复该数据库版本的备份。",
            BackupErrorKind::DatabaseInvalid => "备份中的数据库文件无效，无法恢复。",
            BackupErrorKind::SettingsInvalid => "备份中的应用设置无效，无法恢复。",
            BackupErrorKind::ResourcesInvalid => "备份中的资源目录结构无效，无法恢复。",
            BackupErrorKind::RestorePreparationFailed => "准备恢复本地数据失败，请稍后重试。",
            BackupErrorKind::DatabaseRestoreFailed => "恢复数据库失败，请稍后重试。",
            BackupErrorKind::SettingsRestoreFailed => "恢复应用设置失败，请稍后重试。",
            BackupErrorKind::ResourcesRestoreFailed => "恢复资源目录失败，请稍后重试。",
            BackupErrorKind::RollbackFailed => {
                "恢复失败，且回滚本地数据时出现问题，请立即检查数据目录。"
            }
        }
    }

    fn into_user_message(self) -> String {
        self.user_message().to_string()
    }
}

fn busy_message() -> String {
    "当前正在执行其他备份或恢复操作，请稍后再试。".to_string()
}

fn try_acquire_operation<'a>(
    lock: &'a BackupOperationLock,
    operation: BackupOperation,
) -> Result<OperationGuard<'a>, String> {
    let mut current = lock
        .current
        .lock()
        .map_err(|_| "备份状态锁定失败，请重试。".to_string())?;

    if current.is_some() {
        return Err(busy_message());
    }

    *current = Some(operation);
    drop(current);

    Ok(OperationGuard { lock })
}

fn try_acquire_auto_backup<'a>(
    lock: &'a BackupOperationLock,
) -> Result<Option<OperationGuard<'a>>, String> {
    let mut current = lock
        .current
        .lock()
        .map_err(|_| "备份状态锁定失败，请重试。".to_string())?;

    if current.is_some() {
        return Ok(None);
    }

    *current = Some(BackupOperation::Backup);
    drop(current);

    Ok(Some(OperationGuard { lock }))
}

fn resolve_app_paths<R: Runtime>(app: &AppHandle<R>) -> Result<AppPaths, String> {
    let root = app
        .path()
        .app_config_dir()
        .map_err(|_| "读取应用数据目录失败。".to_string())?;
    let backups = resolve_document_backups_dir(app.path().document_dir())?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "读取缓存目录失败。".to_string())?;
    let log = app
        .path()
        .app_log_dir()
        .map_err(|_| "读取日志目录失败。".to_string())?;
    let temp = app
        .path()
        .temp_dir()
        .map_err(|_| "读取临时目录失败。".to_string())?
        .join(APP_TEMP_DIR_NAME);
    let webview_cache = app
        .path()
        .cache_dir()
        .ok()
        .map(|cache_dir| cache_dir.join(&app.package_info().name));

    Ok(AppPaths {
        database: root.join(DATABASE_FILE_NAME),
        settings: root.join(SETTINGS_FILE_NAME),
        resources: root.join(RESOURCES_DIR_NAME),
        backups,
        legacy_backups: root.join(BACKUPS_DIR_NAME),
        cache,
        webview_cache,
        log,
        temp,
        root,
    })
}

fn ensure_directory(path: &Path, label: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("创建{label}失败：{error}"))
}

fn ensure_app_temp_dir(paths: &AppPaths) -> Result<(), String> {
    ensure_directory(&paths.temp, "应用临时目录")
}

fn create_app_temp_dir(paths: &AppPaths, label: &str) -> Result<TempDir, String> {
    ensure_app_temp_dir(paths)?;
    tempdir_in(&paths.temp).map_err(|error| format!("创建{label}失败：{error}"))
}

fn resolve_document_backups_dir<E>(documents: Result<PathBuf, E>) -> Result<PathBuf, String> {
    documents
        .map(|documents| documents.join(DOCUMENT_BACKUPS_DIR_NAME))
        .map_err(|_| DOCUMENT_DIR_UNAVAILABLE_MESSAGE.to_string())
}

fn directory_size_bytes(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }

    if path.is_file() {
        return fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
    }

    if !path.is_dir() {
        return 0;
    }

    WalkDir::new(path)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn cache_size_bytes(paths: &AppPaths) -> u64 {
    let webview_cache_size = paths
        .webview_cache
        .as_deref()
        .map(directory_size_bytes)
        .unwrap_or(0);

    directory_size_bytes(&paths.cache) + webview_cache_size
}

fn file_size_bytes(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn legacy_cleanup_marker_path(paths: &AppPaths) -> PathBuf {
    paths.root.join(LEGACY_BACKUPS_CLEANUP_MARKER_FILE_NAME)
}

fn is_legacy_backups_cleanup_target(root: &Path, target: &Path) -> bool {
    let expected = root.join(BACKUPS_DIR_NAME);

    target == expected
        && target != root
        && target != root.join(DATABASE_FILE_NAME)
        && target != root.join(SETTINGS_FILE_NAME)
        && target != root.join(RESOURCES_DIR_NAME)
}

fn mark_legacy_backups_cleanup_attempted(paths: &AppPaths) {
    let marker_path = legacy_cleanup_marker_path(paths);
    if let Err(error) = fs::write(&marker_path, b"done\n") {
        eprintln!(
            "[settings.backup] 写入旧备份清理标记失败 [{}]: {error}",
            marker_path.to_string_lossy()
        );
    }
}

fn cleanup_legacy_backups_once(paths: &AppPaths) {
    let marker_path = legacy_cleanup_marker_path(paths);
    if marker_path.exists() {
        return;
    }

    if !is_legacy_backups_cleanup_target(&paths.root, &paths.legacy_backups) {
        eprintln!(
            "[settings.backup] 拒绝清理旧备份目录，目标路径不匹配: {}",
            paths.legacy_backups.to_string_lossy()
        );
        mark_legacy_backups_cleanup_attempted(paths);
        return;
    }

    if paths.legacy_backups.exists() {
        if let Err(error) = fs::remove_dir_all(&paths.legacy_backups) {
            eprintln!(
                "[settings.backup] 清理旧备份目录失败 [{}]: {error}",
                paths.legacy_backups.to_string_lossy()
            );
            mark_legacy_backups_cleanup_attempted(paths);
            return;
        }
    }

    mark_legacy_backups_cleanup_attempted(paths);
}

fn open_directory(path: &Path, label: &str) -> Result<(), String> {
    ensure_directory(path, label)?;

    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");

    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(path)
        .spawn()
        .map_err(|error| format!("打开{label}失败：{error}"))?;

    Ok(())
}

fn validate_theme(theme: &str) -> Result<(), String> {
    if VALID_THEMES.iter().any(|candidate| candidate == &theme) {
        Ok(())
    } else {
        Err("主题配置无效。".to_string())
    }
}

fn validate_editor_font_family(font_family: &str) -> Result<(), String> {
    if VALID_EDITOR_FONT_FAMILIES
        .iter()
        .any(|candidate| candidate == &font_family)
    {
        Ok(())
    } else {
        Err("编辑器字体配置无效。".to_string())
    }
}

fn validate_retention_count(count: u32) -> Result<(), String> {
    if VALID_RETENTION_COUNTS
        .iter()
        .any(|candidate| candidate == &count)
    {
        Ok(())
    } else {
        Err("自动备份保留份数无效。".to_string())
    }
}

fn validate_backup_frequency_days(days: u32) -> Result<(), String> {
    if VALID_BACKUP_FREQUENCY_DAYS
        .iter()
        .any(|candidate| candidate == &days)
    {
        Ok(())
    } else {
        Err("自动备份频率无效。".to_string())
    }
}

fn normalize_app_settings(mut settings: AppSettings) -> AppSettings {
    if validate_retention_count(settings.backup_retention_count).is_err() {
        settings.backup_retention_count = default_backup_retention_count();
    }

    if validate_backup_frequency_days(settings.backup_frequency_days).is_err() {
        settings.backup_frequency_days = default_backup_frequency_days();
    }

    settings
}

fn validate_app_settings(settings: &AppSettings) -> Result<(), String> {
    validate_theme(&settings.theme)?;
    validate_editor_font_family(&settings.editor_font_family)?;
    validate_retention_count(settings.backup_retention_count)?;
    validate_backup_frequency_days(settings.backup_frequency_days)?;

    if let Some(date) = &settings.last_auto_backup_date {
        if !is_valid_date_key(date) {
            return Err("自动备份日期配置无效。".to_string());
        }
    }

    Ok(())
}

fn merge_app_settings(
    current: &AppSettings,
    update: AppSettingsUpdate,
) -> Result<AppSettings, String> {
    let next = AppSettings {
        theme: update.theme.unwrap_or_else(|| current.theme.clone()),
        editor_font_family: update
            .editor_font_family
            .unwrap_or_else(|| current.editor_font_family.clone()),
        auto_backup_enabled: update
            .auto_backup_enabled
            .unwrap_or(current.auto_backup_enabled),
        backup_retention_count: update
            .backup_retention_count
            .unwrap_or(current.backup_retention_count),
        backup_frequency_days: update
            .backup_frequency_days
            .unwrap_or(current.backup_frequency_days),
        last_auto_backup_date: current.last_auto_backup_date.clone(),
    };

    validate_app_settings(&next)?;
    Ok(next)
}

fn read_settings_from_path(path: &Path) -> Result<AppSettings, String> {
    let content = fs::read_to_string(path).map_err(|error| format!("读取应用设置失败：{error}"))?;
    let settings: AppSettings =
        serde_json::from_str(&content).map_err(|error| format!("解析应用设置失败：{error}"))?;
    let settings = normalize_app_settings(settings);
    validate_app_settings(&settings)?;
    Ok(settings)
}

fn write_settings_atomically(path: &Path, settings: &AppSettings) -> Result<(), String> {
    validate_app_settings(settings)?;

    let parent = path
        .parent()
        .ok_or_else(|| "应用设置目录无效。".to_string())?;
    ensure_directory(parent, "设置目录")?;

    let mut temp_file =
        NamedTempFile::new_in(parent).map_err(|error| format!("创建设置临时文件失败：{error}"))?;

    serde_json::to_writer_pretty(&mut temp_file, settings)
        .map_err(|error| format!("写入应用设置失败：{error}"))?;
    temp_file
        .write_all(b"\n")
        .map_err(|error| format!("写入应用设置失败：{error}"))?;
    temp_file
        .as_file()
        .sync_all()
        .map_err(|error| format!("同步应用设置失败：{error}"))?;
    temp_file
        .persist(path)
        .map_err(|error| format!("替换应用设置失败：{error}"))?;

    Ok(())
}

fn ensure_app_environment<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(AppPaths, AppSettings), String> {
    let paths = resolve_app_paths(app)?;
    ensure_directory(&paths.root, "应用数据目录")?;
    ensure_directory(&paths.resources, "资源目录")?;
    ensure_directory(&paths.backups, "备份目录")?;
    ensure_app_temp_dir(&paths)?;
    cleanup_legacy_backups_once(&paths);

    let settings = if paths.settings.exists() {
        read_settings_from_path(&paths.settings)?
    } else {
        let settings = AppSettings::default();
        write_settings_atomically(&paths.settings, &settings)?;
        settings
    };

    Ok((paths, settings))
}

fn format_local_timestamp(system_time: std::time::SystemTime) -> String {
    let datetime: DateTime<Local> = system_time.into();
    datetime.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn format_today_key() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn is_valid_date_key(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

fn has_auto_backup_interval_elapsed(
    last_auto_backup_date: Option<&str>,
    backup_frequency_days: u32,
) -> Result<bool, String> {
    let Some(last_auto_backup_date) = last_auto_backup_date else {
        return Ok(true);
    };

    let last_date = NaiveDate::parse_from_str(last_auto_backup_date, "%Y-%m-%d")
        .map_err(|_| "自动备份日期配置无效。".to_string())?;
    let today = Local::now().date_naive();
    let elapsed_days = today.signed_duration_since(last_date).num_days();

    Ok(elapsed_days >= backup_frequency_days as i64)
}

fn current_timestamp_label() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn backup_path_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未知备份")
        .to_string()
}

fn emit_restore_progress<R: Runtime>(
    app: &AppHandle<R>,
    stage: RestoreProgressStage,
    message: &str,
) {
    let _ = app.emit(
        RESTORE_PROGRESS_EVENT,
        RestoreProgressEvent {
            stage,
            message: message.to_string(),
        },
    );
}

fn log_backup_perf_start(stage: &str) -> Instant {
    eprintln!("[backup.perf] {stage} start");
    Instant::now()
}

fn log_backup_perf_complete(stage: &str, started_at: Instant) {
    eprintln!(
        "[backup.perf] {stage} complete {}ms",
        started_at.elapsed().as_millis()
    );
}

fn log_backup_perf_failed(stage: &str, started_at: Instant, error: &BackupError) {
    eprintln!(
        "[backup.perf] {stage} failed kind={} {}ms detail={}",
        error.code(),
        started_at.elapsed().as_millis(),
        error.detail
    );
}

fn with_backup_perf<T, F>(stage: &str, operation: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let started_at = log_backup_perf_start(stage);
    let result = operation();
    log_backup_perf_complete(stage, started_at);
    result
}

fn with_backup_stage<T, F>(stage: &str, operation: F) -> Result<T, BackupError>
where
    F: FnOnce() -> Result<T, BackupError>,
{
    let started_at = log_backup_perf_start(stage);
    match operation() {
        Ok(value) => {
            log_backup_perf_complete(stage, started_at);
            Ok(value)
        }
        Err(error) => {
            log_backup_perf_failed(stage, started_at, &error);
            Err(error)
        }
    }
}

fn build_backup_file_name_with_prefix(backups_dir: &Path, prefix: &str) -> PathBuf {
    let base = format!("{prefix}-{}", Local::now().format("%Y-%m-%d_%H-%M-%S"));
    let mut candidate = format!("{base}.zip");
    let mut index = 1;

    while backups_dir.join(&candidate).exists() {
        candidate = format!("{base}-{index}.zip");
        index += 1;
    }

    backups_dir.join(candidate)
}

fn create_database_snapshot(source_path: &Path, snapshot_path: &Path) -> Result<(), String> {
    if !source_path.exists() {
        return Err("数据库文件不存在，暂时无法创建备份。".to_string());
    }

    let connection =
        Connection::open(source_path).map_err(|error| format!("打开数据库失败：{error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("设置数据库超时失败：{error}"))?;
    connection
        .execute(
            "VACUUM INTO ?1",
            [snapshot_path.to_string_lossy().to_string()],
        )
        .map_err(|error| format!("创建数据库快照失败：{error}"))?;

    Ok(())
}

fn zip_file_options() -> FileOptions {
    FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

fn resource_file_compression_method(path: &Path) -> CompressionMethod {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    if extension.as_deref().is_some_and(|value| {
        STORED_RESOURCE_EXTENSIONS
            .iter()
            .any(|candidate| *candidate == value)
    }) {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    }
}

fn resource_file_options(path: &Path) -> FileOptions {
    FileOptions::default()
        .compression_method(resource_file_compression_method(path))
        .unix_permissions(0o644)
}

fn zip_dir_options() -> FileOptions {
    FileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o755)
}

fn add_file_to_zip(
    zip: &mut ZipWriter<File>,
    source_path: &Path,
    zip_path: &str,
    options: FileOptions,
) -> Result<(), String> {
    let mut file = File::open(source_path).map_err(|error| format!("读取备份文件失败：{error}"))?;

    zip.start_file(zip_path, options)
        .map_err(|error| format!("写入备份压缩包失败：{error}"))?;
    io::copy(&mut file, zip).map_err(|error| format!("写入备份压缩包失败：{error}"))?;
    Ok(())
}

fn add_resources_to_zip(
    zip: &mut ZipWriter<File>,
    resources_dir: &Path,
    zip_dir_name: &str,
) -> Result<(), String> {
    let normalized_dir = format!("{}/", zip_dir_name.trim_end_matches('/'));
    zip.add_directory(normalized_dir.clone(), zip_dir_options())
        .map_err(|error| format!("写入资源目录失败：{error}"))?;

    for entry in WalkDir::new(resources_dir) {
        let entry = entry.map_err(|error| format!("读取资源目录失败：{error}"))?;
        let path = entry.path();

        if path == resources_dir {
            continue;
        }

        let relative_path = path
            .strip_prefix(resources_dir)
            .map_err(|error| format!("处理资源目录失败：{error}"))?;
        let relative_display = relative_path.to_string_lossy().replace('\\', "/");
        let target_path = format!("{zip_dir_name}/{relative_display}");

        if entry.file_type().is_dir() {
            zip.add_directory(format!("{target_path}/"), zip_dir_options())
                .map_err(|error| format!("写入资源目录失败：{error}"))?;
        } else if entry.file_type().is_file() {
            add_file_to_zip(zip, path, &target_path, resource_file_options(path))?;
        }
    }

    Ok(())
}

fn create_manifest<R: Runtime>(app: &AppHandle<R>, note: Option<&str>) -> BackupManifest {
    BackupManifest {
        format_version: BACKUP_FORMAT_VERSION,
        schema_version: Some(CURRENT_SCHEMA_VERSION),
        app_version: app.package_info().version.to_string(),
        created_at: current_timestamp_label(),
        database_file: DATABASE_FILE_NAME.to_string(),
        resource_directory: RESOURCES_DIR_NAME.to_string(),
        settings_file: SETTINGS_FILE_NAME.to_string(),
        note: note.unwrap_or("").to_string(),
        note_count: None,
        resource_count: None,
    }
}

fn metadata_created_label(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(format_local_timestamp)
        .unwrap_or_else(|_| "未知时间".to_string())
}

fn backup_note_to_option(note: &str) -> Option<String> {
    if note.trim().is_empty() {
        None
    } else {
        Some(note.to_string())
    }
}

fn build_created_backup_list_item(
    backup_path: &Path,
    manifest: &BackupManifest,
) -> Result<BackupListItem, String> {
    let file_name = backup_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未知备份")
        .to_string();
    let size_bytes = fs::metadata(backup_path)
        .map_err(|error| format!("读取备份文件元数据失败：{error}"))?
        .len();

    Ok(BackupListItem {
        file_name,
        created_at: manifest.created_at.clone(),
        size_bytes,
        validation_status: BackupValidationStatus::Valid,
        invalid_reason: None,
        note: backup_note_to_option(&manifest.note),
    })
}

fn build_light_backup_list_item(path: &Path) -> BackupListItem {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未知备份")
        .to_string();
    let size_bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    BackupListItem {
        file_name,
        created_at: metadata_created_label(path),
        size_bytes,
        validation_status: BackupValidationStatus::Unknown,
        invalid_reason: None,
        note: None,
    }
}

fn build_validated_backup_list_item(path: &Path, validated: ValidatedBackup) -> BackupListItem {
    BackupListItem {
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("未知备份")
            .to_string(),
        created_at: validated.manifest.created_at,
        size_bytes: fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        validation_status: BackupValidationStatus::Valid,
        invalid_reason: None,
        note: backup_note_to_option(&validated.manifest.note),
    }
}

fn build_invalid_backup_list_item(path: &Path, error: BackupError) -> BackupListItem {
    BackupListItem {
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("未知备份")
            .to_string(),
        created_at: metadata_created_label(path),
        size_bytes: fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        validation_status: BackupValidationStatus::Invalid,
        invalid_reason: Some(error.into_user_message()),
        note: None,
    }
}

fn is_valid_backup_file_name(file_name: &str) -> bool {
    !file_name.trim().is_empty()
        && !file_name.contains('/')
        && !file_name.contains('\\')
        && file_name.ends_with(".zip")
}

fn resolve_backup_file_path(paths: &AppPaths, file_name: &str) -> Result<PathBuf, String> {
    if !is_valid_backup_file_name(file_name) {
        return Err("备份文件名无效。".to_string());
    }

    let backup_path = paths.backups.join(file_name);
    if !backup_path.exists() {
        return Err("目标备份不存在。".to_string());
    }

    Ok(backup_path)
}

fn resolve_restore_backup_path(backup_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(backup_path.trim());

    if backup_path.trim().is_empty() {
        return Err("备份文件路径无效。".to_string());
    }

    if !path.exists() {
        return Err("目标备份不存在。".to_string());
    }

    if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("zip") {
        return Err("请选择 .zip 格式的备份文件。".to_string());
    }

    Ok(path)
}

fn map_schema_validation_error(detail: String) -> BackupError {
    if detail.contains("暂不支持恢复来自更高数据库版本的备份")
        || detail.contains("数据库版本不受支持")
    {
        BackupError::new(BackupErrorKind::SchemaVersionUnsupported, detail)
    } else {
        BackupError::new(BackupErrorKind::DatabaseInvalid, detail)
    }
}

fn table_exists(connection: &Connection, table_name: &str) -> Result<bool, String> {
    let exists: i64 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = ?1)",
            [table_name],
            |row| row.get(0),
        )
        .map_err(|error| format!("校验数据库结构失败：{error}"))?;

    Ok(exists != 0)
}

fn table_has_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|error| format!("读取数据表结构失败：{error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("查询数据表结构失败：{error}"))?;

    while let Some(row) = rows
        .next()
        .map_err(|error| format!("遍历数据表结构失败：{error}"))?
    {
        let current_name: String = row
            .get(1)
            .map_err(|error| format!("读取数据表字段失败：{error}"))?;

        if current_name == column_name {
            return Ok(true);
        }
    }

    Ok(false)
}

fn required_tables_for_schema_version(schema_version: u32) -> Result<Vec<&'static str>, String> {
    if schema_version == 0 || schema_version > CURRENT_SCHEMA_VERSION {
        return Err("备份中的数据库版本不受支持。".to_string());
    }

    let mut tables = Vec::new();
    tables.extend(SCHEMA_V1_REQUIRED_TABLES.iter().copied());

    if schema_version >= 2 {
        tables.extend(SCHEMA_V2_REQUIRED_TABLES.iter().copied());
    }

    if schema_version >= 3 {
        tables.extend(SCHEMA_V3_REQUIRED_TABLES.iter().copied());
    }

    if schema_version >= 4 {
        tables.extend(SCHEMA_V4_REQUIRED_TABLES.iter().copied());
    }

    if schema_version >= 5 {
        tables.extend(SCHEMA_V5_REQUIRED_TABLES.iter().copied());
    }

    if schema_version >= 6 {
        tables.extend(SCHEMA_V6_REQUIRED_TABLES.iter().copied());
    }

    if schema_version >= 7 {
        tables.extend(SCHEMA_V7_REQUIRED_TABLES.iter().copied());
    }

    Ok(tables)
}

fn infer_schema_version(connection: &Connection) -> Result<u32, String> {
    let base_exists = [
        table_exists(connection, "notebooks")?,
        table_exists(connection, "folders")?,
        table_exists(connection, "notes")?,
    ];

    if base_exists.iter().any(|exists| !exists) {
        return Err("备份中的数据库缺少基础笔记表，无法恢复。".to_string());
    }

    let has_note_search = table_exists(connection, "note_search")?;
    let has_tags = table_exists(connection, "tags")?;
    let has_note_tags = table_exists(connection, "note_tags")?;
    let has_review_plans = table_exists(connection, "review_plans")?;
    let has_review_plan_steps = table_exists(connection, "review_plan_steps")?;
    let has_note_review_bindings = table_exists(connection, "note_review_bindings")?;
    let has_review_tasks = table_exists(connection, "review_tasks")?;
    let has_app_meta = table_exists(connection, "app_meta")?;
    let has_note_tag_occurrences = table_exists(connection, "note_tag_occurrences")?;
    let has_occurrence_remark_text = if has_note_tag_occurrences {
        table_has_column(connection, "note_tag_occurrences", "remark_text")?
    } else {
        false
    };

    let has_tag_group = has_tags || has_note_tags;
    let has_complete_tag_group = has_tags && has_note_tags;
    let has_review_group =
        has_review_plans || has_review_plan_steps || has_note_review_bindings || has_review_tasks;
    let has_complete_review_group =
        has_review_plans && has_review_plan_steps && has_note_review_bindings && has_review_tasks;

    if has_tag_group && !has_complete_tag_group {
        return Err("备份中的标签结构不完整，无法恢复。".to_string());
    }

    if has_complete_tag_group && !has_note_search {
        return Err("备份中的搜索索引结构不完整，无法恢复。".to_string());
    }

    if has_review_group && !has_complete_review_group {
        return Err("备份中的复习任务结构不完整，无法恢复。".to_string());
    }

    if has_complete_review_group && !has_complete_tag_group {
        return Err("备份中的数据库结构版本不一致，无法恢复。".to_string());
    }

    if has_app_meta && !has_complete_review_group {
        return Err("备份中的元数据结构不完整，无法恢复。".to_string());
    }

    if has_note_tag_occurrences && !has_app_meta {
        return Err("备份中的标签索引结构不完整，无法恢复。".to_string());
    }

    let mut version = 1;

    if has_note_search {
        version = 2;
    }

    if has_complete_tag_group {
        version = 3;
    }

    if has_complete_review_group {
        version = 4;
    }

    if has_app_meta {
        version = 5;
    }

    if has_note_tag_occurrences {
        version = 6;
    }

    if has_occurrence_remark_text {
        version = 7;
    }

    Ok(version)
}

fn validate_database_file_for_schema(
    path: &Path,
    declared_schema_version: Option<u32>,
) -> Result<u32, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("备份中的数据库无法打开：{error}"))?;

    let inferred_schema_version = infer_schema_version(&connection)?;
    let effective_schema_version = if let Some(schema_version) = declared_schema_version {
        if schema_version > CURRENT_SCHEMA_VERSION {
            return Err("当前应用暂不支持恢复来自更高数据库版本的备份。".to_string());
        }

        let required_tables = required_tables_for_schema_version(schema_version)?;

        for table_name in required_tables {
            if !table_exists(&connection, table_name)? {
                return Err(format!("备份中的数据库缺少必要表：{table_name}"));
            }
        }

        if schema_version >= 7
            && !table_has_column(&connection, "note_tag_occurrences", "remark_text")?
        {
            return Err("备份中的数据库缺少必要字段：note_tag_occurrences.remark_text".to_string());
        }

        inferred_schema_version.max(schema_version)
    } else {
        inferred_schema_version
    };

    Ok(effective_schema_version)
}

fn is_safe_manifest_archive_name(value: &str) -> bool {
    if value.is_empty()
        || value.contains('/')
        || value.contains('\\')
        || Path::new(value).is_absolute()
    {
        return false;
    }

    let mut components = Path::new(value).components();
    let Some(Component::Normal(component)) = components.next() else {
        return false;
    };

    components.next().is_none() && component.to_string_lossy() == value
}

fn validate_manifest_archive_entry(label: &str, value: &str, expected: &str) -> Result<(), String> {
    if !is_safe_manifest_archive_name(value) || value != expected {
        return Err(format!("备份清单中的{label}无效。"));
    }

    Ok(())
}

fn validate_manifest_archive_paths(manifest: &BackupManifest) -> Result<(), String> {
    validate_manifest_archive_entry(
        "数据库文件路径",
        &manifest.database_file,
        DATABASE_FILE_NAME,
    )?;
    validate_manifest_archive_entry("设置文件路径", &manifest.settings_file, SETTINGS_FILE_NAME)?;
    validate_manifest_archive_entry(
        "资源目录路径",
        &manifest.resource_directory,
        RESOURCES_DIR_NAME,
    )?;

    Ok(())
}

fn ensure_manifest_schema_supported(manifest: &BackupManifest) -> Result<(), BackupError> {
    if let Some(schema_version) = manifest.schema_version {
        if schema_version == 0 || schema_version > CURRENT_SCHEMA_VERSION {
            return Err(BackupError::new(
                BackupErrorKind::SchemaVersionUnsupported,
                "备份中的数据库版本不受支持。",
            ));
        }
    }

    Ok(())
}

fn read_manifest_from_archive(archive: &mut ZipArchive<File>) -> Result<BackupManifest, String> {
    let mut manifest_file = archive
        .by_name("manifest.json")
        .map_err(|error| format!("读取备份清单失败：{error}"))?;
    let mut content = String::new();
    manifest_file
        .read_to_string(&mut content)
        .map_err(|error| format!("读取备份清单失败：{error}"))?;
    let manifest: BackupManifest =
        serde_json::from_str(&content).map_err(|error| format!("解析备份清单失败：{error}"))?;

    if manifest.format_version != BACKUP_FORMAT_VERSION {
        return Err("当前备份格式版本不受支持。".to_string());
    }

    validate_manifest_archive_paths(&manifest)?;

    Ok(manifest)
}

fn build_restore_backup_preview(
    backup_path: &Path,
    manifest: &BackupManifest,
) -> Result<RestoreBackupPreview, String> {
    let size_bytes = fs::metadata(backup_path)
        .map_err(|error| format!("读取备份文件元数据失败：{error}"))?
        .len();

    Ok(RestoreBackupPreview {
        backup_path: backup_path.to_string_lossy().to_string(),
        file_name: backup_path_file_name(backup_path),
        created_at: manifest.created_at.clone(),
        app_version: manifest.app_version.clone(),
        schema_version: manifest.schema_version,
        database_file: manifest.database_file.clone(),
        settings_file: manifest.settings_file.clone(),
        resource_directory: manifest.resource_directory.clone(),
        note_count: manifest.note_count,
        resource_count: manifest.resource_count,
        note: backup_note_to_option(&manifest.note),
        size_bytes,
    })
}

fn preview_restore_backup_path(backup_path: &Path) -> Result<RestoreBackupPreview, BackupError> {
    let mut archive = open_backup_archive(backup_path)?;
    let manifest = read_manifest_with_diagnostic(&mut archive)?;
    ensure_manifest_schema_supported(&manifest)?;
    build_restore_backup_preview(backup_path, &manifest)
        .map_err(|error| BackupError::new(BackupErrorKind::BackupFileInvalid, error))
}

fn extract_archive_file_to_path(
    archive: &mut ZipArchive<File>,
    archive_path: &str,
    destination: &Path,
) -> Result<(), String> {
    let mut entry = archive
        .by_name(archive_path)
        .map_err(|error| format!("读取备份内容失败：{error}"))?;

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建恢复临时目录失败：{error}"))?;
    }

    let mut output =
        File::create(destination).map_err(|error| format!("写入恢复临时文件失败：{error}"))?;
    io::copy(&mut entry, &mut output).map_err(|error| format!("写入恢复临时文件失败：{error}"))?;

    Ok(())
}

fn ensure_archive_has_resources(
    archive: &mut ZipArchive<File>,
    resource_directory: &str,
) -> Result<(), String> {
    let prefix = format!("{}/", resource_directory.trim_end_matches('/'));
    let mut has_resources = false;

    for index in 0..archive.len() {
        let name = archive
            .by_index(index)
            .map_err(|error| format!("读取备份内容失败：{error}"))?
            .name()
            .to_string();

        if name == prefix || name.starts_with(&prefix) {
            has_resources = true;
            break;
        }
    }

    if has_resources {
        Ok(())
    } else {
        Err("备份中的资源目录缺失。".to_string())
    }
}

fn open_backup_archive(path: &Path) -> Result<ZipArchive<File>, BackupError> {
    let file = File::open(path)
        .map_err(|error| BackupError::new(BackupErrorKind::BackupFileInvalid, error.to_string()))?;
    ZipArchive::new(file)
        .map_err(|error| BackupError::new(BackupErrorKind::ZipReadFailed, error.to_string()))
}

fn read_manifest_with_diagnostic(
    archive: &mut ZipArchive<File>,
) -> Result<BackupManifest, BackupError> {
    read_manifest_from_archive(archive)
        .map_err(|error| BackupError::new(BackupErrorKind::ManifestInvalid, error))
}

fn validate_database_archive_entry(
    archive: &mut ZipArchive<File>,
    manifest: &BackupManifest,
    temp_dir: &Path,
) -> Result<u32, BackupError> {
    let database_path = temp_dir.join(&manifest.database_file);
    extract_archive_file_to_path(
        archive,
        &format!("database/{}", manifest.database_file),
        &database_path,
    )
    .map_err(|error| BackupError::new(BackupErrorKind::DatabaseInvalid, error))?;
    validate_database_file_for_schema(&database_path, manifest.schema_version)
        .map_err(map_schema_validation_error)
}

fn validate_settings_archive_entry(
    archive: &mut ZipArchive<File>,
    manifest: &BackupManifest,
    temp_dir: &Path,
) -> Result<(), BackupError> {
    let settings_path = temp_dir.join(&manifest.settings_file);
    extract_archive_file_to_path(
        archive,
        &format!("settings/{}", manifest.settings_file),
        &settings_path,
    )
    .map_err(|error| BackupError::new(BackupErrorKind::SettingsInvalid, error))?;
    read_settings_from_path(&settings_path)
        .map_err(|error| BackupError::new(BackupErrorKind::SettingsInvalid, error))?;
    Ok(())
}

fn validate_resources_archive_entry(
    archive: &mut ZipArchive<File>,
    manifest: &BackupManifest,
) -> Result<(), BackupError> {
    ensure_archive_has_resources(archive, &manifest.resource_directory)
        .map_err(|error| BackupError::new(BackupErrorKind::ResourcesInvalid, error))
}

fn create_backup_validation_temp_dir(temp_parent: &Path) -> Result<TempDir, BackupError> {
    ensure_directory(temp_parent, "应用临时目录")
        .map_err(|error| BackupError::new(BackupErrorKind::BackupFileInvalid, error))?;
    tempdir_in(temp_parent).map_err(|error| {
        BackupError::new(
            BackupErrorKind::BackupFileInvalid,
            format!("创建备份校验临时目录失败：{error}"),
        )
    })
}

fn validate_backup_archive(
    path: &Path,
    temp_parent: &Path,
) -> Result<ValidatedBackup, BackupError> {
    with_backup_stage("validate_backup_archive", || {
        let mut archive = open_backup_archive(path)?;
        let manifest = read_manifest_with_diagnostic(&mut archive)?;
        let temp_dir = create_backup_validation_temp_dir(temp_parent)?;
        validate_database_archive_entry(&mut archive, &manifest, temp_dir.path())?;
        validate_settings_archive_entry(&mut archive, &manifest, temp_dir.path())?;
        validate_resources_archive_entry(&mut archive, &manifest)?;

        Ok(ValidatedBackup { manifest })
    })
}

fn collect_backup_file_paths(backups_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut backup_files = Vec::new();

    for entry in fs::read_dir(backups_dir).map_err(|error| format!("读取备份目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取备份目录失败：{error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if path.extension().and_then(|value| value.to_str()) != Some("zip") {
            continue;
        }

        backup_files.push(path);
    }

    sort_backup_paths_newest_first(&mut backup_files);
    Ok(backup_files)
}

fn sort_backup_paths_newest_first(paths: &mut [PathBuf]) {
    paths.sort_by(|left, right| {
        let left_modified = fs::metadata(left)
            .and_then(|metadata| metadata.modified())
            .ok();
        let right_modified = fs::metadata(right)
            .and_then(|metadata| metadata.modified())
            .ok();

        right_modified
            .cmp(&left_modified)
            .then_with(|| right.cmp(left))
    });
}

fn list_backup_items(paths: &AppPaths) -> Result<Vec<BackupListItem>, String> {
    let backup_files = collect_backup_file_paths(&paths.backups)?;

    Ok(backup_files
        .iter()
        .map(|path| build_light_backup_list_item(path))
        .collect())
}

fn validate_backup_file(paths: &AppPaths, file_name: &str) -> Result<BackupListItem, String> {
    let backup_path = resolve_backup_file_path(paths, file_name)?;

    Ok(match validate_backup_archive(&backup_path, &paths.temp) {
        Ok(validated) => build_validated_backup_list_item(&backup_path, validated),
        Err(error) => build_invalid_backup_list_item(&backup_path, error),
    })
}

fn prune_old_backups(backups_dir: &Path, retention_count: usize) -> Result<(), String> {
    let backup_files = collect_backup_file_paths(backups_dir)?;

    let mut warnings = Vec::new();

    for path in backup_files.into_iter().skip(retention_count) {
        if let Err(error) = fs::remove_file(&path) {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("未知备份");
            warnings.push(format!("删除超出保留份数的备份 {name} 失败：{error}"));
        }
    }

    if warnings.is_empty() {
        Ok(())
    } else {
        Err(warnings.join("；"))
    }
}

fn create_backup_snapshot_without_lock<R: Runtime>(
    app: &AppHandle<R>,
    paths: &AppPaths,
    settings: &AppSettings,
    note: Option<&str>,
    file_name_prefix: &str,
    prune_by_retention: bool,
) -> Result<CreateBackupResult, String> {
    let temp_dir = create_app_temp_dir(paths, "备份临时目录")?;
    let snapshot_path = temp_dir.path().join(DATABASE_FILE_NAME);
    with_backup_perf("create_backup.database_snapshot", || {
        create_database_snapshot(&paths.database, &snapshot_path)
    })?;

    let manifest = create_manifest(app, note);
    let backup_path = build_backup_file_name_with_prefix(&paths.backups, file_name_prefix);
    let backup_file =
        File::create(&backup_path).map_err(|error| format!("创建备份文件失败：{error}"))?;
    let zip_write_started_at = Instant::now();
    let mut zip = ZipWriter::new(backup_file);

    zip.add_directory("database/", zip_dir_options())
        .map_err(|error| format!("写入备份压缩包失败：{error}"))?;
    zip.add_directory("settings/", zip_dir_options())
        .map_err(|error| format!("写入备份压缩包失败：{error}"))?;

    let manifest_content = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("生成备份清单失败：{error}"))?;
    zip.start_file("manifest.json", zip_file_options())
        .map_err(|error| format!("写入备份压缩包失败：{error}"))?;
    zip.write_all(&manifest_content)
        .map_err(|error| format!("写入备份压缩包失败：{error}"))?;

    add_file_to_zip(
        &mut zip,
        &snapshot_path,
        &format!("database/{}", manifest.database_file),
        zip_file_options(),
    )?;
    add_file_to_zip(
        &mut zip,
        &paths.settings,
        &format!("settings/{}", manifest.settings_file),
        zip_file_options(),
    )?;
    with_backup_perf("create_backup.resources_zip", || {
        add_resources_to_zip(&mut zip, &paths.resources, &manifest.resource_directory)
    })?;

    zip.finish()
        .map_err(|error| format!("完成备份压缩包失败：{error}"))?;
    log_backup_perf_complete("create_backup.zip_write", zip_write_started_at);

    let result_started_at = Instant::now();
    if prune_by_retention {
        prune_old_backups(&paths.backups, settings.backup_retention_count as usize)?;
    }
    let backup = build_created_backup_list_item(&backup_path, &manifest)?;
    log_backup_perf_complete("create_backup.result", result_started_at);

    Ok(CreateBackupResult {
        backup,
        warning: None,
    })
}

fn create_backup_internal<R: Runtime>(
    app: &AppHandle<R>,
    paths: &AppPaths,
    settings: &AppSettings,
    note: Option<&str>,
) -> Result<CreateBackupResult, String> {
    create_backup_snapshot_without_lock(app, paths, settings, note, BACKUP_FILE_PREFIX, true)
}

fn safe_join_relative(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut result = base.to_path_buf();

    for component in Path::new(relative).components() {
        match component {
            Component::Normal(value) => result.push(value),
            Component::CurDir => {}
            _ => return Err("备份中的资源路径无效。".to_string()),
        }
    }

    if !result.starts_with(base) {
        return Err("备份中的资源路径无效。".to_string());
    }

    Ok(result)
}

fn archive_has_entry(archive: &mut ZipArchive<File>, archive_path: &str) -> bool {
    archive.by_name(archive_path).is_ok()
}

struct RestoredBackupPaths {
    manifest: BackupManifest,
    database: PathBuf,
    settings: Option<PathBuf>,
    resources: PathBuf,
}

fn extract_restore_backup_archive(
    backup_path: &Path,
    destination_dir: &Path,
) -> Result<RestoredBackupPaths, String> {
    let file = File::open(backup_path).map_err(|error| format!("打开备份失败：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("读取备份压缩包失败：{error}"))?;
    let manifest = read_manifest_from_archive(&mut archive)?;

    let database_path = destination_dir
        .join("database")
        .join(&manifest.database_file);
    extract_archive_file_to_path(
        &mut archive,
        &format!("database/{}", manifest.database_file),
        &database_path,
    )?;

    let settings_archive_path = format!("settings/{}", manifest.settings_file);
    let settings_path = if archive_has_entry(&mut archive, &settings_archive_path) {
        let settings_path = destination_dir
            .join("settings")
            .join(&manifest.settings_file);
        extract_archive_file_to_path(&mut archive, &settings_archive_path, &settings_path)?;
        Some(settings_path)
    } else {
        None
    };

    let resources_dir = destination_dir.join(&manifest.resource_directory);
    fs::create_dir_all(&resources_dir).map_err(|error| format!("创建资源恢复目录失败：{error}"))?;

    let resources_prefix = format!("{}/", manifest.resource_directory.trim_end_matches('/'));

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取备份内容失败：{error}"))?;
        let name = entry.name().to_string();

        if name == resources_prefix {
            continue;
        }

        if !name.starts_with(&resources_prefix) {
            continue;
        }

        let relative = &name[resources_prefix.len()..];
        if relative.is_empty() {
            continue;
        }

        let output_path = safe_join_relative(&resources_dir, relative)?;

        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("恢复资源目录失败：{error}"))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("恢复资源目录失败：{error}"))?;
        }

        let mut output =
            File::create(&output_path).map_err(|error| format!("恢复资源文件失败：{error}"))?;
        io::copy(&mut entry, &mut output).map_err(|error| format!("恢复资源文件失败：{error}"))?;
    }

    Ok(RestoredBackupPaths {
        manifest,
        database: database_path,
        settings: settings_path,
        resources: resources_dir,
    })
}

#[cfg(test)]
fn extract_backup_archive(
    backup_path: &Path,
    destination_dir: &Path,
) -> Result<(BackupManifest, PathBuf, PathBuf, PathBuf), String> {
    let file = File::open(backup_path).map_err(|error| format!("打开备份失败：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("读取备份压缩包失败：{error}"))?;
    let manifest = read_manifest_from_archive(&mut archive)?;

    let database_path = destination_dir
        .join("database")
        .join(&manifest.database_file);
    extract_archive_file_to_path(
        &mut archive,
        &format!("database/{}", manifest.database_file),
        &database_path,
    )?;

    let settings_path = destination_dir
        .join("settings")
        .join(&manifest.settings_file);
    extract_archive_file_to_path(
        &mut archive,
        &format!("settings/{}", manifest.settings_file),
        &settings_path,
    )?;

    let resources_dir = destination_dir.join(&manifest.resource_directory);
    fs::create_dir_all(&resources_dir).map_err(|error| format!("创建资源恢复目录失败：{error}"))?;

    let resources_prefix = format!("{}/", manifest.resource_directory.trim_end_matches('/'));

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取备份内容失败：{error}"))?;
        let name = entry.name().to_string();

        if name == resources_prefix {
            continue;
        }

        if !name.starts_with(&resources_prefix) {
            continue;
        }

        let relative = &name[resources_prefix.len()..];
        if relative.is_empty() {
            continue;
        }

        let output_path = safe_join_relative(&resources_dir, relative)?;

        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("恢复资源目录失败：{error}"))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("恢复资源目录失败：{error}"))?;
        }

        let mut output =
            File::create(&output_path).map_err(|error| format!("恢复资源文件失败：{error}"))?;
        io::copy(&mut entry, &mut output).map_err(|error| format!("恢复资源文件失败：{error}"))?;
    }

    Ok((manifest, database_path, settings_path, resources_dir))
}

#[derive(Debug)]
struct RestoreRollbackPaths {
    root: Option<TempDir>,
    kept_root: Option<PathBuf>,
    database: PathBuf,
    settings: PathBuf,
    resources: PathBuf,
}

impl RestoreRollbackPaths {
    fn keep_root(&mut self) -> PathBuf {
        if let Some(root) = self.root.take() {
            let path = root.keep();
            self.kept_root = Some(path.clone());
            path
        } else if let Some(path) = &self.kept_root {
            path.clone()
        } else {
            self.database
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_default()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RestorePathKind {
    File,
    Directory,
}

#[derive(Clone, Debug)]
struct RestoreMoveItem {
    source: PathBuf,
    target: PathBuf,
    kind: RestorePathKind,
}

fn is_cross_device_error(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::CrossesDevices {
        return true;
    }

    #[cfg(unix)]
    {
        error.raw_os_error() == Some(18)
    }

    #[cfg(not(unix))]
    {
        false
    }
}

fn cleanup_incomplete_restore_target(target: &Path, kind: RestorePathKind) -> String {
    if !target.exists() {
        return String::new();
    }

    let cleanup_result = match kind {
        RestorePathKind::File => fs::remove_file(target),
        RestorePathKind::Directory => fs::remove_dir_all(target),
    };

    match cleanup_result {
        Ok(_) => String::new(),
        Err(error) => format!("未完成目标路径清理失败：{error}；"),
    }
}

fn copy_file_for_restore(source: &Path, target: &Path) -> Result<(), String> {
    if let Err(error) = fs::copy(source, target) {
        let cleanup_note = cleanup_incomplete_restore_target(target, RestorePathKind::File);
        return Err(format!(
            "复制恢复文件失败：{error}；{cleanup_note}源数据仍保留：{}",
            source.display()
        ));
    }

    fs::remove_file(source).map_err(|error| {
        format!(
            "复制恢复文件已完成，但删除源文件失败：{error}；源数据仍保留：{}；目标路径：{}",
            source.display(),
            target.display()
        )
    })
}

fn copy_directory_for_restore(source: &Path, target: &Path) -> Result<(), String> {
    if let Err(error) = fs::create_dir(target) {
        return Err(format!(
            "创建恢复目标目录失败：{error}；源数据仍保留：{}",
            source.display()
        ));
    }

    for entry in WalkDir::new(source).min_depth(1) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                let cleanup_note =
                    cleanup_incomplete_restore_target(target, RestorePathKind::Directory);
                return Err(format!(
                    "读取恢复目录失败：{error}；{cleanup_note}源数据仍保留：{}",
                    source.display()
                ));
            }
        };

        let relative_path = match entry.path().strip_prefix(source) {
            Ok(relative_path) => relative_path,
            Err(error) => {
                let cleanup_note =
                    cleanup_incomplete_restore_target(target, RestorePathKind::Directory);
                return Err(format!(
                    "解析恢复目录路径失败：{error}；{cleanup_note}源数据仍保留：{}",
                    source.display()
                ));
            }
        };
        let target_path = target.join(relative_path);

        if entry.file_type().is_dir() {
            if let Err(error) = fs::create_dir_all(&target_path) {
                let cleanup_note =
                    cleanup_incomplete_restore_target(target, RestorePathKind::Directory);
                return Err(format!(
                    "复制恢复目录失败：{error}；{cleanup_note}源数据仍保留：{}",
                    source.display()
                ));
            }
            continue;
        }

        if entry.file_type().is_file() {
            if let Some(parent) = target_path.parent() {
                if let Err(error) = fs::create_dir_all(parent) {
                    let cleanup_note =
                        cleanup_incomplete_restore_target(target, RestorePathKind::Directory);
                    return Err(format!(
                        "创建恢复目标目录失败：{error}；{cleanup_note}源数据仍保留：{}",
                        source.display()
                    ));
                }
            }

            if let Err(error) = fs::copy(entry.path(), &target_path) {
                let cleanup_note =
                    cleanup_incomplete_restore_target(target, RestorePathKind::Directory);
                return Err(format!(
                    "复制恢复目录失败：{error}；{cleanup_note}源数据仍保留：{}",
                    source.display()
                ));
            }
            continue;
        }

        let cleanup_note = cleanup_incomplete_restore_target(target, RestorePathKind::Directory);
        return Err(format!(
            "恢复目录包含不支持的路径类型：{}；{cleanup_note}源数据仍保留：{}",
            entry.path().display(),
            source.display()
        ));
    }

    fs::remove_dir_all(source).map_err(|error| {
        format!(
            "复制恢复目录已完成，但删除源目录失败：{error}；源数据仍保留：{}；目标路径：{}",
            source.display(),
            target.display()
        )
    })
}

fn move_path_for_restore(
    source: &Path,
    target: &Path,
    kind: RestorePathKind,
) -> Result<(), String> {
    if target.exists() {
        return Err(format!(
            "目标路径已存在，拒绝覆盖：{}；源数据仍保留：{}",
            target.display(),
            source.display()
        ));
    }

    if !source.exists() {
        return Err(format!("源路径不存在：{}", source.display()));
    }

    match kind {
        RestorePathKind::File if !source.is_file() => {
            return Err(format!(
                "源路径不是文件：{}；源数据仍保留",
                source.display()
            ));
        }
        RestorePathKind::Directory if !source.is_dir() => {
            return Err(format!(
                "源路径不是目录：{}；源数据仍保留",
                source.display()
            ));
        }
        _ => {}
    }

    match fs::rename(source, target) {
        Ok(_) => Ok(()),
        Err(error) if is_cross_device_error(&error) => match kind {
            RestorePathKind::File => copy_file_for_restore(source, target),
            RestorePathKind::Directory => copy_directory_for_restore(source, target),
        },
        Err(error) => Err(format!(
            "移动恢复数据失败：{error}；源数据仍保留：{}",
            source.display()
        )),
    }
}

fn move_existing_path_for_restore(item: &RestoreMoveItem) -> Result<bool, String> {
    if !item.source.exists() {
        return Ok(false);
    }

    move_path_for_restore(&item.source, &item.target, item.kind)?;
    Ok(true)
}

fn copy_file_without_overwrite_for_restore(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Err(format!(
            "目标路径已存在，拒绝覆盖：{}；源数据仍保留：{}",
            target.display(),
            source.display()
        ));
    }

    fs::copy(source, target).map(|_| ()).map_err(|error| {
        format!(
            "复制恢复文件失败：{error}；源数据仍保留：{}",
            source.display()
        )
    })
}

fn build_restore_move_items(
    paths: &AppPaths,
    rollback_paths: &RestoreRollbackPaths,
) -> Vec<RestoreMoveItem> {
    vec![
        RestoreMoveItem {
            source: paths.database.clone(),
            target: rollback_paths.database.clone(),
            kind: RestorePathKind::File,
        },
        RestoreMoveItem {
            source: paths.settings.clone(),
            target: rollback_paths.settings.clone(),
            kind: RestorePathKind::File,
        },
        RestoreMoveItem {
            source: paths.resources.clone(),
            target: rollback_paths.resources.clone(),
            kind: RestorePathKind::Directory,
        },
    ]
}

fn restore_moved_items_after_prepare_failure(
    rollback_paths: &mut RestoreRollbackPaths,
    moved_items: &[RestoreMoveItem],
    cause: String,
) -> BackupError {
    if moved_items.is_empty() {
        return BackupError::new(
            BackupErrorKind::RestorePreparationFailed,
            format!("恢复准备失败：{cause}"),
        );
    }

    let mut restore_errors = Vec::new();
    for item in moved_items.iter().rev() {
        let restore_item = RestoreMoveItem {
            source: item.target.clone(),
            target: item.source.clone(),
            kind: item.kind,
        };

        if let Err(error) = move_path_for_restore(
            &restore_item.source,
            &restore_item.target,
            restore_item.kind,
        ) {
            restore_errors.push(error);
        }
    }

    if restore_errors.is_empty() {
        BackupError::new(
            BackupErrorKind::RestorePreparationFailed,
            format!("恢复准备失败，原始数据已恢复：{cause}"),
        )
    } else {
        let kept_path = rollback_paths.keep_root();
        BackupError::new(
            BackupErrorKind::RestorePreparationFailed,
            format!(
                "恢复准备失败，部分原始数据保留在 rollback 临时目录：{}；原因：{}；恢复错误：{}",
                kept_path.display(),
                cause,
                restore_errors.join("；")
            ),
        )
    }
}

fn prepare_restore_rollback(paths: &AppPaths) -> Result<RestoreRollbackPaths, BackupError> {
    let rollback_root = create_app_temp_dir(paths, "恢复回滚目录")
        .map_err(|error| BackupError::new(BackupErrorKind::RestorePreparationFailed, error))?;
    let rollback_database = rollback_root.path().join("database.rollback");
    let rollback_settings = rollback_root.path().join("settings.rollback");
    let rollback_resources = rollback_root.path().join("resources.rollback");

    let mut rollback_paths = RestoreRollbackPaths {
        root: Some(rollback_root),
        kept_root: None,
        database: rollback_database,
        settings: rollback_settings,
        resources: rollback_resources,
    };
    let move_items = build_restore_move_items(paths, &rollback_paths);
    let mut moved_items = Vec::new();

    for item in move_items {
        match move_existing_path_for_restore(&item) {
            Ok(true) => moved_items.push(item),
            Ok(false) => {}
            Err(error) => {
                return Err(restore_moved_items_after_prepare_failure(
                    &mut rollback_paths,
                    &moved_items,
                    error,
                ));
            }
        }
    }

    Ok(rollback_paths)
}

fn rollback_restored_data(
    paths: &AppPaths,
    rollback_paths: &mut RestoreRollbackPaths,
) -> Result<(), BackupError> {
    let rollback_items = vec![
        RestoreMoveItem {
            source: rollback_paths.database.clone(),
            target: paths.database.clone(),
            kind: RestorePathKind::File,
        },
        RestoreMoveItem {
            source: rollback_paths.settings.clone(),
            target: paths.settings.clone(),
            kind: RestorePathKind::File,
        },
        RestoreMoveItem {
            source: rollback_paths.resources.clone(),
            target: paths.resources.clone(),
            kind: RestorePathKind::Directory,
        },
    ];

    for item in rollback_items {
        if !item.source.exists() {
            continue;
        }

        if let Err(error) = move_path_for_restore(&item.source, &item.target, item.kind) {
            let kept_path = rollback_paths.keep_root();
            return Err(BackupError::new(
                BackupErrorKind::RollbackFailed,
                format!(
                    "回滚本地数据失败：{error}；rollback 临时目录已保留：{}",
                    kept_path.display()
                ),
            ));
        }
    }

    Ok(())
}

fn swap_restore_backup_data(
    paths: &AppPaths,
    restored: &RestoredBackupPaths,
    rollback_paths: &RestoreRollbackPaths,
) -> Result<(), BackupError> {
    move_path_for_restore(&restored.database, &paths.database, RestorePathKind::File).map_err(
        |error| {
            BackupError::new(
                BackupErrorKind::DatabaseRestoreFailed,
                format!("写入恢复后的数据库失败：{error}"),
            )
        },
    )?;

    if let Some(settings_path) = &restored.settings {
        move_path_for_restore(settings_path, &paths.settings, RestorePathKind::File).map_err(
            |error| {
                BackupError::new(
                    BackupErrorKind::SettingsRestoreFailed,
                    format!("写入恢复后的设置失败：{error}"),
                )
            },
        )?;
    } else if rollback_paths.settings.exists() {
        copy_file_without_overwrite_for_restore(&rollback_paths.settings, &paths.settings)
            .map_err(|error| {
                BackupError::new(
                    BackupErrorKind::SettingsRestoreFailed,
                    format!("保留当前设置失败：{error}"),
                )
            })?;
    } else {
        if paths.settings.exists() {
            return Err(BackupError::new(
                BackupErrorKind::SettingsRestoreFailed,
                format!(
                    "写入默认设置失败：目标路径已存在，拒绝覆盖：{}",
                    paths.settings.display()
                ),
            ));
        }
        write_settings_atomically(&paths.settings, &AppSettings::default()).map_err(|error| {
            BackupError::new(
                BackupErrorKind::SettingsRestoreFailed,
                format!("写入默认设置失败：{error}"),
            )
        })?;
    }

    move_path_for_restore(
        &restored.resources,
        &paths.resources,
        RestorePathKind::Directory,
    )
    .map_err(|error| {
        BackupError::new(
            BackupErrorKind::ResourcesRestoreFailed,
            format!("写入恢复后的资源目录失败：{error}"),
        )
    })?;

    Ok(())
}

#[tauri::command]
pub fn load_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    let (_, settings) = ensure_app_environment(&app)?;
    Ok(settings)
}

#[tauri::command]
pub fn save_app_settings(app: AppHandle, update: AppSettingsUpdate) -> Result<AppSettings, String> {
    let (paths, current_settings) = ensure_app_environment(&app)?;
    let should_prune_backups = update.backup_retention_count.is_some();
    let next_settings = merge_app_settings(&current_settings, update)?;
    write_settings_atomically(&paths.settings, &next_settings)?;

    if should_prune_backups {
        prune_old_backups(
            &paths.backups,
            next_settings.backup_retention_count as usize,
        )?;
    }

    Ok(next_settings)
}

#[tauri::command]
pub fn get_data_environment_info(app: AppHandle) -> Result<DataEnvironmentInfo, String> {
    let (paths, _) = ensure_app_environment(&app)?;

    Ok(DataEnvironmentInfo {
        data_dir: paths.root.to_string_lossy().to_string(),
        database_path: paths.database.to_string_lossy().to_string(),
        settings_path: paths.settings.to_string_lossy().to_string(),
        resources_dir: paths.resources.to_string_lossy().to_string(),
        backups_dir: paths.backups.to_string_lossy().to_string(),
        legacy_backups_dir: paths.legacy_backups.to_string_lossy().to_string(),
        cache_dir: paths.cache.to_string_lossy().to_string(),
        webview_cache_dir: paths
            .webview_cache
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        log_dir: paths.log.to_string_lossy().to_string(),
        temp_dir: paths.temp.to_string_lossy().to_string(),
        app_version: app.package_info().version.to_string(),
        database_size_bytes: file_size_bytes(&paths.database),
        resources_size_bytes: directory_size_bytes(&paths.resources),
        backups_size_bytes: directory_size_bytes(&paths.backups),
        cache_size_bytes: cache_size_bytes(&paths),
        webview_cache_size_bytes: paths
            .webview_cache
            .as_deref()
            .map(directory_size_bytes)
            .unwrap_or(0),
        legacy_backups_size_bytes: directory_size_bytes(&paths.legacy_backups),
    })
}

#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<BackupListItem>, String> {
    let (paths, settings) = ensure_app_environment(&app)?;
    prune_old_backups(&paths.backups, settings.backup_retention_count as usize)?;
    list_backup_items(&paths)
}

#[tauri::command]
pub fn validate_backup(app: AppHandle, file_name: String) -> Result<BackupListItem, String> {
    let (paths, _) = ensure_app_environment(&app)?;
    validate_backup_file(&paths, &file_name)
}

#[tauri::command]
pub fn select_restore_backup_file(app: AppHandle) -> Result<SelectRestoreBackupFileResult, String> {
    let (paths, _) = ensure_app_environment(&app)?;
    let Some(path) = FileDialog::new()
        .add_filter("Fight 备份压缩包", &["zip"])
        .set_directory(&paths.backups)
        .pick_file()
    else {
        return Ok(SelectRestoreBackupFileResult::Cancelled);
    };

    let file_name = backup_path_file_name(&path);

    Ok(SelectRestoreBackupFileResult::Selected {
        backup_path: path.to_string_lossy().to_string(),
        file_name,
    })
}

#[tauri::command]
pub fn open_data_directory(app: AppHandle) -> Result<(), String> {
    let (paths, _) = ensure_app_environment(&app)?;
    open_directory(&paths.root, "数据目录")
}

#[tauri::command]
pub fn open_backups_directory(app: AppHandle) -> Result<(), String> {
    let (paths, _) = ensure_app_environment(&app)?;
    open_directory(&paths.backups, "备份目录")
}

#[tauri::command]
pub fn preview_restore_backup(backup_path: String) -> Result<RestoreBackupPreview, String> {
    let backup_path = resolve_restore_backup_path(&backup_path)?;
    preview_restore_backup_path(&backup_path).map_err(BackupError::into_user_message)
}

#[tauri::command]
pub fn create_backup(
    app: AppHandle,
    operation_lock: State<BackupOperationLock>,
) -> Result<CreateBackupResult, String> {
    let _guard = try_acquire_operation(&operation_lock, BackupOperation::Backup)?;
    let (paths, settings) = ensure_app_environment(&app)?;
    create_backup_internal(&app, &paths, &settings, None)
}

#[tauri::command]
pub fn delete_backup(
    app: AppHandle,
    operation_lock: State<BackupOperationLock>,
    file_name: String,
) -> Result<(), String> {
    let _guard = try_acquire_operation(&operation_lock, BackupOperation::Delete)?;
    let (paths, _) = ensure_app_environment(&app)?;
    let backup_path = resolve_backup_file_path(&paths, &file_name)?;

    fs::remove_file(&backup_path).map_err(|error| format!("删除备份文件失败：{error}"))
}

#[tauri::command]
pub fn maybe_run_auto_backup(
    app: AppHandle,
    operation_lock: State<BackupOperationLock>,
) -> Result<AutoBackupResult, String> {
    let Some(_guard) = try_acquire_auto_backup(&operation_lock)? else {
        return Ok(AutoBackupResult {
            status: "skipped-busy".to_string(),
            backup: None,
            warning: None,
        });
    };

    let (paths, mut settings) = ensure_app_environment(&app)?;

    if !settings.auto_backup_enabled {
        return Ok(AutoBackupResult {
            status: "skipped-disabled".to_string(),
            backup: None,
            warning: None,
        });
    }

    if !has_auto_backup_interval_elapsed(
        settings.last_auto_backup_date.as_deref(),
        settings.backup_frequency_days,
    )? {
        return Ok(AutoBackupResult {
            status: "skipped-not-due".to_string(),
            backup: None,
            warning: None,
        });
    }

    if !paths.database.exists() {
        return Ok(AutoBackupResult {
            status: "skipped-missing-database".to_string(),
            backup: None,
            warning: Some("当前数据库文件尚未创建，本次自动备份已跳过。".to_string()),
        });
    }

    let result = create_backup_internal(&app, &paths, &settings, Some("自动备份"))?;
    let today = format_today_key();
    settings.last_auto_backup_date = Some(today);
    write_settings_atomically(&paths.settings, &settings)?;

    Ok(AutoBackupResult {
        status: "created".to_string(),
        backup: Some(result.backup),
        warning: result.warning,
    })
}

#[tauri::command]
pub fn restore_backup(
    app: AppHandle,
    operation_lock: State<BackupOperationLock>,
    backup_path: String,
) -> Result<RestoreBackupResult, String> {
    let _guard = try_acquire_operation(&operation_lock, BackupOperation::Restore)?;

    let (paths, _) = ensure_app_environment(&app)?;
    let backup_path = resolve_restore_backup_path(&backup_path)?;
    let restored_file_name = backup_path_file_name(&backup_path);

    emit_restore_progress(
        &app,
        RestoreProgressStage::ReadingBackupInfo,
        "正在读取备份信息",
    );
    let mut archive = with_backup_stage("restore_backup.open_archive", || {
        open_backup_archive(&backup_path)
    })
    .map_err(BackupError::into_user_message)?;
    let manifest = with_backup_stage("restore_backup.read_manifest", || {
        read_manifest_with_diagnostic(&mut archive)
    })
    .map_err(BackupError::into_user_message)?;

    emit_restore_progress(
        &app,
        RestoreProgressStage::CheckingBackupFormat,
        "正在检查备份格式",
    );
    ensure_manifest_schema_supported(&manifest).map_err(BackupError::into_user_message)?;

    let temp_dir = create_app_temp_dir(&paths, "恢复临时目录").map_err(|error| {
        BackupError::new(BackupErrorKind::RestorePreparationFailed, error).into_user_message()
    })?;
    let extract_dir = temp_dir.path().join("extracted");

    emit_restore_progress(&app, RestoreProgressStage::ExtractingBackup, "正在解压备份");
    let restored = with_backup_stage("restore_backup.extract_archive", || {
        fs::create_dir_all(&extract_dir).map_err(|error| {
            BackupError::new(
                BackupErrorKind::RestorePreparationFailed,
                format!("创建恢复临时目录失败：{error}"),
            )
        })?;

        extract_restore_backup_archive(&backup_path, &extract_dir).map_err(|error| {
            if error.contains("清单") || error.contains("manifest") {
                BackupError::new(BackupErrorKind::ManifestInvalid, error)
            } else if error.contains("设置") {
                BackupError::new(BackupErrorKind::SettingsInvalid, error)
            } else if error.contains("资源") {
                BackupError::new(BackupErrorKind::ResourcesInvalid, error)
            } else if error.contains("压缩包") || error.contains("备份内容") {
                BackupError::new(BackupErrorKind::ZipReadFailed, error)
            } else {
                BackupError::new(BackupErrorKind::DatabaseInvalid, error)
            }
        })
    })
    .map_err(BackupError::into_user_message)?;

    emit_restore_progress(
        &app,
        RestoreProgressStage::CheckingDatabase,
        "正在检查核心数据库",
    );
    with_backup_stage("restore_backup.validate_extracted_data", || {
        validate_database_file_for_schema(&restored.database, restored.manifest.schema_version)
            .map_err(map_schema_validation_error)?;
        if let Some(settings_path) = &restored.settings {
            read_settings_from_path(settings_path)
                .map_err(|error| BackupError::new(BackupErrorKind::SettingsInvalid, error))?;
        }
        ensure_directory(&restored.resources, "恢复资源目录")
            .map_err(|error| BackupError::new(BackupErrorKind::ResourcesInvalid, error))?;

        Ok(())
    })
    .map_err(BackupError::into_user_message)?;

    emit_restore_progress(
        &app,
        RestoreProgressStage::ReplacingLocalData,
        "正在替换本地数据",
    );
    let mut rollback_paths = with_backup_stage("restore_backup.prepare_rollback", || {
        prepare_restore_rollback(&paths)
    })
    .map_err(BackupError::into_user_message)?;

    if let Err(error) = with_backup_stage("restore_backup.swap_data", || {
        swap_restore_backup_data(&paths, &restored, &rollback_paths)
    }) {
        if let Err(rollback_error) = with_backup_stage("restore_backup.rollback", || {
            rollback_restored_data(&paths, &mut rollback_paths)
        }) {
            return Err(rollback_error.into_user_message());
        }

        return Err(error.into_user_message());
    }

    with_backup_stage("restore_backup.finalize", || Ok(()))
        .map_err(BackupError::into_user_message)?;

    Ok(RestoreBackupResult { restored_file_name })
}

#[cfg(test)]
mod tests {
    use super::{
        add_resources_to_zip, build_created_backup_list_item, cache_size_bytes,
        cleanup_legacy_backups_once, directory_size_bytes, extract_backup_archive,
        is_legacy_backups_cleanup_target, legacy_cleanup_marker_path, list_backup_items,
        move_path_for_restore, prepare_restore_rollback, resolve_backup_file_path,
        resolve_document_backups_dir, resource_file_compression_method,
        restore_moved_items_after_prepare_failure, rollback_restored_data, validate_backup_archive,
        validate_backup_file, validate_database_file_for_schema, validate_manifest_archive_paths,
        zip_dir_options, zip_file_options, AppPaths, AppSettings, BackupErrorKind, BackupManifest,
        BackupValidationStatus, RestoreMoveItem, RestorePathKind, RestoreRollbackPaths,
        CURRENT_SCHEMA_VERSION, DOCUMENT_BACKUPS_DIR_NAME, DOCUMENT_DIR_UNAVAILABLE_MESSAGE,
    };
    use rusqlite::Connection;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use tempfile::{tempdir, tempdir_in};
    use zip::{CompressionMethod, ZipWriter};

    fn create_temp_database(schema_sql: &str) -> std::path::PathBuf {
        let temp_dir = tempdir().expect("create temp dir");
        let path = temp_dir.path().join("test.db");
        let connection = Connection::open(&path).expect("open temp db");
        connection
            .execute_batch(schema_sql)
            .expect("create schema for test");
        drop(connection);
        std::mem::forget(temp_dir);
        path
    }

    fn create_test_paths(root: &Path) -> AppPaths {
        let backups = root.join("Documents").join(DOCUMENT_BACKUPS_DIR_NAME);
        fs::create_dir_all(&backups).expect("create backups dir");

        AppPaths {
            root: root.to_path_buf(),
            database: root.join("fight-notes.db"),
            settings: root.join("app-settings.json"),
            resources: root.join("resources"),
            backups,
            legacy_backups: root.join("backups"),
            cache: root.join("cache"),
            webview_cache: Some(root.join("webkit-cache")),
            log: root.join("logs"),
            temp: root.join("tmp"),
        }
    }

    #[test]
    fn resolve_document_backups_dir_uses_documents_backup_folder() {
        let documents = PathBuf::from("/tmp/Documents");
        let backups =
            resolve_document_backups_dir::<String>(Ok(documents.clone())).expect("resolve backups");

        assert_eq!(backups, documents.join(DOCUMENT_BACKUPS_DIR_NAME));
    }

    #[test]
    fn resolve_document_backups_dir_does_not_fallback_when_documents_missing() {
        let error = resolve_document_backups_dir::<&str>(Err("missing documents"))
            .expect_err("missing documents should fail");

        assert_eq!(error, DOCUMENT_DIR_UNAVAILABLE_MESSAGE);
    }

    #[test]
    fn legacy_backups_cleanup_target_requires_exact_app_config_backups_path() {
        let temp_dir = tempdir().expect("create temp dir");
        let root = temp_dir.path();

        assert!(is_legacy_backups_cleanup_target(
            root,
            &root.join("backups")
        ));
        assert!(!is_legacy_backups_cleanup_target(root, root));
        assert!(!is_legacy_backups_cleanup_target(
            root,
            &root.join("fight-notes.db")
        ));
        assert!(!is_legacy_backups_cleanup_target(
            root,
            &root.join("app-settings.json")
        ));
        assert!(!is_legacy_backups_cleanup_target(
            root,
            &root.join("resources")
        ));
        assert!(!is_legacy_backups_cleanup_target(
            root,
            &root.join("backup")
        ));
    }

    #[test]
    fn cleanup_legacy_backups_once_removes_only_legacy_dir_and_writes_marker() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        fs::create_dir_all(&paths.legacy_backups).expect("create legacy backups");
        fs::write(paths.legacy_backups.join("old.zip"), b"old backup").expect("write old backup");
        fs::write(&paths.database, b"database").expect("write database");
        fs::write(&paths.settings, b"settings").expect("write settings");
        fs::create_dir_all(&paths.resources).expect("create resources");

        cleanup_legacy_backups_once(&paths);

        assert!(!paths.legacy_backups.exists());
        assert!(paths.database.exists());
        assert!(paths.settings.exists());
        assert!(paths.resources.exists());
        assert!(legacy_cleanup_marker_path(&paths).exists());
    }

    #[test]
    fn cleanup_legacy_backups_once_skips_when_marker_exists() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        fs::create_dir_all(&paths.legacy_backups).expect("create legacy backups");
        fs::write(paths.legacy_backups.join("old.zip"), b"old backup").expect("write old backup");
        fs::write(legacy_cleanup_marker_path(&paths), b"done\n").expect("write marker");

        cleanup_legacy_backups_once(&paths);

        assert!(paths.legacy_backups.exists());
        assert!(paths.legacy_backups.join("old.zip").exists());
    }

    #[test]
    fn resolve_backup_file_path_uses_documents_backup_folder_and_rejects_path_traversal() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        let backup_path = paths.backups.join("valid.zip");
        fs::write(&backup_path, b"backup").expect("write backup");

        assert_eq!(
            resolve_backup_file_path(&paths, "valid.zip").expect("resolve backup"),
            backup_path
        );
        assert!(resolve_backup_file_path(&paths, "../valid.zip").is_err());
        assert!(resolve_backup_file_path(&paths, "nested/valid.zip").is_err());
    }

    fn write_backup_archive(
        backup_path: &Path,
        manifest: Option<&BackupManifest>,
        database_path: Option<&Path>,
        settings_bytes: Option<&[u8]>,
        include_resources_dir: bool,
    ) {
        let file = File::create(backup_path).expect("create backup archive");
        let mut zip = ZipWriter::new(file);

        if let Some(manifest) = manifest {
            zip.add_directory("database/", zip_dir_options())
                .expect("add database dir");
            zip.add_directory("settings/", zip_dir_options())
                .expect("add settings dir");
            zip.start_file("manifest.json", zip_file_options())
                .expect("start manifest");
            zip.write_all(
                serde_json::to_string(manifest)
                    .expect("serialize manifest")
                    .as_bytes(),
            )
            .expect("write manifest");

            if let Some(database_path) = database_path {
                zip.start_file(
                    format!("database/{}", manifest.database_file),
                    zip_file_options(),
                )
                .expect("start db");
                zip.write_all(&fs::read(database_path).expect("read database file"))
                    .expect("write db");
            }

            if let Some(settings_bytes) = settings_bytes {
                zip.start_file(
                    format!("settings/{}", manifest.settings_file),
                    zip_file_options(),
                )
                .expect("start settings");
                zip.write_all(settings_bytes).expect("write settings");
            }

            if include_resources_dir {
                zip.add_directory(
                    format!("{}/", manifest.resource_directory.trim_end_matches('/')),
                    zip_dir_options(),
                )
                .expect("add resources dir");
            }
        }

        zip.finish().expect("finish archive");
    }

    fn create_valid_manifest(schema_version: Option<u32>) -> BackupManifest {
        BackupManifest {
            format_version: 1,
            schema_version,
            app_version: "0.1.0".to_string(),
            created_at: "2026-04-08 12:34:56".to_string(),
            database_file: "fight-notes.db".to_string(),
            resource_directory: "resources".to_string(),
            settings_file: "app-settings.json".to_string(),
            note: String::new(),
            note_count: None,
            resource_count: None,
        }
    }

    #[test]
    fn restore_manifest_accepts_legal_archive_paths() {
        let manifest = create_valid_manifest(Some(CURRENT_SCHEMA_VERSION));

        validate_manifest_archive_paths(&manifest).expect("valid manifest paths");
    }

    #[test]
    fn restore_manifest_rejects_database_file_unsafe_paths() {
        let temp_dir = tempdir().expect("create temp dir");
        let invalid_values = vec![
            temp_dir
                .path()
                .join("fight-notes.db")
                .to_string_lossy()
                .to_string(),
            "../fight-notes.db".to_string(),
            "nested/fight-notes.db".to_string(),
            "nested\\fight-notes.db".to_string(),
        ];

        for value in invalid_values {
            let mut manifest = create_valid_manifest(Some(CURRENT_SCHEMA_VERSION));
            manifest.database_file = value.clone();

            let error = validate_manifest_archive_paths(&manifest)
                .expect_err("unsafe database path should fail");

            assert!(
                error.contains("数据库文件路径"),
                "unexpected error for {value}: {error}"
            );
        }
    }

    #[test]
    fn restore_manifest_rejects_settings_file_unsafe_paths() {
        let temp_dir = tempdir().expect("create temp dir");
        let invalid_values = vec![
            temp_dir
                .path()
                .join("app-settings.json")
                .to_string_lossy()
                .to_string(),
            "../app-settings.json".to_string(),
            "nested/app-settings.json".to_string(),
            "nested\\app-settings.json".to_string(),
        ];

        for value in invalid_values {
            let mut manifest = create_valid_manifest(Some(CURRENT_SCHEMA_VERSION));
            manifest.settings_file = value.clone();

            let error = validate_manifest_archive_paths(&manifest)
                .expect_err("unsafe settings path should fail");

            assert!(
                error.contains("设置文件路径"),
                "unexpected error for {value}: {error}"
            );
        }
    }

    #[test]
    fn restore_manifest_rejects_resource_directory_unsafe_paths() {
        let temp_dir = tempdir().expect("create temp dir");
        let invalid_values = vec![
            temp_dir
                .path()
                .join("resources")
                .to_string_lossy()
                .to_string(),
            "../resources".to_string(),
            "nested/resources".to_string(),
            "nested\\resources".to_string(),
        ];

        for value in invalid_values {
            let mut manifest = create_valid_manifest(Some(CURRENT_SCHEMA_VERSION));
            manifest.resource_directory = value.clone();

            let error = validate_manifest_archive_paths(&manifest)
                .expect_err("unsafe resource directory should fail");

            assert!(
                error.contains("资源目录路径"),
                "unexpected error for {value}: {error}"
            );
        }
    }

    fn create_v5_database() -> PathBuf {
        create_temp_database(
            "
            CREATE TABLE notebooks (id INTEGER PRIMARY KEY);
            CREATE TABLE folders (id INTEGER PRIMARY KEY);
            CREATE TABLE notes (id INTEGER PRIMARY KEY);
            CREATE VIRTUAL TABLE note_search USING fts5(title, body_plaintext);
            CREATE TABLE tags (id INTEGER PRIMARY KEY);
            CREATE TABLE note_tags (note_id INTEGER, tag_id INTEGER);
            CREATE TABLE review_plans (id INTEGER PRIMARY KEY);
            CREATE TABLE review_plan_steps (id INTEGER PRIMARY KEY);
            CREATE TABLE note_review_bindings (note_id INTEGER PRIMARY KEY);
            CREATE TABLE review_tasks (id INTEGER PRIMARY KEY);
            CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            ",
        )
    }

    fn create_v6_database() -> PathBuf {
        create_temp_database(
            "
            CREATE TABLE notebooks (id INTEGER PRIMARY KEY);
            CREATE TABLE folders (id INTEGER PRIMARY KEY);
            CREATE TABLE notes (id INTEGER PRIMARY KEY);
            CREATE VIRTUAL TABLE note_search USING fts5(title, body_plaintext);
            CREATE TABLE tags (id INTEGER PRIMARY KEY);
            CREATE TABLE note_tags (note_id INTEGER, tag_id INTEGER);
            CREATE TABLE review_plans (id INTEGER PRIMARY KEY);
            CREATE TABLE review_plan_steps (id INTEGER PRIMARY KEY);
            CREATE TABLE note_review_bindings (note_id INTEGER PRIMARY KEY);
            CREATE TABLE review_tasks (id INTEGER PRIMARY KEY);
            CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE note_tag_occurrences (id INTEGER PRIMARY KEY, note_id INTEGER, tag_id INTEGER);
            ",
        )
    }

    fn create_v7_database() -> PathBuf {
        create_temp_database(
            "
            CREATE TABLE notebooks (id INTEGER PRIMARY KEY);
            CREATE TABLE folders (id INTEGER PRIMARY KEY);
            CREATE TABLE notes (id INTEGER PRIMARY KEY);
            CREATE VIRTUAL TABLE note_search USING fts5(title, body_plaintext);
            CREATE TABLE tags (id INTEGER PRIMARY KEY);
            CREATE TABLE note_tags (note_id INTEGER, tag_id INTEGER);
            CREATE TABLE review_plans (id INTEGER PRIMARY KEY);
            CREATE TABLE review_plan_steps (id INTEGER PRIMARY KEY);
            CREATE TABLE note_review_bindings (note_id INTEGER PRIMARY KEY);
            CREATE TABLE review_tasks (id INTEGER PRIMARY KEY);
            CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE note_tag_occurrences (
              id INTEGER PRIMARY KEY,
              note_id INTEGER,
              tag_id INTEGER,
              remark_text TEXT
            );
            ",
        )
    }

    #[test]
    fn accepts_legacy_v4_backup_without_schema_version() {
        let path = create_temp_database(
            "
            CREATE TABLE notebooks (id INTEGER PRIMARY KEY);
            CREATE TABLE folders (id INTEGER PRIMARY KEY);
            CREATE TABLE notes (id INTEGER PRIMARY KEY);
            CREATE VIRTUAL TABLE note_search USING fts5(title, body_plaintext);
            CREATE TABLE tags (id INTEGER PRIMARY KEY);
            CREATE TABLE note_tags (note_id INTEGER, tag_id INTEGER);
            CREATE TABLE review_plans (id INTEGER PRIMARY KEY);
            CREATE TABLE review_plan_steps (id INTEGER PRIMARY KEY);
            CREATE TABLE note_review_bindings (note_id INTEGER PRIMARY KEY);
            CREATE TABLE review_tasks (id INTEGER PRIMARY KEY);
            ",
        );

        let inferred_version =
            validate_database_file_for_schema(&path, None).expect("validate v4 backup");

        assert_eq!(inferred_version, 4);
    }

    #[test]
    fn rejects_half_upgraded_database_shape() {
        let path = create_temp_database(
            "
            CREATE TABLE notebooks (id INTEGER PRIMARY KEY);
            CREATE TABLE folders (id INTEGER PRIMARY KEY);
            CREATE TABLE notes (id INTEGER PRIMARY KEY);
            CREATE VIRTUAL TABLE note_search USING fts5(title, body_plaintext);
            CREATE TABLE tags (id INTEGER PRIMARY KEY);
            ",
        );

        let error =
            validate_database_file_for_schema(&path, None).expect_err("reject broken backup");

        assert!(error.contains("结构") || error.contains("无法恢复"));
    }

    #[test]
    fn accepts_current_v7_schema_when_declared() {
        let path = create_temp_database(
            "
            CREATE TABLE notebooks (id INTEGER PRIMARY KEY);
            CREATE TABLE folders (id INTEGER PRIMARY KEY);
            CREATE TABLE notes (id INTEGER PRIMARY KEY);
            CREATE VIRTUAL TABLE note_search USING fts5(title, body_plaintext);
            CREATE TABLE tags (id INTEGER PRIMARY KEY);
            CREATE TABLE note_tags (note_id INTEGER, tag_id INTEGER);
            CREATE TABLE review_plans (id INTEGER PRIMARY KEY);
            CREATE TABLE review_plan_steps (id INTEGER PRIMARY KEY);
            CREATE TABLE note_review_bindings (note_id INTEGER PRIMARY KEY);
            CREATE TABLE review_tasks (id INTEGER PRIMARY KEY);
            CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE note_tag_occurrences (
              id INTEGER PRIMARY KEY,
              note_id INTEGER,
              tag_id INTEGER,
              remark_text TEXT
            );
            ",
        );

        let version =
            validate_database_file_for_schema(&path, Some(7)).expect("validate v7 backup");

        assert_eq!(version, 7);
    }

    #[test]
    fn accepts_legacy_v5_schema_when_declared() {
        let path = create_v5_database();

        let version =
            validate_database_file_for_schema(&path, Some(5)).expect("validate v5 backup");

        assert_eq!(version, 5);
    }

    #[test]
    fn extract_backup_archive_restores_images_and_covers_subdirectories() {
        let temp_dir = tempdir().expect("create temp dir");
        let backup_path = temp_dir.path().join("sample-backup.zip");
        let database_path = temp_dir.path().join("fight-notes.db");
        let settings_path = temp_dir.path().join("app-settings.json");
        let resources_dir = temp_dir.path().join("resources");
        let images_dir = resources_dir.join("images");
        let covers_dir = resources_dir.join("covers");

        fs::create_dir_all(&images_dir).expect("create images dir");
        fs::create_dir_all(&covers_dir).expect("create covers dir");
        fs::write(&database_path, b"sqlite-placeholder").expect("write database placeholder");
        fs::write(
            &settings_path,
            serde_json::to_vec(&AppSettings::default()).expect("serialize app settings"),
        )
        .expect("write settings");
        fs::write(images_dir.join("note-image.png"), b"note-image").expect("write note image");
        fs::write(covers_dir.join("cover-image.jpg"), b"cover-image").expect("write cover image");

        let manifest = BackupManifest {
            format_version: 1,
            schema_version: Some(CURRENT_SCHEMA_VERSION),
            app_version: "test".to_string(),
            created_at: "2026-04-07 10:00:00".to_string(),
            database_file: "fight-notes.db".to_string(),
            resource_directory: "resources".to_string(),
            settings_file: "app-settings.json".to_string(),
            note: String::new(),
            note_count: None,
            resource_count: None,
        };

        let file = File::create(&backup_path).expect("create backup archive");
        let mut zip = ZipWriter::new(file);
        zip.add_directory("database/", zip_dir_options())
            .expect("add database dir");
        zip.add_directory("settings/", zip_dir_options())
            .expect("add settings dir");
        zip.start_file("manifest.json", zip_file_options())
            .expect("start manifest");
        zip.write_all(
            serde_json::to_string(&manifest)
                .expect("serialize manifest")
                .as_bytes(),
        )
        .expect("write manifest");
        zip.start_file("database/fight-notes.db", zip_file_options())
            .expect("start db");
        zip.write_all(b"sqlite-placeholder").expect("write db");
        zip.start_file("settings/app-settings.json", zip_file_options())
            .expect("start settings");
        zip.write_all(
            serde_json::to_string(&AppSettings::default())
                .expect("serialize settings")
                .as_bytes(),
        )
        .expect("write settings");
        add_resources_to_zip(&mut zip, &resources_dir, "resources").expect("add resources");
        zip.finish().expect("finish archive");

        let extract_dir = temp_dir.path().join("extracted");
        fs::create_dir_all(&extract_dir).expect("create extract dir");

        let (_manifest, _database, _settings, restored_resources) =
            extract_backup_archive(&backup_path, &extract_dir).expect("extract archive");

        assert!(restored_resources.join("images").is_dir());
        assert!(restored_resources.join("images/note-image.png").is_file());
        assert!(restored_resources.join("covers").is_dir());
        assert!(restored_resources.join("covers/cover-image.jpg").is_file());
    }

    #[test]
    fn resource_file_compression_method_uses_stored_for_images_and_deflated_for_others() {
        assert_eq!(
            resource_file_compression_method(Path::new("resources/images/example.png")),
            CompressionMethod::Stored
        );
        assert_eq!(
            resource_file_compression_method(Path::new("resources/covers/example.WEBP")),
            CompressionMethod::Stored
        );
        assert_eq!(
            resource_file_compression_method(Path::new("resources/notes/example.txt")),
            CompressionMethod::Deflated
        );
    }

    #[test]
    fn build_created_backup_list_item_maps_manifest_note_and_size() {
        let temp_dir = tempdir().expect("create temp dir");
        let backup_path = temp_dir.path().join("sample-backup.zip");
        fs::write(&backup_path, b"zip-data").expect("write backup");
        let manifest = BackupManifest {
            format_version: 1,
            schema_version: Some(CURRENT_SCHEMA_VERSION),
            app_version: "0.1.0".to_string(),
            created_at: "2026-04-08 12:34:56".to_string(),
            database_file: "fight-notes.db".to_string(),
            resource_directory: "resources".to_string(),
            settings_file: "app-settings.json".to_string(),
            note: "自动备份".to_string(),
            note_count: None,
            resource_count: None,
        };

        let item =
            build_created_backup_list_item(&backup_path, &manifest).expect("build backup item");

        assert_eq!(item.file_name, "sample-backup.zip");
        assert_eq!(item.created_at, "2026-04-08 12:34:56");
        assert_eq!(item.size_bytes, 8);
        assert_eq!(item.validation_status, BackupValidationStatus::Valid);
        assert_eq!(item.invalid_reason, None);
        assert_eq!(item.note, Some("自动备份".to_string()));
    }

    #[test]
    fn list_backup_items_keeps_broken_zip_as_unknown() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        fs::write(paths.backups.join("broken.zip"), b"not-a-zip").expect("write broken zip");

        let items = list_backup_items(&paths).expect("list backup items");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].file_name, "broken.zip");
        assert_eq!(items[0].validation_status, BackupValidationStatus::Unknown);
        assert_eq!(items[0].invalid_reason, None);
    }

    #[test]
    fn list_backup_items_sorts_by_created_at_then_file_name_desc() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        fs::write(paths.backups.join("alpha.zip"), b"a").expect("write alpha");
        fs::write(paths.backups.join("beta.zip"), b"b").expect("write beta");

        let items = list_backup_items(&paths).expect("list backup items");

        assert!(items.windows(2).all(|pair| {
            pair[0].created_at > pair[1].created_at
                || (pair[0].created_at == pair[1].created_at
                    && pair[0].file_name >= pair[1].file_name)
        }));
    }

    #[test]
    fn validate_backup_file_returns_valid_for_legal_backup() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        let backup_path = paths.backups.join("valid.zip");
        let manifest = create_valid_manifest(Some(CURRENT_SCHEMA_VERSION));
        let database_path = create_v7_database();
        let settings_bytes =
            serde_json::to_vec(&AppSettings::default()).expect("serialize settings");

        write_backup_archive(
            &backup_path,
            Some(&manifest),
            Some(&database_path),
            Some(&settings_bytes),
            true,
        );

        let item = validate_backup_file(&paths, "valid.zip").expect("validate backup file");

        assert_eq!(item.validation_status, BackupValidationStatus::Valid);
        assert_eq!(item.invalid_reason, None);
    }

    #[test]
    fn validate_backup_file_returns_invalid_for_broken_zip() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        fs::write(paths.backups.join("broken.zip"), b"not-a-zip").expect("write broken zip");

        let item = validate_backup_file(&paths, "broken.zip").expect("validate broken zip");

        assert_eq!(item.validation_status, BackupValidationStatus::Invalid);
        assert_eq!(
            item.invalid_reason.as_deref(),
            Some("备份压缩包无法读取或已损坏。")
        );
    }

    #[test]
    fn validate_backup_file_returns_invalid_for_missing_manifest() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        write_backup_archive(
            &paths.backups.join("missing-manifest.zip"),
            None,
            None,
            None,
            false,
        );

        let item = validate_backup_file(&paths, "missing-manifest.zip")
            .expect("validate backup without manifest");

        assert_eq!(item.validation_status, BackupValidationStatus::Invalid);
        assert_eq!(
            item.invalid_reason.as_deref(),
            Some("备份清单缺失或损坏，无法恢复。")
        );
    }

    #[test]
    fn validate_backup_file_returns_invalid_for_incompatible_schema_version() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        let database_path = create_v7_database();
        let settings_bytes =
            serde_json::to_vec(&AppSettings::default()).expect("serialize settings");
        let manifest = create_valid_manifest(Some(CURRENT_SCHEMA_VERSION + 1));

        write_backup_archive(
            &paths.backups.join("future-schema.zip"),
            Some(&manifest),
            Some(&database_path),
            Some(&settings_bytes),
            true,
        );

        let item = validate_backup_file(&paths, "future-schema.zip")
            .expect("validate incompatible schema backup");

        assert_eq!(item.validation_status, BackupValidationStatus::Invalid);
        assert_eq!(
            item.invalid_reason.as_deref(),
            Some("当前应用不支持恢复该数据库版本的备份。")
        );
    }

    #[test]
    fn validate_backup_archive_classifies_invalid_settings() {
        let temp_dir = tempdir().expect("create temp dir");
        let backup_path = temp_dir.path().join("invalid-settings.zip");
        let database_path = create_v7_database();
        let manifest = create_valid_manifest(Some(CURRENT_SCHEMA_VERSION));

        write_backup_archive(
            &backup_path,
            Some(&manifest),
            Some(&database_path),
            Some(br#"{"theme":"blue","autoBackupEnabled":"bad"}"#),
            true,
        );

        let error = validate_backup_archive(&backup_path, &temp_dir.path().join("app-temp"))
            .expect_err("invalid settings should fail");

        assert_eq!(error.kind, BackupErrorKind::SettingsInvalid);
        assert_eq!(error.user_message(), "备份中的应用设置无效，无法恢复。");
    }

    #[test]
    fn validate_backup_archive_classifies_missing_resources_directory() {
        let temp_dir = tempdir().expect("create temp dir");
        let backup_path = temp_dir.path().join("missing-resources.zip");
        let database_path = create_v7_database();
        let manifest = create_valid_manifest(Some(CURRENT_SCHEMA_VERSION));
        let settings_bytes =
            serde_json::to_vec(&AppSettings::default()).expect("serialize settings");

        write_backup_archive(
            &backup_path,
            Some(&manifest),
            Some(&database_path),
            Some(&settings_bytes),
            false,
        );

        let error = validate_backup_archive(&backup_path, &temp_dir.path().join("app-temp"))
            .expect_err("missing resources should fail");

        assert_eq!(error.kind, BackupErrorKind::ResourcesInvalid);
        assert_eq!(error.user_message(), "备份中的资源目录结构无效，无法恢复。");
    }

    #[test]
    fn validate_backup_archive_uses_app_temp_parent() {
        let temp_dir = tempdir().expect("create temp dir");
        let backup_path = temp_dir.path().join("valid.zip");
        let app_temp = temp_dir.path().join("app-temp");
        let database_path = create_v7_database();
        let manifest = create_valid_manifest(Some(CURRENT_SCHEMA_VERSION));
        let settings_bytes =
            serde_json::to_vec(&AppSettings::default()).expect("serialize settings");

        write_backup_archive(
            &backup_path,
            Some(&manifest),
            Some(&database_path),
            Some(&settings_bytes),
            true,
        );

        validate_backup_archive(&backup_path, &app_temp).expect("valid backup");

        assert!(app_temp.exists());
    }

    #[test]
    fn move_path_for_restore_rejects_existing_target_and_keeps_source() {
        let temp_dir = tempdir().expect("create temp dir");
        let source = temp_dir.path().join("source.db");
        let target = temp_dir.path().join("target.db");
        fs::write(&source, b"source").expect("write source");
        fs::write(&target, b"target").expect("write target");

        let error = move_path_for_restore(&source, &target, RestorePathKind::File)
            .expect_err("existing target should fail");

        assert!(error.contains("拒绝覆盖"));
        assert!(error.contains(&target.to_string_lossy().to_string()));
        assert_eq!(fs::read(&source).expect("read source"), b"source");
        assert_eq!(fs::read(&target).expect("read target"), b"target");
    }

    #[test]
    fn move_path_for_restore_moves_file() {
        let temp_dir = tempdir().expect("create temp dir");
        let source = temp_dir.path().join("source.db");
        let target = temp_dir.path().join("target.db");
        fs::write(&source, b"database").expect("write source");

        move_path_for_restore(&source, &target, RestorePathKind::File).expect("move file");

        assert!(!source.exists());
        assert_eq!(fs::read(&target).expect("read target"), b"database");
    }

    #[test]
    fn move_path_for_restore_moves_directory() {
        let temp_dir = tempdir().expect("create temp dir");
        let source = temp_dir.path().join("resources");
        let target = temp_dir.path().join("resources-target");
        fs::create_dir_all(source.join("images")).expect("create source dir");
        fs::write(source.join("images/note.png"), b"image").expect("write image");

        move_path_for_restore(&source, &target, RestorePathKind::Directory).expect("move dir");

        assert!(!source.exists());
        assert_eq!(
            fs::read(target.join("images/note.png")).expect("read target image"),
            b"image"
        );
    }

    #[test]
    fn move_path_for_restore_failure_keeps_source_data() {
        let temp_dir = tempdir().expect("create temp dir");
        let source = temp_dir.path().join("source-file");
        let target = temp_dir.path().join("target-dir");
        fs::write(&source, b"source").expect("write source");

        let error = move_path_for_restore(&source, &target, RestorePathKind::Directory)
            .expect_err("kind mismatch should fail");

        assert!(error.contains("源数据仍保留"));
        assert_eq!(fs::read(&source).expect("read source"), b"source");
        assert!(!target.exists());
    }

    #[test]
    fn prepare_restore_rollback_restores_database_when_settings_move_fails() {
        let temp_dir = tempdir().expect("create temp dir");
        let app_root = temp_dir.path().join("app-config");
        let mut paths = create_test_paths(&app_root);
        paths.temp = temp_dir.path().join("app-temp");
        fs::write(&paths.database, b"live-database").expect("write live database");
        fs::create_dir_all(&paths.settings).expect("create invalid settings dir");

        let error = prepare_restore_rollback(&paths)
            .expect_err("settings directory should fail rollback preparation");

        assert_eq!(error.kind, BackupErrorKind::RestorePreparationFailed);
        assert!(error.detail.contains("原始数据已恢复"));
        assert_eq!(
            fs::read(&paths.database).expect("read restored database"),
            b"live-database"
        );
        assert!(paths.settings.is_dir());
        assert_eq!(fs::read_dir(&paths.temp).expect("read app temp").count(), 0);
    }

    #[test]
    fn prepare_restore_failure_keeps_rollback_temp_when_restore_fails() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        fs::create_dir_all(&paths.temp).expect("create app temp");
        let rollback_root = tempdir_in(&paths.temp).expect("create rollback root");
        let rollback_database = rollback_root.path().join("database.rollback");
        fs::write(&rollback_database, b"rollback-database").expect("write rollback database");
        fs::write(&paths.database, b"conflict-database").expect("write conflict database");

        let mut rollback_paths = RestoreRollbackPaths {
            root: Some(rollback_root),
            kept_root: None,
            database: rollback_database.clone(),
            settings: paths.temp.join("settings.rollback"),
            resources: paths.temp.join("resources.rollback"),
        };
        let moved_items = vec![RestoreMoveItem {
            source: paths.database.clone(),
            target: rollback_database.clone(),
            kind: RestorePathKind::File,
        }];

        let error = restore_moved_items_after_prepare_failure(
            &mut rollback_paths,
            &moved_items,
            "settings move failed".to_string(),
        );

        assert_eq!(error.kind, BackupErrorKind::RestorePreparationFailed);
        assert!(error.detail.contains("rollback 临时目录"));
        assert!(error
            .detail
            .contains(&paths.database.to_string_lossy().to_string()));
        let kept_root = rollback_paths
            .kept_root
            .clone()
            .expect("rollback root should be kept");
        assert!(kept_root.exists());
        assert!(rollback_database.exists());
        assert_eq!(
            fs::read(&paths.database).expect("read conflict database"),
            b"conflict-database"
        );
    }

    #[test]
    fn restore_interruption_probe_confirms_live_paths_are_missing_after_prepare_rollback() {
        let temp_dir = tempdir().expect("create temp dir");
        let app_root = temp_dir.path().join("app-config");
        let mut paths = create_test_paths(&app_root);
        paths.temp = temp_dir.path().join("app-temp");
        fs::write(&paths.database, b"live-database").expect("write live database");
        fs::write(&paths.settings, b"live-settings").expect("write live settings");
        fs::create_dir_all(paths.resources.join("images")).expect("create resources");
        fs::write(paths.resources.join("images/note.png"), b"live-image")
            .expect("write live image");

        let mut rollback_paths =
            prepare_restore_rollback(&paths).expect("prepare restore rollback");

        assert!(!paths.database.exists());
        assert!(!paths.settings.exists());
        assert!(!paths.resources.exists());
        assert!(rollback_paths.database.exists());
        assert!(rollback_paths.settings.exists());
        assert!(rollback_paths.resources.exists());
        assert!(rollback_paths.database.starts_with(&paths.temp));
        assert!(rollback_paths.settings.starts_with(&paths.temp));
        assert!(rollback_paths.resources.starts_with(&paths.temp));
        assert!(!rollback_paths.database.starts_with(&paths.root));

        rollback_restored_data(&paths, &mut rollback_paths).expect("manual rollback restores data");

        assert_eq!(
            fs::read(&paths.database).expect("read database"),
            b"live-database"
        );
        assert_eq!(
            fs::read(&paths.settings).expect("read settings"),
            b"live-settings"
        );
        assert_eq!(
            fs::read(paths.resources.join("images/note.png")).expect("read image"),
            b"live-image"
        );
    }

    #[test]
    fn prepare_restore_rollback_requires_app_temp_directory() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        fs::write(&paths.temp, b"not a directory").expect("create temp path as file");

        let error = match prepare_restore_rollback(&paths) {
            Ok(_) => panic!("temp file should fail"),
            Err(error) => error,
        };

        assert_eq!(error.kind, BackupErrorKind::RestorePreparationFailed);
        assert!(error.detail.contains("创建应用临时目录失败"));
    }

    #[test]
    fn cache_size_bytes_combines_app_and_webview_cache_and_ignores_missing_dirs() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());

        assert_eq!(directory_size_bytes(&paths.cache), 0);
        assert_eq!(cache_size_bytes(&paths), 0);

        fs::create_dir_all(&paths.cache).expect("create app cache");
        fs::write(paths.cache.join("app-cache.bin"), b"1234").expect("write app cache");
        let webview_cache = paths.webview_cache.as_ref().expect("webview cache path");
        fs::create_dir_all(webview_cache).expect("create webview cache");
        fs::write(webview_cache.join("webview-cache.bin"), b"12345").expect("write webview cache");

        assert_eq!(cache_size_bytes(&paths), 9);
    }

    #[test]
    fn rollback_restored_data_reports_rollback_failed() {
        let temp_dir = tempdir().expect("create temp dir");
        let rollback_root = tempdir().expect("create rollback dir");
        let paths = AppPaths {
            root: temp_dir.path().to_path_buf(),
            database: temp_dir.path().join("fight-notes.db"),
            settings: temp_dir.path().join("app-settings.json"),
            resources: temp_dir.path().join("resources"),
            backups: temp_dir
                .path()
                .join("Documents")
                .join(DOCUMENT_BACKUPS_DIR_NAME),
            legacy_backups: temp_dir.path().join("backups"),
            cache: temp_dir.path().join("cache"),
            webview_cache: Some(temp_dir.path().join("webkit-cache")),
            log: temp_dir.path().join("logs"),
            temp: temp_dir.path().join("tmp"),
        };
        fs::write(&paths.database, b"conflict database").expect("write conflict database");
        let rollback_database = rollback_root.path().join("database.rollback");
        fs::write(&rollback_database, b"rollback database").expect("write rollback database");

        let mut rollback_paths = RestoreRollbackPaths {
            root: Some(rollback_root),
            kept_root: None,
            database: rollback_database.clone(),
            settings: temp_dir.path().join("settings.rollback"),
            resources: temp_dir.path().join("resources.rollback"),
        };

        let error = rollback_restored_data(&paths, &mut rollback_paths)
            .expect_err("rollback should fail on invalid target");

        assert_eq!(error.kind, BackupErrorKind::RollbackFailed);
        assert_eq!(
            error.user_message(),
            "恢复失败，且回滚本地数据时出现问题，请立即检查数据目录。"
        );
        assert!(error
            .detail
            .contains(&paths.database.to_string_lossy().to_string()));
        let kept_root = rollback_paths
            .kept_root
            .clone()
            .expect("rollback root should be kept");
        assert!(kept_root.exists());
        assert!(rollback_database.exists());
        assert_eq!(
            fs::read(&paths.database).expect("read conflict database"),
            b"conflict database"
        );
    }
}

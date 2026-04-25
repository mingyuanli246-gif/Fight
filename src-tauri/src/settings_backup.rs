use chrono::{DateTime, Local};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime, State};
use tempfile::{tempdir_in, NamedTempFile, TempDir};
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const DATABASE_FILE_NAME: &str = "fight-notes.db";
const SETTINGS_FILE_NAME: &str = "app-settings.json";
const RESOURCES_DIR_NAME: &str = "resources";
const BACKUPS_DIR_NAME: &str = "backups";
const BACKUP_FILE_PREFIX: &str = "fight-notes-backup";
const BACKUP_FORMAT_VERSION: u32 = 1;
const CURRENT_SCHEMA_VERSION: u32 = 7;
const STORED_RESOURCE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
const VALID_THEMES: &[&str] = &["blue", "pink", "red", "yellow"];
const VALID_EDITOR_FONT_FAMILIES: &[&str] = &["modernSans", "elegantSerif", "systemDefault"];
const VALID_RETENTION_COUNTS: &[u32] = &[3, 5, 10];
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
    pub theme: String,
    #[serde(default = "default_editor_font_family")]
    pub editor_font_family: String,
    pub auto_backup_enabled: bool,
    pub backup_retention_count: u32,
    pub last_auto_backup_date: Option<String>,
}

fn default_editor_font_family() -> String {
    "modernSans".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "blue".to_string(),
            editor_font_family: default_editor_font_family(),
            auto_backup_enabled: false,
            backup_retention_count: 5,
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
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataEnvironmentInfo {
    pub data_dir: String,
    pub database_path: String,
    pub settings_path: String,
    pub resources_dir: String,
    pub backups_dir: String,
    pub app_version: String,
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

    Ok(AppPaths {
        database: root.join(DATABASE_FILE_NAME),
        settings: root.join(SETTINGS_FILE_NAME),
        resources: root.join(RESOURCES_DIR_NAME),
        backups: root.join(BACKUPS_DIR_NAME),
        root,
    })
}

fn ensure_directory(path: &Path, label: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("创建{label}失败：{error}"))
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

fn validate_app_settings(settings: &AppSettings) -> Result<(), String> {
    validate_theme(&settings.theme)?;
    validate_editor_font_family(&settings.editor_font_family)?;
    validate_retention_count(settings.backup_retention_count)?;

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
        last_auto_backup_date: current.last_auto_backup_date.clone(),
    };

    validate_app_settings(&next)?;
    Ok(next)
}

fn read_settings_from_path(path: &Path) -> Result<AppSettings, String> {
    let content = fs::read_to_string(path).map_err(|error| format!("读取应用设置失败：{error}"))?;
    let settings: AppSettings =
        serde_json::from_str(&content).map_err(|error| format!("解析应用设置失败：{error}"))?;
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

fn current_timestamp_label() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
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

fn build_backup_file_name(backups_dir: &Path) -> PathBuf {
    let base = format!(
        "{BACKUP_FILE_PREFIX}-{}",
        Local::now().format("%Y-%m-%d_%H-%M-%S")
    );
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

fn validate_manifest_archive_entry(
    label: &str,
    value: &str,
    expected: &str,
) -> Result<(), String> {
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
    validate_manifest_archive_entry(
        "设置文件路径",
        &manifest.settings_file,
        SETTINGS_FILE_NAME,
    )?;
    validate_manifest_archive_entry(
        "资源目录路径",
        &manifest.resource_directory,
        RESOURCES_DIR_NAME,
    )?;

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

fn validate_backup_archive(path: &Path) -> Result<ValidatedBackup, BackupError> {
    with_backup_stage("validate_backup_archive", || {
        let mut archive = open_backup_archive(path)?;
        let manifest = read_manifest_with_diagnostic(&mut archive)?;
        let temp_dir = tempdir_in(std::env::temp_dir()).map_err(|error| {
            BackupError::new(BackupErrorKind::BackupFileInvalid, error.to_string())
        })?;
        validate_database_archive_entry(&mut archive, &manifest, temp_dir.path())?;
        validate_settings_archive_entry(&mut archive, &manifest, temp_dir.path())?;
        validate_resources_archive_entry(&mut archive, &manifest)?;

        Ok(ValidatedBackup { manifest })
    })
}

fn list_backup_items(paths: &AppPaths) -> Result<Vec<BackupListItem>, String> {
    let mut items = Vec::new();

    for entry in
        fs::read_dir(&paths.backups).map_err(|error| format!("读取备份目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取备份目录失败：{error}"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        if path.extension().and_then(|value| value.to_str()) != Some("zip") {
            continue;
        }

        items.push(build_light_backup_list_item(&path));
    }

    items.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.file_name.cmp(&left.file_name))
    });

    Ok(items)
}

fn validate_backup_file(paths: &AppPaths, file_name: &str) -> Result<BackupListItem, String> {
    let backup_path = resolve_backup_file_path(paths, file_name)?;

    Ok(match validate_backup_archive(&backup_path) {
        Ok(validated) => build_validated_backup_list_item(&backup_path, validated),
        Err(error) => build_invalid_backup_list_item(&backup_path, error),
    })
}

fn prune_old_backups(backups_dir: &Path, retention_count: usize) -> Option<String> {
    let mut backup_files = match fs::read_dir(backups_dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("zip"))
            .collect::<Vec<_>>(),
        Err(error) => {
            return Some(format!("读取备份目录失败：{error}"));
        }
    };

    backup_files.sort_by(|left, right| {
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

    let mut warnings = Vec::new();

    for path in backup_files.into_iter().skip(retention_count) {
        if let Err(error) = fs::remove_file(&path) {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("未知备份");
            warnings.push(format!("删除旧备份 {name} 失败：{error}"));
        }
    }

    if warnings.is_empty() {
        None
    } else {
        Some(warnings.join("；"))
    }
}

fn create_backup_internal<R: Runtime>(
    app: &AppHandle<R>,
    paths: &AppPaths,
    settings: &AppSettings,
    note: Option<&str>,
) -> Result<CreateBackupResult, String> {
    let temp_dir =
        tempdir_in(&paths.root).map_err(|error| format!("创建备份临时目录失败：{error}"))?;
    let snapshot_path = temp_dir.path().join(DATABASE_FILE_NAME);
    with_backup_perf("create_backup.database_snapshot", || {
        create_database_snapshot(&paths.database, &snapshot_path)
    })?;

    let manifest = create_manifest(app, note);
    let backup_path = build_backup_file_name(&paths.backups);
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
    let warning = prune_old_backups(&paths.backups, settings.backup_retention_count as usize);
    let backup = build_created_backup_list_item(&backup_path, &manifest)?;
    log_backup_perf_complete("create_backup.result", result_started_at);

    Ok(CreateBackupResult { backup, warning })
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

    Ok(result)
}

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

fn rename_if_exists(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }

    fs::rename(source, destination).map_err(|error| format!("切换本地数据失败：{error}"))
}

fn restore_if_exists(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }

    if destination.exists() {
        if destination.is_dir() {
            fs::remove_dir_all(destination)
                .map_err(|error| format!("回滚本地数据失败：{error}"))?;
        } else {
            fs::remove_file(destination).map_err(|error| format!("回滚本地数据失败：{error}"))?;
        }
    }

    fs::rename(source, destination).map_err(|error| format!("回滚本地数据失败：{error}"))
}

struct RestoreRollbackPaths {
    _root: TempDir,
    database: PathBuf,
    settings: PathBuf,
    resources: PathBuf,
}

fn prepare_restore_rollback(paths: &AppPaths) -> Result<RestoreRollbackPaths, BackupError> {
    let rollback_root = tempdir_in(&paths.root).map_err(|error| {
        BackupError::new(
            BackupErrorKind::RestorePreparationFailed,
            format!("创建恢复回滚目录失败：{error}"),
        )
    })?;
    let rollback_database = rollback_root.path().join("database.rollback");
    let rollback_settings = rollback_root.path().join("settings.rollback");
    let rollback_resources = rollback_root.path().join("resources.rollback");

    rename_if_exists(&paths.database, &rollback_database)
        .map_err(|error| BackupError::new(BackupErrorKind::RestorePreparationFailed, error))?;
    rename_if_exists(&paths.settings, &rollback_settings)
        .map_err(|error| BackupError::new(BackupErrorKind::RestorePreparationFailed, error))?;
    rename_if_exists(&paths.resources, &rollback_resources)
        .map_err(|error| BackupError::new(BackupErrorKind::RestorePreparationFailed, error))?;

    Ok(RestoreRollbackPaths {
        _root: rollback_root,
        database: rollback_database,
        settings: rollback_settings,
        resources: rollback_resources,
    })
}

fn rollback_restored_data(
    paths: &AppPaths,
    rollback_paths: &RestoreRollbackPaths,
) -> Result<(), BackupError> {
    if paths.database.exists() {
        fs::remove_file(&paths.database).map_err(|error| {
            BackupError::new(
                BackupErrorKind::RollbackFailed,
                format!("回滚本地数据失败：{error}"),
            )
        })?;
    }
    if paths.settings.exists() {
        fs::remove_file(&paths.settings).map_err(|error| {
            BackupError::new(
                BackupErrorKind::RollbackFailed,
                format!("回滚本地数据失败：{error}"),
            )
        })?;
    }
    if paths.resources.exists() {
        fs::remove_dir_all(&paths.resources).map_err(|error| {
            BackupError::new(
                BackupErrorKind::RollbackFailed,
                format!("回滚本地数据失败：{error}"),
            )
        })?;
    }

    restore_if_exists(&rollback_paths.database, &paths.database)
        .map_err(|error| BackupError::new(BackupErrorKind::RollbackFailed, error))?;
    restore_if_exists(&rollback_paths.settings, &paths.settings)
        .map_err(|error| BackupError::new(BackupErrorKind::RollbackFailed, error))?;
    restore_if_exists(&rollback_paths.resources, &paths.resources)
        .map_err(|error| BackupError::new(BackupErrorKind::RollbackFailed, error))?;

    Ok(())
}

fn swap_restored_data(
    paths: &AppPaths,
    database_path: &Path,
    settings_path: &Path,
    resources_dir: &Path,
) -> Result<(), BackupError> {
    fs::rename(database_path, &paths.database).map_err(|error| {
        BackupError::new(
            BackupErrorKind::DatabaseRestoreFailed,
            format!("写入恢复后的数据库失败：{error}"),
        )
    })?;
    fs::rename(settings_path, &paths.settings).map_err(|error| {
        BackupError::new(
            BackupErrorKind::SettingsRestoreFailed,
            format!("写入恢复后的设置失败：{error}"),
        )
    })?;
    fs::rename(resources_dir, &paths.resources).map_err(|error| {
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
    let next_settings = merge_app_settings(&current_settings, update)?;
    write_settings_atomically(&paths.settings, &next_settings)?;
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
        app_version: app.package_info().version.to_string(),
    })
}

#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<BackupListItem>, String> {
    let (paths, _) = ensure_app_environment(&app)?;
    list_backup_items(&paths)
}

#[tauri::command]
pub fn validate_backup(app: AppHandle, file_name: String) -> Result<BackupListItem, String> {
    let (paths, _) = ensure_app_environment(&app)?;
    validate_backup_file(&paths, &file_name)
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

    let today = format_today_key();
    if settings.last_auto_backup_date.as_deref() == Some(&today) {
        return Ok(AutoBackupResult {
            status: "skipped-already-ran".to_string(),
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
    file_name: String,
) -> Result<RestoreBackupResult, String> {
    let _guard = try_acquire_operation(&operation_lock, BackupOperation::Restore)?;

    let (paths, _) = ensure_app_environment(&app)?;

    let backup_path = resolve_backup_file_path(&paths, &file_name)?;
    let mut archive = with_backup_stage("restore_backup.open_archive", || {
        open_backup_archive(&backup_path)
    })
    .map_err(BackupError::into_user_message)?;
    let manifest = with_backup_stage("restore_backup.read_manifest", || {
        read_manifest_with_diagnostic(&mut archive)
    })
    .map_err(BackupError::into_user_message)?;
    let validation_temp_dir = tempdir_in(std::env::temp_dir()).map_err(|error| {
        BackupError::new(
            BackupErrorKind::RestorePreparationFailed,
            format!("创建恢复临时目录失败：{error}"),
        )
        .into_user_message()
    })?;
    let schema_version = with_backup_stage("restore_backup.validate_database", || {
        validate_database_archive_entry(&mut archive, &manifest, validation_temp_dir.path())
    })
    .map_err(BackupError::into_user_message)?;
    with_backup_stage("restore_backup.validate_settings", || {
        validate_settings_archive_entry(&mut archive, &manifest, validation_temp_dir.path())
    })
    .map_err(BackupError::into_user_message)?;
    with_backup_stage("restore_backup.validate_resources", || {
        validate_resources_archive_entry(&mut archive, &manifest)
    })
    .map_err(BackupError::into_user_message)?;

    let temp_dir = tempdir_in(&paths.root).map_err(|error| {
        BackupError::new(
            BackupErrorKind::RestorePreparationFailed,
            format!("创建恢复临时目录失败：{error}"),
        )
        .into_user_message()
    })?;
    let extract_dir = temp_dir.path().join("extracted");
    let (_manifest, restored_database, restored_settings, restored_resources) =
        with_backup_stage("restore_backup.extract_archive", || {
            fs::create_dir_all(&extract_dir).map_err(|error| {
                BackupError::new(
                    BackupErrorKind::RestorePreparationFailed,
                    format!("创建恢复临时目录失败：{error}"),
                )
            })?;

            let extracted =
                extract_backup_archive(&backup_path, &extract_dir).map_err(|error| {
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
                })?;

            validate_database_file_for_schema(&extracted.1, Some(schema_version))
                .map_err(map_schema_validation_error)?;
            read_settings_from_path(&extracted.2)
                .map_err(|error| BackupError::new(BackupErrorKind::SettingsInvalid, error))?;
            ensure_directory(&extracted.3, "恢复资源目录")
                .map_err(|error| BackupError::new(BackupErrorKind::ResourcesInvalid, error))?;

            Ok(extracted)
        })
        .map_err(BackupError::into_user_message)?;
    let rollback_paths = with_backup_stage("restore_backup.prepare_rollback", || {
        prepare_restore_rollback(&paths)
    })
    .map_err(BackupError::into_user_message)?;

    if let Err(error) = with_backup_stage("restore_backup.swap_data", || {
        swap_restored_data(
            &paths,
            &restored_database,
            &restored_settings,
            &restored_resources,
        )
    }) {
        if let Err(rollback_error) = with_backup_stage("restore_backup.rollback", || {
            rollback_restored_data(&paths, &rollback_paths)
        }) {
            return Err(rollback_error.into_user_message());
        }

        return Err(error.into_user_message());
    }

    with_backup_stage("restore_backup.finalize", || Ok(()))
        .map_err(BackupError::into_user_message)?;

    Ok(RestoreBackupResult {
        restored_file_name: file_name,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        add_resources_to_zip, build_created_backup_list_item, extract_backup_archive,
        list_backup_items, prepare_restore_rollback, resource_file_compression_method,
        rollback_restored_data, validate_backup_archive, validate_backup_file,
        validate_database_file_for_schema, validate_manifest_archive_paths, zip_dir_options,
        zip_file_options, AppPaths, AppSettings, BackupErrorKind, BackupManifest,
        BackupValidationStatus, RestoreRollbackPaths, CURRENT_SCHEMA_VERSION,
    };
    use rusqlite::Connection;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use tempfile::tempdir;
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
        let backups = root.join("backups");
        fs::create_dir_all(&backups).expect("create backups dir");

        AppPaths {
            root: root.to_path_buf(),
            database: root.join("fight-notes.db"),
            settings: root.join("app-settings.json"),
            resources: root.join("resources"),
            backups,
        }
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

        let error =
            validate_backup_archive(&backup_path).expect_err("invalid settings should fail");

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

        let error =
            validate_backup_archive(&backup_path).expect_err("missing resources should fail");

        assert_eq!(error.kind, BackupErrorKind::ResourcesInvalid);
        assert_eq!(error.user_message(), "备份中的资源目录结构无效，无法恢复。");
    }

    #[test]
    fn restore_interruption_probe_confirms_live_paths_are_missing_after_prepare_rollback() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = create_test_paths(temp_dir.path());
        fs::write(&paths.database, b"live-database").expect("write live database");
        fs::write(&paths.settings, b"live-settings").expect("write live settings");
        fs::create_dir_all(paths.resources.join("images")).expect("create resources");
        fs::write(paths.resources.join("images/note.png"), b"live-image")
            .expect("write live image");

        let rollback_paths =
            prepare_restore_rollback(&paths).expect("prepare restore rollback");

        assert!(!paths.database.exists());
        assert!(!paths.settings.exists());
        assert!(!paths.resources.exists());
        assert!(rollback_paths.database.exists());
        assert!(rollback_paths.settings.exists());
        assert!(rollback_paths.resources.exists());

        rollback_restored_data(&paths, &rollback_paths).expect("manual rollback restores data");

        assert_eq!(fs::read(&paths.database).expect("read database"), b"live-database");
        assert_eq!(fs::read(&paths.settings).expect("read settings"), b"live-settings");
        assert_eq!(
            fs::read(paths.resources.join("images/note.png")).expect("read image"),
            b"live-image"
        );
    }

    #[test]
    fn rollback_restored_data_reports_rollback_failed() {
        let temp_dir = tempdir().expect("create temp dir");
        let rollback_root = tempdir().expect("create rollback dir");
        let paths = AppPaths {
            root: temp_dir.path().to_path_buf(),
            database: temp_dir.path().join("database-as-dir"),
            settings: temp_dir.path().join("app-settings.json"),
            resources: temp_dir.path().join("resources"),
            backups: temp_dir.path().join("backups"),
        };
        fs::create_dir_all(&paths.database).expect("create database dir");

        let rollback_paths = RestoreRollbackPaths {
            _root: rollback_root,
            database: temp_dir.path().join("database.rollback"),
            settings: temp_dir.path().join("settings.rollback"),
            resources: temp_dir.path().join("resources.rollback"),
        };

        let error = rollback_restored_data(&paths, &rollback_paths)
            .expect_err("rollback should fail on invalid target");

        assert_eq!(error.kind, BackupErrorKind::RollbackFailed);
        assert_eq!(
            error.user_message(),
            "恢复失败，且回滚本地数据时出现问题，请立即检查数据目录。"
        );
    }
}

use chrono::{DateTime, Local};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, State};
use tempfile::{tempdir_in, NamedTempFile};
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const DATABASE_FILE_NAME: &str = "fight-notes.db";
const SETTINGS_FILE_NAME: &str = "app-settings.json";
const RESOURCES_DIR_NAME: &str = "resources";
const BACKUPS_DIR_NAME: &str = "backups";
const BACKUP_FILE_PREFIX: &str = "fight-notes-backup";
const BACKUP_FORMAT_VERSION: u32 = 1;
const CURRENT_SCHEMA_VERSION: u32 = 5;
const VALID_THEMES: &[&str] = &["blue", "pink", "red", "yellow"];
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub auto_backup_enabled: bool,
    pub backup_retention_count: u32,
    pub last_auto_backup_date: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "blue".to_string(),
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupListItem {
    pub file_name: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub is_valid: bool,
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

struct ValidatedBackup {
    manifest: BackupManifest,
    schema_version: u32,
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

fn zip_dir_options() -> FileOptions {
    FileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o755)
}

fn add_file_to_zip(
    zip: &mut ZipWriter<File>,
    source_path: &Path,
    zip_path: &str,
) -> Result<(), String> {
    let mut file = File::open(source_path).map_err(|error| format!("读取备份文件失败：{error}"))?;

    zip.start_file(zip_path, zip_file_options())
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
            add_file_to_zip(zip, path, &target_path)?;
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

        inferred_schema_version.max(schema_version)
    } else {
        inferred_schema_version
    };

    Ok(effective_schema_version)
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

fn validate_backup_archive(path: &Path) -> Result<ValidatedBackup, String> {
    let file = File::open(path).map_err(|error| format!("打开备份失败：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("读取备份压缩包失败：{error}"))?;
    let manifest = read_manifest_from_archive(&mut archive)?;

    let temp_dir =
        tempdir_in(std::env::temp_dir()).map_err(|error| format!("创建临时目录失败：{error}"))?;
    let database_path = temp_dir.path().join(&manifest.database_file);
    extract_archive_file_to_path(
        &mut archive,
        &format!("database/{}", manifest.database_file),
        &database_path,
    )?;
    let schema_version =
        validate_database_file_for_schema(&database_path, manifest.schema_version)?;

    let settings_path = temp_dir.path().join(&manifest.settings_file);
    extract_archive_file_to_path(
        &mut archive,
        &format!("settings/{}", manifest.settings_file),
        &settings_path,
    )?;
    read_settings_from_path(&settings_path)
        .map_err(|error| format!("备份中的应用设置无效：{error}"))?;

    ensure_archive_has_resources(&mut archive, &manifest.resource_directory)?;

    Ok(ValidatedBackup {
        manifest,
        schema_version,
    })
}

fn inspect_backup_file(path: &Path) -> BackupListItem {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未知备份")
        .to_string();
    let size_bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let fallback_created = metadata_created_label(path);

    match validate_backup_archive(path) {
        Ok(validated) => BackupListItem {
            file_name,
            created_at: validated.manifest.created_at,
            size_bytes,
            is_valid: true,
            invalid_reason: None,
            note: if validated.manifest.note.trim().is_empty() {
                None
            } else {
                Some(validated.manifest.note)
            },
        },
        Err(error) => BackupListItem {
            file_name,
            created_at: fallback_created,
            size_bytes,
            is_valid: false,
            invalid_reason: Some(error),
            note: None,
        },
    }
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

        items.push(inspect_backup_file(&path));
    }

    items.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.file_name.cmp(&left.file_name))
    });

    Ok(items)
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
    create_database_snapshot(&paths.database, &snapshot_path)?;

    let manifest = create_manifest(app, note);
    let backup_path = build_backup_file_name(&paths.backups);
    let backup_file =
        File::create(&backup_path).map_err(|error| format!("创建备份文件失败：{error}"))?;
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
    )?;
    add_file_to_zip(
        &mut zip,
        &paths.settings,
        &format!("settings/{}", manifest.settings_file),
    )?;
    add_resources_to_zip(&mut zip, &paths.resources, &manifest.resource_directory)?;

    zip.finish()
        .map_err(|error| format!("完成备份压缩包失败：{error}"))?;

    let warning = prune_old_backups(&paths.backups, settings.backup_retention_count as usize);
    let backup = inspect_backup_file(&backup_path);

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

fn swap_restored_data(
    paths: &AppPaths,
    database_path: &Path,
    settings_path: &Path,
    resources_dir: &Path,
) -> Result<(), String> {
    let rollback_root =
        tempdir_in(&paths.root).map_err(|error| format!("创建恢复回滚目录失败：{error}"))?;
    let rollback_database = rollback_root.path().join("database.rollback");
    let rollback_settings = rollback_root.path().join("settings.rollback");
    let rollback_resources = rollback_root.path().join("resources.rollback");

    rename_if_exists(&paths.database, &rollback_database)?;
    rename_if_exists(&paths.settings, &rollback_settings)?;
    rename_if_exists(&paths.resources, &rollback_resources)?;

    let attempt = (|| -> Result<(), String> {
        fs::rename(database_path, &paths.database)
            .map_err(|error| format!("写入恢复后的数据库失败：{error}"))?;
        fs::rename(settings_path, &paths.settings)
            .map_err(|error| format!("写入恢复后的设置失败：{error}"))?;
        fs::rename(resources_dir, &paths.resources)
            .map_err(|error| format!("写入恢复后的资源目录失败：{error}"))?;
        Ok(())
    })();

    if let Err(error) = attempt {
        if paths.database.exists() {
            let _ = fs::remove_file(&paths.database);
        }
        if paths.settings.exists() {
            let _ = fs::remove_file(&paths.settings);
        }
        if paths.resources.exists() {
            let _ = fs::remove_dir_all(&paths.resources);
        }

        let _ = restore_if_exists(&rollback_database, &paths.database);
        let _ = restore_if_exists(&rollback_settings, &paths.settings);
        let _ = restore_if_exists(&rollback_resources, &paths.resources);

        return Err(error);
    }

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

    if file_name.trim().is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || !file_name.ends_with(".zip")
    {
        return Err("备份文件名无效。".to_string());
    }

    let (paths, _) = ensure_app_environment(&app)?;
    let backup_path = paths.backups.join(&file_name);

    if !backup_path.exists() {
        return Err("目标备份不存在。".to_string());
    }

    let validated_backup = validate_backup_archive(&backup_path)?;

    let temp_dir =
        tempdir_in(&paths.root).map_err(|error| format!("创建恢复临时目录失败：{error}"))?;
    let extract_dir = temp_dir.path().join("extracted");
    fs::create_dir_all(&extract_dir).map_err(|error| format!("创建恢复临时目录失败：{error}"))?;

    let (_manifest, restored_database, restored_settings, restored_resources) =
        extract_backup_archive(&backup_path, &extract_dir)?;

    validate_database_file_for_schema(&restored_database, Some(validated_backup.schema_version))?;
    read_settings_from_path(&restored_settings)
        .map_err(|error| format!("备份中的应用设置无效：{error}"))?;
    ensure_directory(&restored_resources, "恢复资源目录")?;

    swap_restored_data(
        &paths,
        &restored_database,
        &restored_settings,
        &restored_resources,
    )?;

    Ok(RestoreBackupResult {
        restored_file_name: file_name,
    })
}

#[cfg(test)]
mod tests {
    use super::validate_database_file_for_schema;
    use rusqlite::Connection;
    use tempfile::tempdir;

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
    fn accepts_current_v5_schema_when_declared() {
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
            ",
        );

        let version =
            validate_database_file_for_schema(&path, Some(5)).expect("validate v5 backup");

        assert_eq!(version, 5);
    }
}

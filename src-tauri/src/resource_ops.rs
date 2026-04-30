use chrono::Utc;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager, Runtime, State};
use tempfile::Builder as TempFileBuilder;
use uuid::Uuid;

const RESOURCES_DIR_NAME: &str = "resources";
const RESOURCES_TRASH_DIR_NAME: &str = "resources_trash";
const IMAGES_DIR_NAME: &str = "images";
const COVERS_DIR_NAME: &str = "covers";
const TRASH_RESOURCE_FILE_STEM: &str = "resource";
const TRASH_MANIFEST_FILE_NAME: &str = "manifest.json";
const INVALID_RESOURCE_PATH_MESSAGE: &str = "资源路径无效。";
const IMAGE_IMPORT_FAILED_MESSAGE: &str = "图片导入失败，请稍后重试。";
const UNSUPPORTED_IMAGE_MESSAGE: &str = "当前文件不是支持的图片格式。";
const SUPPORTED_IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
const RESOURCE_TEMP_FILE_PREFIX: &str = ".resource-image-";
const RESOURCE_TEMP_FILE_SUFFIX: &str = ".creating";
const STALE_RESOURCE_TEMP_FILE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const RESOURCE_IMPORT_PERSIST_RETRY_LIMIT: usize = 8;
const RESOURCE_TRASH_RESTORE_RETRY_LIMIT: usize = 8;
const ENCODE_URI_COMPONENT_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'=')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportedImageTarget {
    NoteImage,
    NotebookCover,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedResourceDescriptor {
    pub resource_path: String,
    pub absolute_path: String,
    pub asset_url: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SelectAndImportImageResult {
    Cancelled,
    Imported {
        target: String,
        #[serde(flatten)]
        resource: ManagedResourceDescriptor,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ResolveManagedResourceResult {
    Resolved {
        #[serde(flatten)]
        resource: ManagedResourceDescriptor,
    },
    Missing {
        #[serde(flatten)]
        resource: ManagedResourceDescriptor,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ManagedResourceTrashSource {
    NoteBody,
    Cover,
    OrphanCleanup,
}

impl ManagedResourceTrashSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::NoteBody => "note-body",
            Self::Cover => "cover",
            Self::OrphanCleanup => "orphan-cleanup",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManagedResourceTrashKind {
    Image,
    Cover,
}

impl ManagedResourceTrashKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "image" => Ok(Self::Image),
            "cover" => Ok(Self::Cover),
            _ => Err("回收站资源类型无效。".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Cover => "cover",
        }
    }

    fn trash_subdir(self) -> &'static str {
        match self {
            Self::Image => IMAGES_DIR_NAME,
            Self::Cover => COVERS_DIR_NAME,
        }
    }

    fn resource_subdir(self) -> &'static str {
        match self {
            Self::Image => IMAGES_DIR_NAME,
            Self::Cover => COVERS_DIR_NAME,
        }
    }

    fn from_resource_path(resource_path: &str) -> Result<Self, String> {
        let normalized_path = normalize_supported_image_resource_path(resource_path)?;
        let segments = normalized_path.split('/').collect::<Vec<_>>();
        match segments.get(1).copied() {
            Some(IMAGES_DIR_NAME) => Ok(Self::Image),
            Some(COVERS_DIR_NAME) => Ok(Self::Cover),
            _ => Err(INVALID_RESOURCE_PATH_MESSAGE.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceTrashManifest {
    trash_id: String,
    resource_kind: String,
    original_path: String,
    trash_path: String,
    original_resource_id: String,
    extension: String,
    deleted_at: String,
    source: String,
    note_id: Option<i64>,
    node_snapshot: Option<String>,
    restore_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTrashListItem {
    pub trash_id: String,
    pub resource_kind: String,
    pub original_path: Option<String>,
    pub trash_path: Option<String>,
    pub deleted_at: Option<String>,
    pub source: Option<String>,
    pub extension: Option<String>,
    pub file_exists: bool,
    pub manifest_valid: bool,
    pub can_restore: bool,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct ManagedResourceLeaseState {
    sessions: Mutex<BTreeMap<String, BTreeSet<String>>>,
}

impl ManagedResourceLeaseState {
    fn replace_session_leases(
        &self,
        session_id: String,
        resource_paths: BTreeSet<String>,
    ) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "图片资源会话状态暂时不可用。".to_string())?;

        if resource_paths.is_empty() {
            sessions.remove(&session_id);
        } else {
            sessions.insert(session_id, resource_paths);
        }

        Ok(())
    }

    fn clear_session_leases(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "图片资源会话状态暂时不可用。".to_string())?;
        sessions.remove(session_id);
        Ok(())
    }

    fn snapshot(&self) -> BTreeSet<String> {
        let Ok(sessions) = self.sessions.lock() else {
            eprintln!("[resource_ops] 读取图片资源会话租约失败：状态锁不可用");
            return BTreeSet::new();
        };

        sessions
            .values()
            .flat_map(|resource_paths| resource_paths.iter().cloned())
            .collect()
    }
}

fn normalize_session_id(session_id: &str) -> Result<String, String> {
    let normalized = session_id.trim();
    if normalized.is_empty() {
        Err("图片资源会话无效。".to_string())
    } else {
        Ok(normalized.to_string())
    }
}

fn normalize_session_lease_resource_path(resource_path: &str) -> Option<String> {
    let normalized_path = normalize_managed_resource_path(resource_path).ok()?;
    if is_app_managed_image_resource_path(&normalized_path) {
        Some(normalized_path)
    } else {
        None
    }
}

pub(crate) fn snapshot_managed_resource_session_leases<R: Runtime>(
    app: &AppHandle<R>,
) -> BTreeSet<String> {
    app.try_state::<ManagedResourceLeaseState>()
        .map(|state| state.snapshot())
        .unwrap_or_default()
}

impl ImportedImageTarget {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "note-image" => Ok(Self::NoteImage),
            "notebook-cover" => Ok(Self::NotebookCover),
            _ => Err("图片导入目标无效。".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::NoteImage => "note-image",
            Self::NotebookCover => "notebook-cover",
        }
    }

    fn subdir(self) -> &'static str {
        match self {
            Self::NoteImage => IMAGES_DIR_NAME,
            Self::NotebookCover => COVERS_DIR_NAME,
        }
    }
}

fn log_resource_error(action: &str, error: impl ToString) {
    eprintln!("[resource_ops] {action}失败: {}", error.to_string());
}

pub(crate) fn resolve_app_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|error| {
        log_resource_error("读取应用数据目录", &error);
        "读取应用数据目录失败。".to_string()
    })
}

fn ensure_directory(path: &Path, label: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| {
        log_resource_error(&format!("创建{label}"), &error);
        format!("创建{label}失败：{error}")
    })
}

fn resources_root(root: &Path) -> PathBuf {
    root.join(RESOURCES_DIR_NAME)
}

fn resources_trash_root(root: &Path) -> PathBuf {
    root.join(RESOURCES_TRASH_DIR_NAME)
}

fn resource_subdir_path(root: &Path, subdir: &str) -> PathBuf {
    resources_root(root).join(subdir)
}

fn managed_resource_absolute_path_under_resources_root(
    root: &Path,
    resource_path: &str,
) -> Result<PathBuf, String> {
    let normalized_path = normalize_supported_image_resource_path(resource_path)?;
    let relative_path = normalized_path
        .strip_prefix(&format!("{RESOURCES_DIR_NAME}/"))
        .ok_or_else(|| INVALID_RESOURCE_PATH_MESSAGE.to_string())?;
    let resources_root = resources_root(root);
    let absolute_path = resources_root.join(relative_path);

    if !absolute_path.starts_with(&resources_root) {
        return Err(INVALID_RESOURCE_PATH_MESSAGE.to_string());
    }

    Ok(absolute_path)
}

fn resource_trash_subdir_path(root: &Path, kind: ManagedResourceTrashKind) -> PathBuf {
    resources_trash_root(root).join(kind.trash_subdir())
}

fn resource_trash_item_dir(root: &Path, kind: ManagedResourceTrashKind, trash_id: &str) -> PathBuf {
    resource_trash_subdir_path(root, kind).join(trash_id)
}

fn ensure_resource_directories_under(root: &Path) -> Result<(), String> {
    ensure_directory(root, "应用数据目录")?;
    ensure_directory(&resources_root(root), "资源目录")?;
    ensure_directory(&resource_subdir_path(root, IMAGES_DIR_NAME), "正文图片目录")?;
    ensure_directory(&resource_subdir_path(root, COVERS_DIR_NAME), "封面目录")?;
    Ok(())
}

fn ensure_resource_trash_directories_under(root: &Path) -> Result<(), String> {
    ensure_directory(root, "应用数据目录")?;
    ensure_directory(&resources_trash_root(root), "图片回收站目录")?;
    ensure_directory(
        &resource_trash_subdir_path(root, ManagedResourceTrashKind::Image),
        "正文图片回收站目录",
    )?;
    ensure_directory(
        &resource_trash_subdir_path(root, ManagedResourceTrashKind::Cover),
        "封面回收站目录",
    )?;
    Ok(())
}

fn is_stale_resource_temp_file_name(file_name: &str) -> bool {
    file_name.starts_with(RESOURCE_TEMP_FILE_PREFIX)
        && file_name.ends_with(RESOURCE_TEMP_FILE_SUFFIX)
}

fn cleanup_stale_resource_temp_files_in_dir(
    directory_path: &Path,
    now: SystemTime,
    max_age: Duration,
) -> Result<usize, String> {
    if !directory_path.exists() {
        return Ok(0);
    }

    let mut deleted_count = 0;
    let entries = fs::read_dir(directory_path).map_err(|error| error.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };

        if !is_stale_resource_temp_file_name(file_name) {
            continue;
        }

        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            continue;
        }

        let modified = metadata.modified().map_err(|error| error.to_string())?;
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };

        if age < max_age {
            continue;
        }

        fs::remove_file(&path).map_err(|error| error.to_string())?;
        deleted_count += 1;
    }

    Ok(deleted_count)
}

fn cleanup_stale_resource_temp_files_under_with_now(
    root: &Path,
    now: SystemTime,
) -> Result<usize, String> {
    let mut deleted_count = 0;
    deleted_count += cleanup_stale_resource_temp_files_in_dir(
        &resource_subdir_path(root, IMAGES_DIR_NAME),
        now,
        STALE_RESOURCE_TEMP_FILE_AGE,
    )?;
    deleted_count += cleanup_stale_resource_temp_files_in_dir(
        &resource_subdir_path(root, COVERS_DIR_NAME),
        now,
        STALE_RESOURCE_TEMP_FILE_AGE,
    )?;
    Ok(deleted_count)
}

fn cleanup_stale_resource_temp_files_best_effort(root: &Path) {
    if let Err(error) = cleanup_stale_resource_temp_files_under_with_now(root, SystemTime::now()) {
        eprintln!("[resource_ops] 清理旧临时图片文件失败: {error}");
    }
}

fn ensure_resource_directories_with_temp_cleanup(root: &Path) -> Result<(), String> {
    ensure_resource_directories_under(root)?;
    cleanup_stale_resource_temp_files_best_effort(root);
    Ok(())
}

fn is_windows_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

pub(crate) fn normalize_managed_resource_path(resource_path: &str) -> Result<String, String> {
    let trimmed = resource_path.trim();

    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.contains('\\')
        || is_windows_drive_path(trimmed)
    {
        return Err(INVALID_RESOURCE_PATH_MESSAGE.to_string());
    }

    let segments: Vec<&str> = trimmed.split('/').collect();

    if segments.len() < 2 || segments[0] != RESOURCES_DIR_NAME {
        return Err(INVALID_RESOURCE_PATH_MESSAGE.to_string());
    }

    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(INVALID_RESOURCE_PATH_MESSAGE.to_string());
    }

    Ok(segments.join("/"))
}

fn encode_asset_path_component(path: &Path) -> String {
    utf8_percent_encode(path.to_string_lossy().as_ref(), ENCODE_URI_COMPONENT_SET).to_string()
}

fn to_asset_url(path: &Path) -> String {
    let encoded_path = encode_asset_path_component(path);

    #[cfg(target_os = "windows")]
    {
        format!("http://asset.localhost/{encoded_path}")
    }

    #[cfg(not(target_os = "windows"))]
    {
        format!("asset://localhost/{encoded_path}")
    }
}

fn describe_managed_resource(
    root: &Path,
    resource_path: &str,
) -> Result<ManagedResourceDescriptor, String> {
    let normalized_path = normalize_managed_resource_path(resource_path)?;
    let absolute_path = root.join(&normalized_path);

    Ok(ManagedResourceDescriptor {
        resource_path: normalized_path,
        absolute_path: absolute_path.to_string_lossy().to_string(),
        asset_url: to_asset_url(&absolute_path),
    })
}

fn normalize_image_extension(source_path: &Path) -> Result<String, String> {
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| UNSUPPORTED_IMAGE_MESSAGE.to_string())?;

    if SUPPORTED_IMAGE_EXTENSIONS
        .iter()
        .any(|candidate| *candidate == extension)
    {
        Ok(extension)
    } else {
        Err(UNSUPPORTED_IMAGE_MESSAGE.to_string())
    }
}

fn is_supported_image_extension(extension: &str) -> bool {
    let extension = extension.to_ascii_lowercase();
    SUPPORTED_IMAGE_EXTENSIONS
        .iter()
        .any(|candidate| *candidate == extension)
}

fn normalize_supported_image_resource_path(resource_path: &str) -> Result<String, String> {
    let normalized_path = normalize_managed_resource_path(resource_path)?;
    let segments = normalized_path.split('/').collect::<Vec<_>>();

    if segments.len() != 3
        || segments[0] != RESOURCES_DIR_NAME
        || (segments[1] != IMAGES_DIR_NAME && segments[1] != COVERS_DIR_NAME)
    {
        return Err(INVALID_RESOURCE_PATH_MESSAGE.to_string());
    }

    let extension = Path::new(segments[2])
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| INVALID_RESOURCE_PATH_MESSAGE.to_string())?;

    if !is_supported_image_extension(extension) {
        return Err(INVALID_RESOURCE_PATH_MESSAGE.to_string());
    }

    Ok(normalized_path)
}

pub(crate) fn is_app_managed_image_resource_path(resource_path: &str) -> bool {
    let Ok(normalized_path) = normalize_supported_image_resource_path(resource_path) else {
        return false;
    };
    let Some(file_name) = normalized_path.split('/').next_back() else {
        return false;
    };
    let Some(stem) = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
    else {
        return false;
    };

    Uuid::parse_str(stem).is_ok()
}

fn normalize_trash_id(trash_id: &str) -> Result<String, String> {
    let trimmed = trash_id.trim();
    let parsed = Uuid::parse_str(trimmed).map_err(|_| "回收站项目无效。".to_string())?;
    Ok(parsed.to_string())
}

fn resource_path_file_parts(resource_path: &str) -> Result<(String, String), String> {
    let normalized_path = normalize_supported_image_resource_path(resource_path)?;
    let file_name = normalized_path
        .split('/')
        .next_back()
        .ok_or_else(|| INVALID_RESOURCE_PATH_MESSAGE.to_string())?;
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| INVALID_RESOURCE_PATH_MESSAGE.to_string())?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| INVALID_RESOURCE_PATH_MESSAGE.to_string())?;

    Ok((stem.to_string(), extension))
}

fn trash_resource_file_name(extension: &str) -> String {
    format!("{TRASH_RESOURCE_FILE_STEM}.{extension}")
}

fn trash_resource_relative_path(
    kind: ManagedResourceTrashKind,
    trash_id: &str,
    extension: &str,
) -> String {
    format!(
        "{}/{}/{}/{}",
        RESOURCES_TRASH_DIR_NAME,
        kind.trash_subdir(),
        trash_id,
        trash_resource_file_name(extension)
    )
}

fn sync_directory_best_effort(path: &Path, label: &str) {
    match fs::File::open(path) {
        Ok(directory) => {
            if let Err(error) = directory.sync_all() {
                eprintln!("[resource_ops] 同步{label}失败: {error}");
            }
        }
        Err(error) => {
            eprintln!("[resource_ops] 打开{label}失败: {error}");
        }
    }
}

fn persist_copy_to_noclobber(
    source: &Path,
    directory: &Path,
    file_name: &str,
    action: &str,
) -> Result<PathBuf, String> {
    ensure_directory(directory, "图片回收站项目目录")?;
    let target = directory.join(file_name);
    if target.exists() {
        return Err(format!("{action}失败：目标文件已存在。"));
    }

    let mut temp_file = TempFileBuilder::new()
        .prefix(".resource-trash-")
        .suffix(".tmp")
        .tempfile_in(directory)
        .map_err(|error| format!("{action}失败：创建临时文件失败：{error}"))?;
    let mut source_file =
        fs::File::open(source).map_err(|error| format!("{action}失败：读取源文件失败：{error}"))?;
    io::copy(&mut source_file, temp_file.as_file_mut())
        .map_err(|error| format!("{action}失败：写入临时文件失败：{error}"))?;
    temp_file
        .as_file_mut()
        .flush()
        .map_err(|error| format!("{action}失败：刷新临时文件失败：{error}"))?;
    temp_file
        .as_file_mut()
        .sync_all()
        .map_err(|error| format!("{action}失败：同步临时文件失败：{error}"))?;
    temp_file
        .persist_noclobber(&target)
        .map_err(|error| format!("{action}失败：保存文件失败：{}", error.error))?;
    sync_directory_best_effort(directory, "图片回收站项目目录");

    Ok(target)
}

fn write_manifest_atomic(
    directory: &Path,
    manifest: &ResourceTrashManifest,
) -> Result<PathBuf, String> {
    let target = directory.join(TRASH_MANIFEST_FILE_NAME);
    if target.exists() {
        return Err("写入图片回收站清单失败：目标文件已存在。".to_string());
    }

    let mut temp_file = TempFileBuilder::new()
        .prefix(".resource-trash-manifest-")
        .suffix(".json.tmp")
        .tempfile_in(directory)
        .map_err(|error| format!("写入图片回收站清单失败：创建临时文件失败：{error}"))?;
    serde_json::to_writer_pretty(temp_file.as_file_mut(), manifest)
        .map_err(|error| format!("写入图片回收站清单失败：序列化失败：{error}"))?;
    temp_file
        .as_file_mut()
        .flush()
        .map_err(|error| format!("写入图片回收站清单失败：刷新临时文件失败：{error}"))?;
    temp_file
        .as_file_mut()
        .sync_all()
        .map_err(|error| format!("写入图片回收站清单失败：同步临时文件失败：{error}"))?;
    temp_file
        .persist_noclobber(&target)
        .map_err(|error| format!("写入图片回收站清单失败：保存失败：{}", error.error))?;
    sync_directory_best_effort(directory, "图片回收站项目目录");

    Ok(target)
}

fn create_unique_trash_item_dir_with_uuid_factory<F>(
    root: &Path,
    kind: ManagedResourceTrashKind,
    mut next_uuid: F,
) -> Result<(String, PathBuf), String>
where
    F: FnMut() -> Uuid,
{
    ensure_resource_trash_directories_under(root)?;
    for _ in 0..RESOURCE_IMPORT_PERSIST_RETRY_LIMIT {
        let trash_id = next_uuid().to_string();
        let item_dir = resource_trash_item_dir(root, kind, &trash_id);
        match fs::create_dir(&item_dir) {
            Ok(()) => return Ok((trash_id, item_dir)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建图片回收站项目失败：{error}")),
        }
    }

    Err("创建图片回收站项目失败：项目 ID 持续冲突。".to_string())
}

pub(crate) fn move_managed_resource_to_trash(
    root: &Path,
    resource_path: &str,
    source: ManagedResourceTrashSource,
    note_id: Option<i64>,
) -> Result<(), String> {
    move_managed_resource_to_trash_with_id_factory(
        root,
        resource_path,
        source,
        note_id,
        Uuid::new_v4,
    )
}

fn move_managed_resource_to_trash_with_id_factory<F>(
    root: &Path,
    resource_path: &str,
    source: ManagedResourceTrashSource,
    note_id: Option<i64>,
    next_trash_id: F,
) -> Result<(), String>
where
    F: FnMut() -> Uuid,
{
    let normalized_path = normalize_supported_image_resource_path(resource_path)?;
    if !is_app_managed_image_resource_path(&normalized_path) {
        return Err("资源路径不是可回收的 App 管理图片。".to_string());
    }

    let source_path = managed_resource_absolute_path_under_resources_root(root, &normalized_path)?;
    if !source_path.exists() {
        return Ok(());
    }
    if !source_path.is_file() {
        return Err("资源路径无效。".to_string());
    }

    let kind = ManagedResourceTrashKind::from_resource_path(&normalized_path)?;
    let (original_resource_id, extension) = resource_path_file_parts(&normalized_path)?;
    let (trash_id, item_dir) =
        create_unique_trash_item_dir_with_uuid_factory(root, kind, next_trash_id)?;
    let trash_path = trash_resource_relative_path(kind, &trash_id, &extension);
    let resource_file_name = trash_resource_file_name(&extension);
    let manifest = ResourceTrashManifest {
        trash_id: trash_id.clone(),
        resource_kind: kind.as_str().to_string(),
        original_path: normalized_path.clone(),
        trash_path,
        original_resource_id,
        extension,
        deleted_at: Utc::now().to_rfc3339(),
        source: source.as_str().to_string(),
        note_id,
        node_snapshot: None,
        restore_mode: None,
    };

    persist_copy_to_noclobber(
        &source_path,
        &item_dir,
        &resource_file_name,
        "移动图片到回收站",
    )?;
    write_manifest_atomic(&item_dir, &manifest)?;
    fs::remove_file(&source_path).map_err(|error| format!("移除原图片资源失败：{error}"))?;
    if let Some(parent) = source_path.parent() {
        sync_directory_best_effort(parent, "正式资源目录");
    }

    Ok(())
}

fn import_image_file(
    root: &Path,
    source_path: &Path,
    target: ImportedImageTarget,
) -> Result<String, String> {
    import_image_file_with_uuid_factory(root, source_path, target, Uuid::new_v4)
}

fn import_image_file_with_uuid_factory<F>(
    root: &Path,
    source_path: &Path,
    target: ImportedImageTarget,
    mut next_uuid: F,
) -> Result<String, String>
where
    F: FnMut() -> Uuid,
{
    if !source_path.is_file() {
        return Err(IMAGE_IMPORT_FAILED_MESSAGE.to_string());
    }

    ensure_resource_directories_with_temp_cleanup(root)?;

    let extension = normalize_image_extension(source_path)?;
    let target_directory = resource_subdir_path(root, target.subdir());
    let temp_suffix = format!(".{extension}{RESOURCE_TEMP_FILE_SUFFIX}");
    let mut temp_file = TempFileBuilder::new()
        .prefix(RESOURCE_TEMP_FILE_PREFIX)
        .suffix(&temp_suffix)
        .tempfile_in(&target_directory)
        .map_err(|error| {
            log_resource_error("创建临时图片文件", &error);
            IMAGE_IMPORT_FAILED_MESSAGE.to_string()
        })?;

    let mut source_file = fs::File::open(source_path).map_err(|error| {
        log_resource_error("读取图片资源", &error);
        IMAGE_IMPORT_FAILED_MESSAGE.to_string()
    })?;

    io::copy(&mut source_file, temp_file.as_file_mut()).map_err(|error| {
        log_resource_error("复制图片资源", &error);
        IMAGE_IMPORT_FAILED_MESSAGE.to_string()
    })?;
    temp_file.as_file_mut().flush().map_err(|error| {
        log_resource_error("刷新临时图片文件", &error);
        IMAGE_IMPORT_FAILED_MESSAGE.to_string()
    })?;
    temp_file.as_file_mut().sync_all().map_err(|error| {
        log_resource_error("同步临时图片文件", &error);
        IMAGE_IMPORT_FAILED_MESSAGE.to_string()
    })?;

    for _ in 0..RESOURCE_IMPORT_PERSIST_RETRY_LIMIT {
        let file_name = format!("{}.{}", next_uuid(), extension);
        let resource_path = format!("{}/{}/{}", RESOURCES_DIR_NAME, target.subdir(), file_name);
        let destination_path = root.join(&resource_path);

        match temp_file.persist_noclobber(&destination_path) {
            Ok(_) => return Ok(resource_path),
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                temp_file = error.file;
                continue;
            }
            Err(error) => {
                log_resource_error("保存图片资源", &error.error);
                return Err(IMAGE_IMPORT_FAILED_MESSAGE.to_string());
            }
        }
    }

    log_resource_error("保存图片资源", "目标文件名持续冲突");
    Err(IMAGE_IMPORT_FAILED_MESSAGE.to_string())
}

pub(crate) fn managed_resource_file_exists(
    root: &Path,
    resource_path: &str,
) -> Result<bool, String> {
    let absolute_path = managed_resource_absolute_path_under_resources_root(root, resource_path)?;

    if !absolute_path.exists() {
        return Ok(false);
    }

    if !absolute_path.is_file() {
        return Err(INVALID_RESOURCE_PATH_MESSAGE.to_string());
    }

    Ok(true)
}

pub(crate) fn delete_managed_resource_file_if_exists(
    root: &Path,
    resource_path: &str,
) -> Result<bool, String> {
    let absolute_path = managed_resource_absolute_path_under_resources_root(root, resource_path)?;

    if !absolute_path.exists() {
        return Ok(false);
    }

    if !absolute_path.is_file() {
        return Err(INVALID_RESOURCE_PATH_MESSAGE.to_string());
    }

    fs::remove_file(&absolute_path).map_err(|error| {
        log_resource_error("删除资源文件", &error);
        "图片资源清理失败，请稍后重试。".to_string()
    })?;
    if let Some(parent) = absolute_path.parent() {
        sync_directory_best_effort(parent, "正式资源目录");
    }

    Ok(true)
}

pub(crate) fn delete_managed_resource_internal(
    root: &Path,
    resource_path: &str,
) -> Result<(), String> {
    delete_managed_resource_file_if_exists(root, resource_path).map(|_| ())
}

fn resolve_managed_resource_internal(
    root: &Path,
    resource_path: &str,
) -> Result<ResolveManagedResourceResult, String> {
    let resource = describe_managed_resource(root, resource_path)?;
    let absolute_path = PathBuf::from(&resource.absolute_path);

    if absolute_path.is_file() {
        Ok(ResolveManagedResourceResult::Resolved { resource })
    } else {
        Ok(ResolveManagedResourceResult::Missing { resource })
    }
}

fn read_trash_manifest(path: &Path) -> Result<ResourceTrashManifest, String> {
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取图片回收站清单失败：{error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("解析图片回收站清单失败：{error}"))
}

fn validate_trash_manifest(
    manifest: &ResourceTrashManifest,
    kind: ManagedResourceTrashKind,
    trash_id: &str,
) -> Result<(), String> {
    if manifest.trash_id != trash_id {
        return Err("图片回收站清单中的项目 ID 无效。".to_string());
    }
    if manifest.resource_kind != kind.as_str() {
        return Err("图片回收站清单中的资源类型无效。".to_string());
    }
    if ManagedResourceTrashKind::from_resource_path(&manifest.original_path)? != kind {
        return Err("图片回收站清单中的原始路径类型无效。".to_string());
    }
    if !is_app_managed_image_resource_path(&manifest.original_path) {
        return Err("图片回收站清单中的原始路径无效。".to_string());
    }
    if !is_supported_image_extension(&manifest.extension) {
        return Err("图片回收站清单中的扩展名无效。".to_string());
    }
    let (original_resource_id, original_extension) =
        resource_path_file_parts(&manifest.original_path)?;
    if manifest.original_resource_id != original_resource_id
        || manifest.extension != original_extension
    {
        return Err("图片回收站清单中的原始文件信息无效。".to_string());
    }

    let expected_trash_path = trash_resource_relative_path(kind, trash_id, &manifest.extension);
    if manifest.trash_path != expected_trash_path {
        return Err("图片回收站清单中的回收站路径无效。".to_string());
    }

    Ok(())
}

fn find_resource_file_in_trash_item(item_dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(item_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if file_name.starts_with(&format!("{TRASH_RESOURCE_FILE_STEM}."))
            && !file_name.ends_with(".tmp")
        {
            return Some(path);
        }
    }

    None
}

fn build_trash_list_item(
    kind: ManagedResourceTrashKind,
    trash_id: String,
    item_dir: &Path,
) -> Option<ResourceTrashListItem> {
    let manifest_path = item_dir.join(TRASH_MANIFEST_FILE_NAME);
    let resource_file = find_resource_file_in_trash_item(item_dir);
    if !manifest_path.exists() && resource_file.is_none() {
        if let Err(error) = fs::remove_dir(item_dir) {
            eprintln!("[resource_ops] 清理空图片回收站目录失败: {error}");
        }
        return None;
    }

    if !manifest_path.is_file() {
        return Some(ResourceTrashListItem {
            trash_id,
            resource_kind: kind.as_str().to_string(),
            original_path: None,
            trash_path: resource_file
                .as_ref()
                .and_then(|path| path.strip_prefix(item_dir.parent()?.parent()?).ok())
                .map(|path| path.to_string_lossy().replace('\\', "/")),
            deleted_at: None,
            source: None,
            extension: None,
            file_exists: resource_file.is_some(),
            manifest_valid: false,
            can_restore: false,
            status: "invalid".to_string(),
            message: Some("manifest 缺失。".to_string()),
        });
    }

    let manifest = match read_trash_manifest(&manifest_path) {
        Ok(manifest) => manifest,
        Err(error) => {
            return Some(ResourceTrashListItem {
                trash_id,
                resource_kind: kind.as_str().to_string(),
                original_path: None,
                trash_path: None,
                deleted_at: None,
                source: None,
                extension: None,
                file_exists: resource_file.is_some(),
                manifest_valid: false,
                can_restore: false,
                status: "invalid".to_string(),
                message: Some(error),
            });
        }
    };

    let manifest_valid = validate_trash_manifest(&manifest, kind, &trash_id).is_ok();
    let expected_resource_path = item_dir.join(trash_resource_file_name(&manifest.extension));
    let file_exists = expected_resource_path.is_file();
    let can_restore = manifest_valid && file_exists;
    let status = if !manifest_valid {
        "invalid"
    } else if !file_exists {
        "broken"
    } else {
        "available"
    };

    Some(ResourceTrashListItem {
        trash_id,
        resource_kind: kind.as_str().to_string(),
        original_path: Some(manifest.original_path),
        trash_path: Some(manifest.trash_path),
        deleted_at: Some(manifest.deleted_at),
        source: Some(manifest.source),
        extension: Some(manifest.extension),
        file_exists,
        manifest_valid,
        can_restore,
        status: status.to_string(),
        message: if can_restore {
            None
        } else {
            Some("回收站项目不完整。".to_string())
        },
    })
}

fn list_resource_trash_items_internal(root: &Path) -> Result<Vec<ResourceTrashListItem>, String> {
    let mut items = Vec::new();
    for kind in [
        ManagedResourceTrashKind::Image,
        ManagedResourceTrashKind::Cover,
    ] {
        let trash_dir = resource_trash_subdir_path(root, kind);
        if !trash_dir.exists() {
            continue;
        }
        let entries =
            fs::read_dir(&trash_dir).map_err(|error| format!("读取图片回收站目录失败：{error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("读取图片回收站目录失败：{error}"))?;
            if !entry.path().is_dir() {
                continue;
            }
            let raw_trash_id = entry.file_name().to_string_lossy().to_string();
            let Ok(trash_id) = normalize_trash_id(&raw_trash_id) else {
                continue;
            };
            if let Some(item) = build_trash_list_item(kind, trash_id, &entry.path()) {
                items.push(item);
            }
        }
    }

    items.sort_by(|left, right| {
        right
            .deleted_at
            .cmp(&left.deleted_at)
            .then_with(|| left.trash_id.cmp(&right.trash_id))
    });
    Ok(items)
}

fn restore_resource_trash_item_internal<F>(
    root: &Path,
    kind: ManagedResourceTrashKind,
    trash_id: &str,
    mut next_uuid: F,
) -> Result<String, String>
where
    F: FnMut() -> Uuid,
{
    let trash_id = normalize_trash_id(trash_id)?;
    let item_dir = resource_trash_item_dir(root, kind, &trash_id);
    if !item_dir.is_dir() {
        return Err("回收站项目不存在。".to_string());
    }

    let manifest_path = item_dir.join(TRASH_MANIFEST_FILE_NAME);
    let manifest = read_trash_manifest(&manifest_path)?;
    validate_trash_manifest(&manifest, kind, &trash_id)?;
    let trash_resource_path = root.join(&manifest.trash_path);
    if !trash_resource_path.is_file() {
        return Err("回收站图片文件缺失，无法还原。".to_string());
    }

    ensure_resource_directories_under(root)?;
    let original_path = normalize_supported_image_resource_path(&manifest.original_path)?;
    let original_absolute = root.join(&original_path);
    let mut restored_path = None;

    if !original_absolute.exists() {
        persist_copy_to_noclobber(
            &trash_resource_path,
            original_absolute
                .parent()
                .ok_or_else(|| "资源路径无效。".to_string())?,
            original_absolute
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "资源路径无效。".to_string())?,
            "还原图片资源",
        )?;
        restored_path = Some(original_path);
    } else {
        let destination_dir = resource_subdir_path(root, kind.resource_subdir());
        for _ in 0..RESOURCE_TRASH_RESTORE_RETRY_LIMIT {
            let candidate = format!(
                "{}/{}/{}.{}",
                RESOURCES_DIR_NAME,
                kind.resource_subdir(),
                next_uuid(),
                manifest.extension
            );
            let candidate_absolute = root.join(&candidate);
            if candidate_absolute.exists() {
                continue;
            }
            persist_copy_to_noclobber(
                &trash_resource_path,
                &destination_dir,
                candidate_absolute
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "资源路径无效。".to_string())?,
                "还原图片资源",
            )?;
            restored_path = Some(candidate);
            break;
        }
    }

    let restored_path =
        restored_path.ok_or_else(|| "还原图片资源失败：目标路径持续冲突。".to_string())?;
    fs::remove_dir_all(&item_dir).map_err(|error| format!("清理图片回收站项目失败：{error}"))?;
    if let Some(parent) = item_dir.parent() {
        sync_directory_best_effort(parent, "图片回收站目录");
    }

    Ok(restored_path)
}

fn permanently_delete_resource_trash_item_internal(
    root: &Path,
    kind: ManagedResourceTrashKind,
    trash_id: &str,
) -> Result<(), String> {
    let trash_id = normalize_trash_id(trash_id)?;
    let item_dir = resource_trash_item_dir(root, kind, &trash_id);
    if !item_dir.is_dir() {
        return Err("回收站项目不存在。".to_string());
    }

    fs::remove_dir_all(&item_dir)
        .map_err(|error| format!("永久删除图片回收站项目失败：{error}"))?;
    if let Some(parent) = item_dir.parent() {
        sync_directory_best_effort(parent, "图片回收站目录");
    }
    Ok(())
}

#[tauri::command]
pub fn ensure_resource_directories(app: AppHandle) -> Result<(), String> {
    let root = resolve_app_root(&app)?;
    ensure_resource_directories_with_temp_cleanup(&root)
}

#[tauri::command]
pub fn select_and_import_image(
    app: AppHandle,
    target: String,
) -> Result<SelectAndImportImageResult, String> {
    let root = resolve_app_root(&app)?;
    ensure_resource_directories_under(&root)?;
    let image_target = ImportedImageTarget::parse(&target)?;

    let selected_path = FileDialog::new()
        .add_filter("图片", &SUPPORTED_IMAGE_EXTENSIONS)
        .pick_file();

    let Some(source_path) = selected_path else {
        return Ok(SelectAndImportImageResult::Cancelled);
    };

    let resource_path = import_image_file(&root, &source_path, image_target)?;
    let resource = describe_managed_resource(&root, &resource_path)?;

    Ok(SelectAndImportImageResult::Imported {
        target: image_target.as_str().to_string(),
        resource,
    })
}

#[tauri::command]
pub fn resolve_managed_resource(
    app: AppHandle,
    resource_path: String,
) -> Result<ResolveManagedResourceResult, String> {
    let root = resolve_app_root(&app)?;
    ensure_resource_directories_under(&root)?;
    resolve_managed_resource_internal(&root, &resource_path)
}

#[tauri::command]
pub fn delete_managed_resource(app: AppHandle, resource_path: String) -> Result<(), String> {
    let root = resolve_app_root(&app)?;
    delete_managed_resource_internal(&root, &resource_path)
}

#[tauri::command]
pub fn replace_managed_resource_session_leases(
    state: State<'_, ManagedResourceLeaseState>,
    session_id: String,
    resource_paths: Vec<String>,
) -> Result<(), String> {
    let session_id = normalize_session_id(&session_id)?;
    let mut leases = BTreeSet::new();

    for resource_path in resource_paths {
        match normalize_session_lease_resource_path(&resource_path) {
            Some(normalized_path) => {
                leases.insert(normalized_path);
            }
            None => {
                eprintln!("[resource_ops] 忽略无效图片资源会话租约: {}", resource_path);
            }
        }
    }

    state.replace_session_leases(session_id, leases)
}

#[tauri::command]
pub fn clear_managed_resource_session_leases(
    state: State<'_, ManagedResourceLeaseState>,
    session_id: String,
) -> Result<(), String> {
    let session_id = normalize_session_id(&session_id)?;
    state.clear_session_leases(&session_id)
}

#[tauri::command]
pub fn list_resource_trash_items(app: AppHandle) -> Result<Vec<ResourceTrashListItem>, String> {
    let root = resolve_app_root(&app)?;
    list_resource_trash_items_internal(&root)
}

#[tauri::command]
pub fn restore_resource_trash_item(
    app: AppHandle,
    resource_kind: String,
    trash_id: String,
) -> Result<String, String> {
    let root = resolve_app_root(&app)?;
    let kind = ManagedResourceTrashKind::parse(&resource_kind)?;
    restore_resource_trash_item_internal(&root, kind, &trash_id, Uuid::new_v4)
}

#[tauri::command]
pub fn permanently_delete_resource_trash_item(
    app: AppHandle,
    resource_kind: String,
    trash_id: String,
) -> Result<(), String> {
    let root = resolve_app_root(&app)?;
    let kind = ManagedResourceTrashKind::parse(&resource_kind)?;
    permanently_delete_resource_trash_item_internal(&root, kind, &trash_id)
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_stale_resource_temp_files_under_with_now, delete_managed_resource_internal,
        ensure_resource_directories_under, import_image_file, import_image_file_with_uuid_factory,
        is_app_managed_image_resource_path, list_resource_trash_items_internal,
        move_managed_resource_to_trash, move_managed_resource_to_trash_with_id_factory,
        normalize_managed_resource_path, normalize_session_lease_resource_path,
        permanently_delete_resource_trash_item_internal, resolve_managed_resource_internal,
        restore_resource_trash_item_internal, ImportedImageTarget, ManagedResourceLeaseState,
        ManagedResourceTrashKind, ManagedResourceTrashSource, ResolveManagedResourceResult,
    };
    use std::collections::BTreeSet;
    use std::fs;
    use std::time::Duration;
    use tempfile::tempdir;
    use uuid::Uuid;

    #[test]
    fn ensure_resource_directories_creates_required_subdirectories() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");

        assert!(temp_dir.path().join("resources").is_dir());
        assert!(temp_dir.path().join("resources/images").is_dir());
        assert!(temp_dir.path().join("resources/covers").is_dir());
    }

    #[test]
    fn import_image_file_copies_to_target_directory_with_uuid_name() {
        let temp_dir = tempdir().expect("create temp dir");
        let source_path = temp_dir.path().join("source-image.PNG");
        fs::write(&source_path, b"test-image").expect("write source image");

        let resource_path = import_image_file(
            temp_dir.path(),
            &source_path,
            ImportedImageTarget::NoteImage,
        )
        .expect("import image file");

        assert!(resource_path.starts_with("resources/images/"));
        assert!(resource_path.ends_with(".png"));
        assert!(is_app_managed_image_resource_path(&resource_path));
        assert!(temp_dir.path().join(&resource_path).is_file());
        assert_eq!(
            fs::read(temp_dir.path().join(&resource_path)).expect("read imported image"),
            b"test-image"
        );
        assert!(fs::read_dir(temp_dir.path().join("resources/images"))
            .expect("read images dir")
            .all(|entry| {
                !entry
                    .expect("read image entry")
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".creating")
            }));
    }

    #[test]
    fn import_image_file_retries_uuid_conflict_without_overwriting_existing_resource() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");
        let source_path = temp_dir.path().join("source-image.png");
        fs::write(&source_path, b"new-image").expect("write source image");

        let first_uuid =
            Uuid::parse_str("11111111-1111-4111-8111-111111111111").expect("parse uuid");
        let second_uuid =
            Uuid::parse_str("22222222-2222-4222-8222-222222222222").expect("parse uuid");
        let existing_path = temp_dir
            .path()
            .join("resources/images/11111111-1111-4111-8111-111111111111.png");
        fs::write(&existing_path, b"existing-image").expect("write existing image");
        let mut uuids = [first_uuid, second_uuid].into_iter();

        let resource_path = import_image_file_with_uuid_factory(
            temp_dir.path(),
            &source_path,
            ImportedImageTarget::NoteImage,
            || uuids.next().expect("next uuid"),
        )
        .expect("import image after retry");

        assert_eq!(
            resource_path,
            "resources/images/22222222-2222-4222-8222-222222222222.png"
        );
        assert_eq!(
            fs::read(existing_path).expect("read existing"),
            b"existing-image"
        );
        assert_eq!(
            fs::read(temp_dir.path().join(resource_path)).expect("read imported"),
            b"new-image"
        );
    }

    #[test]
    fn import_image_file_rejects_unsupported_extension() {
        let temp_dir = tempdir().expect("create temp dir");
        let source_path = temp_dir.path().join("source-image.txt");
        fs::write(&source_path, b"not-image").expect("write source text");

        let error = import_image_file(
            temp_dir.path(),
            &source_path,
            ImportedImageTarget::NoteImage,
        )
        .expect_err("reject unsupported image");

        assert_eq!(error, "当前文件不是支持的图片格式。");
        assert!(fs::read_dir(temp_dir.path().join("resources/images"))
            .expect("read images dir")
            .next()
            .is_none());
    }

    #[test]
    fn cleanup_stale_resource_temp_files_only_removes_old_matching_files() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");
        let old_temp = temp_dir
            .path()
            .join("resources/images/.resource-image-old.png.creating");
        let recent_temp = temp_dir
            .path()
            .join("resources/images/.resource-image-recent.png.creating");
        let formal_image = temp_dir.path().join("resources/images/formal.png");
        let other_creating = temp_dir.path().join("resources/images/random.creating");

        fs::write(&old_temp, b"old").expect("write old temp");
        fs::write(&recent_temp, b"recent").expect("write recent temp");
        fs::write(&formal_image, b"formal").expect("write formal");
        fs::write(&other_creating, b"other").expect("write other creating");

        let old_modified = fs::metadata(&old_temp)
            .expect("old temp metadata")
            .modified()
            .expect("old temp modified");
        let recent_deleted = cleanup_stale_resource_temp_files_under_with_now(
            temp_dir.path(),
            old_modified + Duration::from_secs(60 * 60),
        )
        .expect("skip recent temp files");

        assert_eq!(recent_deleted, 0);
        assert!(old_temp.exists());
        assert!(recent_temp.exists());

        let deleted = cleanup_stale_resource_temp_files_under_with_now(
            temp_dir.path(),
            old_modified + Duration::from_secs(24 * 60 * 60 + 1),
        )
        .expect("cleanup stale temp files");

        assert_eq!(deleted, 2);
        assert!(!old_temp.exists());
        assert!(!recent_temp.exists());
        assert!(formal_image.exists());
        assert!(other_creating.exists());
    }

    #[test]
    fn normalize_managed_resource_path_rejects_escape_paths() {
        for invalid_path in [
            "",
            "   ",
            "/resources/images/a.png",
            "resources/../images/a.png",
            "resources/./images/a.png",
            "resources\\images\\a.png",
            "C:/resources/images/a.png",
            "images/a.png",
        ] {
            let error =
                normalize_managed_resource_path(invalid_path).expect_err("reject invalid path");
            assert_eq!(error, "资源路径无效。");
        }
    }

    #[test]
    fn delete_managed_resource_rejects_paths_outside_resources_root() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");

        let error = delete_managed_resource_internal(temp_dir.path(), "../outside.png")
            .expect_err("reject resource escape path");

        assert_eq!(error, "资源路径无效。");
    }

    #[test]
    fn delete_managed_resource_allows_supported_historical_image_names() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");
        let resource_path = "resources/images/historical-image.png";
        fs::write(temp_dir.path().join(resource_path), b"historical").expect("write resource");

        delete_managed_resource_internal(temp_dir.path(), resource_path)
            .expect("delete historical resource");

        assert!(!temp_dir.path().join(resource_path).exists());
    }

    #[test]
    fn move_managed_resource_to_trash_writes_resource_and_manifest_before_removing_source() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");
        let resource_path = "resources/images/33333333-3333-4333-8333-333333333333.png";
        fs::write(temp_dir.path().join(resource_path), b"image").expect("write resource");

        move_managed_resource_to_trash(
            temp_dir.path(),
            resource_path,
            ManagedResourceTrashSource::OrphanCleanup,
            None,
        )
        .expect("move resource to trash");

        assert!(!temp_dir.path().join(resource_path).exists());
        let items = list_resource_trash_items_internal(temp_dir.path()).expect("list trash");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].resource_kind, "image");
        assert_eq!(items[0].original_path.as_deref(), Some(resource_path));
        assert!(items[0].file_exists);
        assert!(items[0].manifest_valid);
        assert!(items[0].can_restore);
        let trash_path = items[0].trash_path.as_ref().expect("trash path");
        assert_eq!(
            fs::read(temp_dir.path().join(trash_path)).expect("read trash file"),
            b"image"
        );
    }

    #[test]
    fn move_managed_resource_to_trash_keeps_source_when_trash_setup_fails() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");
        let resource_path = "resources/images/44444444-4444-4444-8444-444444444444.png";
        fs::write(temp_dir.path().join(resource_path), b"image").expect("write resource");
        let trash_id =
            Uuid::parse_str("55555555-5555-4555-8555-555555555555").expect("parse trash uuid");
        let item_dir = temp_dir
            .path()
            .join("resources_trash/images/55555555-5555-4555-8555-555555555555");
        fs::create_dir_all(&item_dir).expect("create trash item dir");

        let result = move_managed_resource_to_trash_with_id_factory(
            temp_dir.path(),
            resource_path,
            ManagedResourceTrashSource::OrphanCleanup,
            None,
            || trash_id,
        );

        assert!(result.is_err());
        assert!(temp_dir.path().join(resource_path).is_file());
    }

    #[test]
    fn list_resource_trash_items_reports_broken_and_invalid_items() {
        let temp_dir = tempdir().expect("create temp dir");
        let broken_dir = temp_dir
            .path()
            .join("resources_trash/images/66666666-6666-4666-8666-666666666666");
        fs::create_dir_all(&broken_dir).expect("create broken dir");
        fs::write(
            broken_dir.join("manifest.json"),
            r#"{
  "trashId": "66666666-6666-4666-8666-666666666666",
  "resourceKind": "image",
  "originalPath": "resources/images/66666666-6666-4666-8666-666666666666.png",
  "trashPath": "resources_trash/images/66666666-6666-4666-8666-666666666666/resource.png",
  "originalResourceId": "66666666-6666-4666-8666-666666666666",
  "extension": "png",
  "deletedAt": "2026-04-29T00:00:00Z",
  "source": "orphan-cleanup",
  "noteId": null,
  "nodeSnapshot": null,
  "restoreMode": null
}"#,
        )
        .expect("write broken manifest");
        let invalid_dir = temp_dir
            .path()
            .join("resources_trash/covers/77777777-7777-4777-8777-777777777777");
        fs::create_dir_all(&invalid_dir).expect("create invalid dir");
        fs::write(invalid_dir.join("resource.jpg"), b"cover").expect("write invalid resource");

        let items = list_resource_trash_items_internal(temp_dir.path()).expect("list trash");
        assert_eq!(items.len(), 2);
        assert!(items
            .iter()
            .any(|item| item.status == "broken" && !item.can_restore));
        assert!(items
            .iter()
            .any(|item| item.status == "invalid" && !item.can_restore));
    }

    #[test]
    fn restore_resource_trash_item_restores_original_path_without_overwriting() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");
        let resource_path = "resources/images/88888888-8888-4888-8888-888888888888.png";
        fs::write(temp_dir.path().join(resource_path), b"image").expect("write resource");
        move_managed_resource_to_trash(
            temp_dir.path(),
            resource_path,
            ManagedResourceTrashSource::OrphanCleanup,
            None,
        )
        .expect("move to trash");
        let trash_id = list_resource_trash_items_internal(temp_dir.path())
            .expect("list trash")
            .remove(0)
            .trash_id;

        let restored_path = restore_resource_trash_item_internal(
            temp_dir.path(),
            ManagedResourceTrashKind::Image,
            &trash_id,
            Uuid::new_v4,
        )
        .expect("restore trash item");

        assert_eq!(restored_path, resource_path);
        assert_eq!(
            fs::read(temp_dir.path().join(resource_path)).expect("read restored"),
            b"image"
        );
        assert!(list_resource_trash_items_internal(temp_dir.path())
            .expect("list trash after restore")
            .is_empty());
    }

    #[test]
    fn restore_resource_trash_item_generates_new_uuid_when_original_exists() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");
        let resource_path = "resources/covers/99999999-9999-4999-8999-999999999999.jpg";
        fs::write(temp_dir.path().join(resource_path), b"old-cover").expect("write resource");
        move_managed_resource_to_trash(
            temp_dir.path(),
            resource_path,
            ManagedResourceTrashSource::Cover,
            None,
        )
        .expect("move to trash");
        fs::write(temp_dir.path().join(resource_path), b"new-cover").expect("write conflict");
        let trash_id = list_resource_trash_items_internal(temp_dir.path())
            .expect("list trash")
            .remove(0)
            .trash_id;
        let next_uuid =
            Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").expect("parse uuid");

        let restored_path = restore_resource_trash_item_internal(
            temp_dir.path(),
            ManagedResourceTrashKind::Cover,
            &trash_id,
            || next_uuid,
        )
        .expect("restore with conflict");

        assert_eq!(
            fs::read(temp_dir.path().join(resource_path)).expect("read conflict"),
            b"new-cover"
        );
        assert_eq!(
            restored_path,
            "resources/covers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg"
        );
        assert_eq!(
            fs::read(temp_dir.path().join(restored_path)).expect("read restored"),
            b"old-cover"
        );
    }

    #[test]
    fn permanently_delete_resource_trash_item_removes_only_trash_item() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");
        let formal_path = "resources/images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png";
        let trashed_path = "resources/images/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png";
        fs::write(temp_dir.path().join(formal_path), b"formal").expect("write formal");
        fs::write(temp_dir.path().join(trashed_path), b"trashed").expect("write trashed");
        move_managed_resource_to_trash(
            temp_dir.path(),
            trashed_path,
            ManagedResourceTrashSource::OrphanCleanup,
            None,
        )
        .expect("move to trash");
        let trash_id = list_resource_trash_items_internal(temp_dir.path())
            .expect("list trash")
            .remove(0)
            .trash_id;

        permanently_delete_resource_trash_item_internal(
            temp_dir.path(),
            ManagedResourceTrashKind::Image,
            &trash_id,
        )
        .expect("permanently delete");

        assert!(temp_dir.path().join(formal_path).is_file());
        assert!(list_resource_trash_items_internal(temp_dir.path())
            .expect("list trash after delete")
            .is_empty());
    }

    #[test]
    fn managed_resource_lease_state_deduplicates_and_replaces_sessions() {
        let state = ManagedResourceLeaseState::default();
        let session_a = "session-a".to_string();
        let session_b = "session-b".to_string();

        state
            .replace_session_leases(
                session_a.clone(),
                BTreeSet::from([
                    "resources/images/11111111-1111-4111-8111-111111111111.png".to_string(),
                    "resources/images/11111111-1111-4111-8111-111111111111.png".to_string(),
                ]),
            )
            .expect("replace session a");
        state
            .replace_session_leases(
                session_b.clone(),
                BTreeSet::from([
                    "resources/images/22222222-2222-4222-8222-222222222222.png".to_string()
                ]),
            )
            .expect("replace session b");

        assert_eq!(
            state.snapshot(),
            BTreeSet::from([
                "resources/images/11111111-1111-4111-8111-111111111111.png".to_string(),
                "resources/images/22222222-2222-4222-8222-222222222222.png".to_string(),
            ])
        );

        state
            .replace_session_leases(session_a.clone(), BTreeSet::new())
            .expect("clear via empty replace");
        assert_eq!(
            state.snapshot(),
            BTreeSet::from([
                "resources/images/22222222-2222-4222-8222-222222222222.png".to_string(),
            ])
        );

        state
            .clear_session_leases(&session_b)
            .expect("clear session b");
        assert!(state.snapshot().is_empty());
    }

    #[test]
    fn session_lease_resource_path_accepts_only_app_managed_images() {
        assert_eq!(
            normalize_session_lease_resource_path(
                " resources/images/11111111-1111-4111-8111-111111111111.png "
            )
            .as_deref(),
            Some("resources/images/11111111-1111-4111-8111-111111111111.png")
        );

        for invalid_path in [
            "../outside.png",
            "resources/images/historical-image.png",
            "resources/images/11111111-1111-4111-8111-111111111111.txt",
            "resources/files/11111111-1111-4111-8111-111111111111.png",
        ] {
            assert!(normalize_session_lease_resource_path(invalid_path).is_none());
        }
    }

    #[test]
    fn resolve_managed_resource_reports_missing_and_existing_files() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_resource_directories_under(temp_dir.path()).expect("ensure resource directories");
        let resource_path = "resources/covers/example.png";

        let missing = resolve_managed_resource_internal(temp_dir.path(), resource_path)
            .expect("resolve missing resource");
        assert!(matches!(
            missing,
            ResolveManagedResourceResult::Missing { ref resource }
                if resource.resource_path == "resources/covers/example.png"
                    && resource.absolute_path.ends_with("resources/covers/example.png")
                    && !resource.asset_url.is_empty()
        ));

        let absolute_path = temp_dir.path().join(resource_path);
        fs::write(&absolute_path, b"cover").expect("write cover");

        let resolved = resolve_managed_resource_internal(temp_dir.path(), resource_path)
            .expect("resolve existing resource");
        assert!(matches!(
            resolved,
            ResolveManagedResourceResult::Resolved { ref resource }
                if resource.resource_path == "resources/covers/example.png"
                    && resource.absolute_path.ends_with("resources/covers/example.png")
                    && !resource.asset_url.is_empty()
        ));
    }
}

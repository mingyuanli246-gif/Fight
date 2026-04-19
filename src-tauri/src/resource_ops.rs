use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use rfd::FileDialog;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

const RESOURCES_DIR_NAME: &str = "resources";
const IMAGES_DIR_NAME: &str = "images";
const COVERS_DIR_NAME: &str = "covers";
const INVALID_RESOURCE_PATH_MESSAGE: &str = "资源路径无效。";
const IMAGE_IMPORT_FAILED_MESSAGE: &str = "图片导入失败，请稍后重试。";
const UNSUPPORTED_IMAGE_MESSAGE: &str = "当前文件不是支持的图片格式。";
const SUPPORTED_IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
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

fn ensure_resource_directories_under(root: &Path) -> Result<(), String> {
    ensure_directory(root, "应用数据目录")?;
    ensure_directory(&resources_root(root), "资源目录")?;
    ensure_directory(&resources_root(root).join(IMAGES_DIR_NAME), "正文图片目录")?;
    ensure_directory(&resources_root(root).join(COVERS_DIR_NAME), "封面目录")?;
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

fn managed_resource_absolute_path(root: &Path, resource_path: &str) -> Result<PathBuf, String> {
    Ok(root.join(normalize_managed_resource_path(resource_path)?))
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

fn import_image_file(
    root: &Path,
    source_path: &Path,
    target: ImportedImageTarget,
) -> Result<String, String> {
    if !source_path.is_file() {
        return Err(IMAGE_IMPORT_FAILED_MESSAGE.to_string());
    }

    ensure_resource_directories_under(root)?;

    let extension = normalize_image_extension(source_path)?;
    let file_name = format!("{}.{}", Uuid::new_v4(), extension);
    let resource_path = format!("{}/{}/{}", RESOURCES_DIR_NAME, target.subdir(), file_name);
    let destination_path = root.join(&resource_path);

    fs::copy(source_path, &destination_path).map_err(|error| {
        log_resource_error("复制图片资源", &error);
        IMAGE_IMPORT_FAILED_MESSAGE.to_string()
    })?;

    Ok(resource_path)
}

pub(crate) fn delete_managed_resource_internal(
    root: &Path,
    resource_path: &str,
) -> Result<(), String> {
    let absolute_path = managed_resource_absolute_path(root, resource_path)?;

    if !absolute_path.exists() {
        return Ok(());
    }

    if !absolute_path.is_file() {
        return Err(INVALID_RESOURCE_PATH_MESSAGE.to_string());
    }

    fs::remove_file(&absolute_path).map_err(|error| {
        log_resource_error("删除资源文件", &error);
        "图片资源清理失败，请稍后重试。".to_string()
    })
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

#[tauri::command]
pub fn ensure_resource_directories(app: AppHandle) -> Result<(), String> {
    let root = resolve_app_root(&app)?;
    ensure_resource_directories_under(&root)
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

#[cfg(test)]
mod tests {
    use super::{
        delete_managed_resource_internal, ensure_resource_directories_under, import_image_file,
        normalize_managed_resource_path, resolve_managed_resource_internal, ImportedImageTarget,
        ResolveManagedResourceResult,
    };
    use std::fs;
    use tempfile::tempdir;

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
        assert!(temp_dir.path().join(&resource_path).is_file());
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

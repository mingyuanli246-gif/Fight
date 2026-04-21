use crate::resource_ops::{
    delete_managed_resource_internal, normalize_managed_resource_path, resolve_app_root,
};
use chrono::{Local, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use walkdir::WalkDir;

const DATABASE_FILE_NAME: &str = "fight-notes.db";
const NOTE_SEARCH_TABLE_SQL: &str = "
  CREATE VIRTUAL TABLE IF NOT EXISTS note_search
  USING fts5(title, body_plaintext, tokenize = 'trigram')
";
const APP_META_TABLE_SQL: &str = "
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
";
const NOTE_SEARCH_META_VERSION: &str = "1";
const APP_META_KEY_NOTE_SEARCH_META_VERSION: &str = "note_search_meta_version";
const APP_META_KEY_NOTE_SEARCH_INITIALIZED: &str = "note_search_initialized";
const APP_META_KEY_NOTE_SEARCH_LAST_REBUILD_AT: &str = "note_search_last_rebuild_at";
const APP_META_KEY_REVIEW_FEATURE_REBUILD_V1_DONE: &str = "review_feature_rebuild_v1_done";
const APP_META_KEY_REVIEW_SCHEDULE_DIRTY_NOTE_IDS: &str = "review_schedule_dirty_note_ids";
const DEFAULT_REVIEW_PLAN_NAME: &str = "系统默认计划";
const DEFAULT_REVIEW_STEP_OFFSETS: [i64; 4] = [2, 5, 10, 18];
const LEGACY_RECOVERY_FOLDER_NAME: &str = "未归档迁移";
const TAG_COLOR_PALETTE: [&str; 8] = [
    "#2563EB", "#DC2626", "#CA8A04", "#059669", "#7C3AED", "#DB2777", "#0891B2", "#EA580C",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookRecord {
    pub id: i64,
    pub name: String,
    pub cover_image_path: Option<String>,
    pub custom_sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRecord {
    pub id: i64,
    pub notebook_id: i64,
    pub parent_folder_id: Option<i64>,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: i64,
    pub notebook_id: i64,
    pub folder_id: Option<i64>,
    pub sort_order: i64,
    pub title: String,
    pub content_plaintext: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlanStepRecord {
    pub id: i64,
    pub plan_id: i64,
    pub step_index: i64,
    pub offset_days: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlanWithStepsRecord {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub steps: Vec<ReviewPlanStepRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReviewBindingRecord {
    pub note_id: i64,
    pub plan_id: i64,
    pub start_date: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReviewBindingDetailRecord {
    pub binding: NoteReviewBindingRecord,
    pub plan: ReviewPlanWithStepsRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTaskRecord {
    pub id: i64,
    pub note_id: i64,
    pub plan_id: i64,
    pub due_date: String,
    pub step_index: i64,
    pub is_completed: bool,
    pub completed_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteReviewScheduleRecord {
    pub note_id: i64,
    pub dates: Vec<String>,
    pub updated_at: Option<String>,
    pub activated_at: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodayReviewTaskItemRecord {
    pub note_id: i64,
    pub notebook_id: i64,
    pub folder_id: Option<i64>,
    pub title: String,
    pub notebook_name: String,
    pub folder_path: String,
    pub due_date: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedResourceCleanupFailure {
    pub resource_path: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedResourceCleanupResult {
    pub deleted_count: usize,
    pub failed: Vec<ManagedResourceCleanupFailure>,
}

fn classify_database_error(message: &str) -> &'static str {
    let normalized = message.to_lowercase();

    if normalized.contains("database is locked") {
        "database is locked"
    } else if normalized.contains("cannot start a transaction within a transaction") {
        "cannot start a transaction within a transaction"
    } else if normalized.contains("cannot rollback - no transaction is active") {
        "cannot rollback - no transaction is active"
    } else if normalized.contains("no such table: app_meta") {
        "no such table: app_meta"
    } else if normalized.contains("no such table: note_search") {
        "no such table: note_search"
    } else {
        "sqlite error"
    }
}

fn log_database_error(action: &str, message: &str) {
    eprintln!(
        "[database_ops] {action}失败 [{}]: {message}",
        classify_database_error(message),
    );
}

fn to_command_error(action: &str, error: impl ToString) -> String {
    let message = error.to_string();
    log_database_error(action, &message);
    message
}

fn resolve_database_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_config_dir()
        .map_err(|error| to_command_error("读取数据库目录", error))?;

    Ok(root.join(DATABASE_FILE_NAME))
}

fn open_database_connection<R: Runtime>(app: &AppHandle<R>) -> Result<Connection, String> {
    let database_path = resolve_database_path(app)?;
    let connection =
        Connection::open(database_path).map_err(|error| to_command_error("打开数据库", error))?;

    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| to_command_error("设置数据库超时", error))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| to_command_error("开启外键约束", error))?;

    Ok(connection)
}

fn check_fts5_support(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE VIRTUAL TABLE temp.note_search_probe USING fts5(content, tokenize = 'trigram')",
            [],
        )
        .map_err(|error| to_command_error("检查 FTS5 支持", error))?;
    connection
        .execute("DROP TABLE temp.note_search_probe", [])
        .map_err(|error| to_command_error("清理 FTS5 检查表", error))?;

    Ok(())
}

fn ensure_app_meta_table(connection: &Connection) -> Result<(), String> {
    connection
        .execute(APP_META_TABLE_SQL, [])
        .map_err(|error| to_command_error("初始化 app_meta", error))?;
    Ok(())
}

fn ensure_note_search_table(connection: &Connection) -> Result<(), String> {
    connection
        .execute(NOTE_SEARCH_TABLE_SQL, [])
        .map_err(|error| to_command_error("初始化 note_search", error))?;
    Ok(())
}

fn get_app_meta_value(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM app_meta WHERE key = ?1 LIMIT 1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| to_command_error("读取 app_meta", error))
}

fn set_app_meta_value(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "
              INSERT INTO app_meta (key, value, updated_at)
              VALUES (?1, ?2, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            ",
            params![key, value],
        )
        .map_err(|error| to_command_error("写入 app_meta", error))?;

    Ok(())
}

fn get_note_count(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .map_err(|error| to_command_error("统计 notes", error))
}

fn get_note_search_count(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("SELECT COUNT(*) FROM note_search", [], |row| row.get(0))
        .map_err(|error| to_command_error("统计 note_search", error))
}

fn mark_note_search_initialized(connection: &Connection) -> Result<(), String> {
    set_app_meta_value(
        connection,
        APP_META_KEY_NOTE_SEARCH_META_VERSION,
        NOTE_SEARCH_META_VERSION,
    )?;
    set_app_meta_value(connection, APP_META_KEY_NOTE_SEARCH_INITIALIZED, "1")?;
    Ok(())
}

fn mark_note_search_rebuilt(connection: &Connection) -> Result<(), String> {
    mark_note_search_initialized(connection)?;
    set_app_meta_value(
        connection,
        APP_META_KEY_NOTE_SEARCH_LAST_REBUILD_AT,
        &Utc::now().to_rfc3339(),
    )?;
    Ok(())
}

fn rebuild_note_search_index_internal(connection: &mut Connection) -> Result<(), String> {
    let notes = {
        let mut statement = connection
            .prepare(
                "
                  SELECT
                    id,
                    title,
                    COALESCE(content_plaintext, '')
                  FROM notes
                  ORDER BY id ASC
                ",
            )
            .map_err(|error| to_command_error("读取索引源数据", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| to_command_error("读取索引源数据", error))?;

        let mut items = Vec::new();
        for row in rows {
            let (id, title, content_plaintext) =
                row.map_err(|error| to_command_error("读取索引源数据", error))?;
            items.push((id, title, content_plaintext));
        }
        items
    };

    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启搜索索引事务", error))?;

    transaction
        .execute("DELETE FROM note_search", [])
        .map_err(|error| to_command_error("清空搜索索引", error))?;

    for (id, title, content_plaintext) in notes {
        transaction
            .execute(
                "
                  INSERT INTO note_search (rowid, title, body_plaintext)
                  VALUES (?1, ?2, ?3)
                ",
                params![id, title, extract_indexable_plain_text(&content_plaintext)],
            )
            .map_err(|error| to_command_error("重建搜索索引", error))?;
    }

    transaction
        .commit()
        .map_err(|error| to_command_error("提交搜索索引事务", error))?;

    mark_note_search_rebuilt(connection)?;
    Ok(())
}

fn ensure_note_search_ready_internal(connection: &mut Connection) -> Result<(), String> {
    check_fts5_support(connection)?;
    ensure_app_meta_table(connection)?;
    ensure_note_search_table(connection)?;

    let meta_version = get_app_meta_value(connection, APP_META_KEY_NOTE_SEARCH_META_VERSION)?;
    let initialized =
        get_app_meta_value(connection, APP_META_KEY_NOTE_SEARCH_INITIALIZED)?.is_some();
    let note_count = get_note_count(connection)?;
    let note_search_count = get_note_search_count(connection)?;

    if note_count == 0 && note_search_count == 0 {
        if meta_version.as_deref() != Some(NOTE_SEARCH_META_VERSION) || !initialized {
            mark_note_search_initialized(connection)?;
        }
        return Ok(());
    }

    let should_rebuild = meta_version.as_deref() != Some(NOTE_SEARCH_META_VERSION)
        || !initialized
        || (note_count > 0 && note_search_count == 0);

    if should_rebuild {
        rebuild_note_search_index_internal(connection)?;
    }

    Ok(())
}

fn fetch_note_by_id(connection: &Connection, note_id: i64) -> Result<NoteRecord, String> {
    connection
        .query_row(
            "
              SELECT
                id,
                notebook_id,
                folder_id,
                sort_order,
                title,
                content_plaintext,
                created_at,
                updated_at
              FROM notes
              WHERE id = ?1
            ",
            [note_id],
            |row| {
                Ok(NoteRecord {
                    id: row.get(0)?,
                    notebook_id: row.get(1)?,
                    folder_id: row.get(2)?,
                    sort_order: row.get(3)?,
                    title: row.get(4)?,
                    content_plaintext: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .map_err(|error| to_command_error("读取新建文件", error))
}

fn fetch_notebook_by_id(
    connection: &Connection,
    notebook_id: i64,
) -> Result<NotebookRecord, String> {
    connection
        .query_row(
            "
              SELECT
                id,
                name,
                cover_image_path,
                custom_sort_order,
                created_at,
                updated_at
              FROM notebooks
              WHERE id = ?1
            ",
            [notebook_id],
            |row| {
                Ok(NotebookRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    cover_image_path: row.get(2)?,
                    custom_sort_order: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .map_err(|error| to_command_error("读取笔记本", error))
}

fn fetch_notebook_cover_image_path(
    connection: &Connection,
    notebook_id: i64,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "
              SELECT cover_image_path
              FROM notebooks
              WHERE id = ?1
            ",
            [notebook_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| to_command_error("读取笔记本封面路径", error))?
        .ok_or_else(|| "目标笔记本不存在。".to_string())
}

fn fetch_folder_by_id(connection: &Connection, folder_id: i64) -> Result<FolderRecord, String> {
    connection
        .query_row(
            "
              SELECT
                id,
                notebook_id,
                parent_folder_id,
                name,
                sort_order,
                created_at,
                updated_at
              FROM folders
              WHERE id = ?1
            ",
            [folder_id],
            |row| {
                Ok(FolderRecord {
                    id: row.get(0)?,
                    notebook_id: row.get(1)?,
                    parent_folder_id: row.get(2)?,
                    name: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .map_err(|error| to_command_error("读取文件夹", error))
}

fn notebook_exists(connection: &Connection, notebook_id: i64) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM notebooks WHERE id = ?1 LIMIT 1",
            [notebook_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| to_command_error("校验笔记本是否存在", error))
        .map(|value| value.is_some())
}

fn fetch_all_notebook_ids(connection: &Connection) -> Result<Vec<i64>, String> {
    let mut statement = connection
        .prepare(
            "
              SELECT id
              FROM notebooks
              ORDER BY custom_sort_order ASC, created_at ASC, id ASC
            ",
        )
        .map_err(|error| to_command_error("读取笔记本顺序", error))?;

    let rows = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| to_command_error("读取笔记本顺序", error))?;

    let mut notebook_ids = Vec::new();
    for row in rows {
        notebook_ids.push(row.map_err(|error| to_command_error("读取笔记本顺序", error))?);
    }

    Ok(notebook_ids)
}

fn fetch_top_level_folder_ids(
    connection: &Connection,
    notebook_id: i64,
) -> Result<Vec<i64>, String> {
    let mut statement = connection
        .prepare(
            "
              SELECT id
              FROM folders
              WHERE notebook_id = ?1 AND parent_folder_id IS NULL
              ORDER BY sort_order ASC, created_at ASC, id ASC
            ",
        )
        .map_err(|error| to_command_error("读取文件夹顺序", error))?;

    let rows = statement
        .query_map([notebook_id], |row| row.get::<_, i64>(0))
        .map_err(|error| to_command_error("读取文件夹顺序", error))?;

    let mut folder_ids = Vec::new();
    for row in rows {
        folder_ids.push(row.map_err(|error| to_command_error("读取文件夹顺序", error))?);
    }

    Ok(folder_ids)
}

fn fetch_note_ids_by_folder(connection: &Connection, folder_id: i64) -> Result<Vec<i64>, String> {
    let mut statement = connection
        .prepare(
            "
              SELECT id
              FROM notes
              WHERE folder_id = ?1
              ORDER BY sort_order ASC, created_at ASC, id ASC
            ",
        )
        .map_err(|error| to_command_error("读取文件顺序", error))?;

    let rows = statement
        .query_map([folder_id], |row| row.get::<_, i64>(0))
        .map_err(|error| to_command_error("读取文件顺序", error))?;

    let mut note_ids = Vec::new();
    for row in rows {
        note_ids.push(row.map_err(|error| to_command_error("读取文件顺序", error))?);
    }

    Ok(note_ids)
}

fn assign_notebook_custom_sort_orders(
    connection: &Connection,
    notebook_ids: &[i64],
) -> Result<(), String> {
    for (index, notebook_id) in notebook_ids.iter().enumerate() {
        connection
            .execute(
                "
                  UPDATE notebooks
                  SET custom_sort_order = ?1
                  WHERE id = ?2
                ",
                params![index as i64, notebook_id],
            )
            .map_err(|error| to_command_error("写入笔记本顺序", error))?;
    }

    Ok(())
}

fn assign_folder_sort_orders(connection: &Connection, folder_ids: &[i64]) -> Result<(), String> {
    for (index, folder_id) in folder_ids.iter().enumerate() {
        connection
            .execute(
                "
                  UPDATE folders
                  SET parent_folder_id = NULL, sort_order = ?1
                  WHERE id = ?2
                ",
                params![index as i64, folder_id],
            )
            .map_err(|error| to_command_error("写入文件夹顺序", error))?;
    }

    Ok(())
}

fn assign_note_sort_orders(connection: &Connection, note_ids: &[i64]) -> Result<(), String> {
    for (index, note_id) in note_ids.iter().enumerate() {
        connection
            .execute(
                "
                  UPDATE notes
                  SET sort_order = ?1
                  WHERE id = ?2
                ",
                params![index as i64, note_id],
            )
            .map_err(|error| to_command_error("写入文件顺序", error))?;
    }

    Ok(())
}

fn validate_reorder_ids(
    current_ids: &[i64],
    next_ids: &[i64],
    incomplete_message: &str,
    invalid_message: &str,
) -> Result<(), String> {
    if current_ids.len() != next_ids.len() {
        return Err(incomplete_message.to_string());
    }

    let current_set = current_ids.iter().copied().collect::<BTreeSet<_>>();
    let next_set = next_ids.iter().copied().collect::<BTreeSet<_>>();

    if next_set.len() != next_ids.len() || current_set != next_set {
        return Err(invalid_message.to_string());
    }

    Ok(())
}

fn create_unique_name(base_name: &str, existing_values: &BTreeSet<String>) -> String {
    if !existing_values.contains(base_name) {
        return base_name.to_string();
    }

    let mut index = 2;

    loop {
        let candidate = format!("{base_name} {index}");
        if !existing_values.contains(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn fetch_notebook_folder_names(
    connection: &Connection,
    notebook_id: i64,
) -> Result<BTreeSet<String>, String> {
    let mut statement = connection
        .prepare(
            "
              SELECT name
              FROM folders
              WHERE notebook_id = ?1
            ",
        )
        .map_err(|error| to_command_error("读取文件夹名称", error))?;

    let rows = statement
        .query_map([notebook_id], |row| row.get::<_, String>(0))
        .map_err(|error| to_command_error("读取文件夹名称", error))?;

    let mut names = BTreeSet::new();
    for row in rows {
        names.insert(row.map_err(|error| to_command_error("读取文件夹名称", error))?);
    }

    Ok(names)
}

fn fetch_notebook_folder_ids_in_tree_order(
    connection: &Connection,
    notebook_id: i64,
) -> Result<Vec<i64>, String> {
    let mut statement = connection
        .prepare(
            "
              WITH RECURSIVE folder_tree(id, path) AS (
                SELECT
                  id,
                  printf('%08d:%08d', sort_order, id) AS path
                FROM folders
                WHERE notebook_id = ?1 AND parent_folder_id IS NULL
                UNION ALL
                SELECT
                  child.id,
                  folder_tree.path || '/' || printf('%08d:%08d', child.sort_order, child.id)
                FROM folders AS child
                INNER JOIN folder_tree ON folder_tree.id = child.parent_folder_id
              )
              SELECT id
              FROM folder_tree
              ORDER BY path ASC
            ",
        )
        .map_err(|error| to_command_error("读取文件夹层级顺序", error))?;

    let rows = statement
        .query_map([notebook_id], |row| row.get::<_, i64>(0))
        .map_err(|error| to_command_error("读取文件夹层级顺序", error))?;

    let mut folder_ids = Vec::new();
    for row in rows {
        folder_ids.push(row.map_err(|error| to_command_error("读取文件夹层级顺序", error))?);
    }

    Ok(folder_ids)
}

fn fetch_orphan_note_ids_by_notebook(
    connection: &Connection,
    notebook_id: i64,
) -> Result<Vec<i64>, String> {
    let mut statement = connection
        .prepare(
            "
              SELECT id
              FROM notes
              WHERE notebook_id = ?1 AND folder_id IS NULL
              ORDER BY created_at ASC, id ASC
            ",
        )
        .map_err(|error| to_command_error("读取未归档文件", error))?;

    let rows = statement
        .query_map([notebook_id], |row| row.get::<_, i64>(0))
        .map_err(|error| to_command_error("读取未归档文件", error))?;

    let mut note_ids = Vec::new();
    for row in rows {
        note_ids.push(row.map_err(|error| to_command_error("读取未归档文件", error))?);
    }

    Ok(note_ids)
}

fn create_folder_tx_internal(
    connection: &mut Connection,
    notebook_id: i64,
    name: &str,
) -> Result<FolderRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| to_command_error("开启创建文件夹事务", error))?;

    if !notebook_exists(&transaction, notebook_id)? {
        return Err("目标笔记本不存在。".to_string());
    }

    transaction
        .execute(
            "
              UPDATE folders
              SET sort_order = sort_order + 1
              WHERE notebook_id = ?1 AND parent_folder_id IS NULL
            ",
            [notebook_id],
        )
        .map_err(|error| to_command_error("调整文件夹排序", error))?;

    transaction
        .execute(
            "
              INSERT INTO folders (notebook_id, parent_folder_id, name, sort_order)
              VALUES (?1, NULL, ?2, ?3)
            ",
            params![notebook_id, name, 0_i64],
        )
        .map_err(|error| to_command_error("创建文件夹", error))?;

    let folder_id = transaction.last_insert_rowid();
    transaction
        .commit()
        .map_err(|error| to_command_error("提交创建文件夹事务", error))?;

    fetch_folder_by_id(connection, folder_id)
}

fn create_notebook_tx_internal(
    connection: &mut Connection,
    name: &str,
) -> Result<NotebookRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| to_command_error("开启创建笔记本事务", error))?;

    let custom_sort_order = transaction
        .query_row(
            "SELECT COALESCE(MAX(custom_sort_order), -1) + 1 FROM notebooks",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| to_command_error("计算笔记本排序", error))?;

    transaction
        .execute(
            "
              INSERT INTO notebooks (name, cover_image_path, custom_sort_order)
              VALUES (?1, NULL, ?2)
            ",
            params![name, custom_sort_order],
        )
        .map_err(|error| to_command_error("创建笔记本", error))?;

    let notebook_id = transaction.last_insert_rowid();
    transaction
        .commit()
        .map_err(|error| to_command_error("提交创建笔记本事务", error))?;

    fetch_notebook_by_id(connection, notebook_id)
}

fn ensure_note_exists(connection: &Connection, note_id: i64) -> Result<(), String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM notes WHERE id = ?1 LIMIT 1",
            [note_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| to_command_error("校验文件是否存在", error))?;

    if exists.is_none() {
        return Err("目标文件不存在。".to_string());
    }

    Ok(())
}

fn ensure_folder_belongs_to_notebook(
    connection: &Connection,
    folder_id: i64,
    notebook_id: i64,
) -> Result<(), String> {
    let folder_notebook_id = connection
        .query_row(
            "SELECT notebook_id FROM folders WHERE id = ?1 LIMIT 1",
            [folder_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| to_command_error("校验文件夹归属", error))?;

    let Some(folder_notebook_id) = folder_notebook_id else {
        return Err("目标文件夹不存在。".to_string());
    };

    if folder_notebook_id != notebook_id {
        return Err("目标文件夹不属于当前笔记本。".to_string());
    }

    Ok(())
}

fn fetch_note_index_payload(
    connection: &Connection,
    note_id: i64,
) -> Result<(String, String), String> {
    connection
        .query_row(
            "
              SELECT
                title,
                COALESCE(content_plaintext, '')
              FROM notes
              WHERE id = ?1
            ",
            [note_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| to_command_error("读取文件索引数据", error))
}

fn upsert_note_search_entry(
    connection: &Connection,
    note_id: i64,
    title: &str,
    content_plaintext: &str,
) -> Result<(), String> {
    connection
        .execute("DELETE FROM note_search WHERE rowid = ?1", [note_id])
        .map_err(|error| to_command_error("清理旧文件索引", error))?;
    connection
        .execute(
            "
              INSERT INTO note_search (rowid, title, body_plaintext)
              VALUES (?1, ?2, ?3)
            ",
            params![
                note_id,
                title,
                extract_indexable_plain_text(content_plaintext)
            ],
        )
        .map_err(|error| to_command_error("写入文件搜索索引", error))?;
    Ok(())
}

fn delete_note_search_entry(connection: &Connection, note_id: i64) -> Result<(), String> {
    connection
        .execute("DELETE FROM note_search WHERE rowid = ?1", [note_id])
        .map_err(|error| to_command_error("删除文件搜索索引", error))?;
    Ok(())
}

fn delete_notebook_search_entries(connection: &Connection, notebook_id: i64) -> Result<(), String> {
    connection
        .execute(
            "
              DELETE FROM note_search
              WHERE rowid IN (
                SELECT id
                FROM notes
                WHERE notebook_id = ?1
              )
            ",
            [notebook_id],
        )
        .map_err(|error| to_command_error("删除笔记本搜索索引", error))?;
    Ok(())
}

fn delete_folder_search_entries(connection: &Connection, folder_id: i64) -> Result<(), String> {
    connection
        .execute(
            "
              WITH RECURSIVE folder_tree(id) AS (
                SELECT id
                FROM folders
                WHERE id = ?1
                UNION ALL
                SELECT child.id
                FROM folders AS child
                INNER JOIN folder_tree ON child.parent_folder_id = folder_tree.id
              )
              DELETE FROM note_search
              WHERE rowid IN (
                SELECT id
                FROM notes
                WHERE folder_id IN (SELECT id FROM folder_tree)
              )
            ",
            [folder_id],
        )
        .map_err(|error| to_command_error("删除文件夹搜索索引", error))?;
    Ok(())
}

fn delete_notes_by_folder_subtree(connection: &Connection, folder_id: i64) -> Result<(), String> {
    connection
        .execute(
            "
              WITH RECURSIVE folder_tree(id) AS (
                SELECT id
                FROM folders
                WHERE id = ?1
                UNION ALL
                SELECT child.id
                FROM folders AS child
                INNER JOIN folder_tree ON child.parent_folder_id = folder_tree.id
              )
              DELETE FROM notes
              WHERE folder_id IN (SELECT id FROM folder_tree)
            ",
            [folder_id],
        )
        .map_err(|error| to_command_error("删除文件夹内文件", error))?;
    Ok(())
}

fn fetch_tag_by_id(connection: &Connection, tag_id: i64) -> Result<TagRecord, String> {
    connection
        .query_row(
            "
              SELECT
                id,
                name,
                color,
                created_at,
                updated_at
              FROM tags
              WHERE id = ?1
            ",
            [tag_id],
            |row| {
                Ok(TagRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(|error| to_command_error("读取标签", error))
}

fn fetch_tag_by_name(connection: &Connection, name: &str) -> Result<Option<TagRecord>, String> {
    connection
        .query_row(
            "
              SELECT
                id,
                name,
                color,
                created_at,
                updated_at
              FROM tags
              WHERE name = ?1
              LIMIT 1
            ",
            [name],
            |row| {
                Ok(TagRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| to_command_error("读取标签", error))
}

fn fetch_tags_by_note(connection: &Connection, note_id: i64) -> Result<Vec<TagRecord>, String> {
    let mut statement = connection
        .prepare(
            "
              SELECT
                tags.id,
                tags.name,
                tags.color,
                tags.created_at,
                tags.updated_at
              FROM note_tags
              INNER JOIN tags ON tags.id = note_tags.tag_id
              WHERE note_tags.note_id = ?1
              ORDER BY tags.updated_at DESC, tags.id DESC
            ",
        )
        .map_err(|error| to_command_error("读取文件标签", error))?;
    let rows = statement
        .query_map([note_id], |row| {
            Ok(TagRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|error| to_command_error("读取文件标签", error))?;

    let mut tags = Vec::new();
    for row in rows {
        tags.push(row.map_err(|error| to_command_error("读取文件标签", error))?);
    }

    Ok(tags)
}

fn get_next_tag_color(connection: &Connection) -> Result<String, String> {
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .map_err(|error| to_command_error("统计标签数量", error))?;
    Ok(TAG_COLOR_PALETTE[(count as usize) % TAG_COLOR_PALETTE.len()].to_string())
}

fn create_tag_record(connection: &Connection, normalized_name: &str) -> Result<TagRecord, String> {
    let color = get_next_tag_color(connection)?;
    connection
        .execute(
            "
              INSERT INTO tags (name, color)
              VALUES (?1, ?2)
            ",
            params![normalized_name, color],
        )
        .map_err(|error| to_command_error("创建标签", error))?;
    let tag_id = connection.last_insert_rowid();
    fetch_tag_by_id(connection, tag_id)
}

fn normalize_tag_name(name: &str) -> Result<String, String> {
    let normalized = name.split_whitespace().collect::<Vec<_>>().join(" ");

    if normalized.is_empty() {
        return Err("标签名称不能为空。".to_string());
    }

    Ok(normalized)
}

fn fetch_review_plan_by_id(
    connection: &Connection,
    plan_id: i64,
) -> Result<(i64, String, String, String), String> {
    connection
        .query_row(
            "
              SELECT id, name, created_at, updated_at
              FROM review_plans
              WHERE id = ?1
            ",
            [plan_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|error| to_command_error("读取复习方案", error))
}

fn today_local_date_key() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

fn normalize_review_date(value: &str, today: NaiveDate) -> Result<String, String> {
    let normalized = value.trim();
    let date = NaiveDate::parse_from_str(normalized, "%Y-%m-%d")
        .map_err(|_| "复习日期无效。".to_string())?;

    if date.format("%Y-%m-%d").to_string() != normalized {
        return Err("复习日期无效。".to_string());
    }

    if date < today {
        return Err("复习日期不能早于今天。".to_string());
    }

    Ok(normalized.to_string())
}

fn normalize_review_dates(values: &[String], today: NaiveDate) -> Result<Vec<String>, String> {
    let mut normalized_dates = Vec::with_capacity(values.len());
    let mut unique_dates = BTreeSet::new();

    for value in values {
        let normalized = normalize_review_date(value, today)?;

        if !unique_dates.insert(normalized.clone()) {
            return Err("同一文件内的复习日期不能重复。".to_string());
        }

        normalized_dates.push(normalized);
    }

    normalized_dates.sort();
    Ok(normalized_dates)
}

fn get_review_schedule_dirty_note_ids(connection: &Connection) -> Result<BTreeSet<i64>, String> {
    let Some(raw_value) =
        get_app_meta_value(connection, APP_META_KEY_REVIEW_SCHEDULE_DIRTY_NOTE_IDS)?
    else {
        return Ok(BTreeSet::new());
    };

    let note_ids = serde_json::from_str::<Vec<i64>>(&raw_value)
        .map_err(|error| to_command_error("读取复习计划脏状态", error))?;

    Ok(note_ids.into_iter().collect())
}

fn set_review_schedule_dirty_note_ids(
    connection: &Connection,
    note_ids: &BTreeSet<i64>,
) -> Result<(), String> {
    let raw_value = serde_json::to_string(&note_ids.iter().copied().collect::<Vec<_>>())
        .map_err(|error| to_command_error("写入复习计划脏状态", error))?;

    set_app_meta_value(
        connection,
        APP_META_KEY_REVIEW_SCHEDULE_DIRTY_NOTE_IDS,
        &raw_value,
    )
}

fn update_review_schedule_dirty_note_id(
    connection: &Connection,
    note_id: i64,
    is_dirty: bool,
) -> Result<(), String> {
    let mut note_ids = get_review_schedule_dirty_note_ids(connection)?;

    if is_dirty {
        note_ids.insert(note_id);
    } else {
        note_ids.remove(&note_id);
    }

    set_review_schedule_dirty_note_ids(connection, &note_ids)
}

fn collect_review_note_ids(connection: &Connection) -> Result<BTreeSet<i64>, String> {
    let mut note_ids = BTreeSet::new();

    let mut binding_statement = connection
        .prepare("SELECT note_id FROM note_review_bindings")
        .map_err(|error| to_command_error("读取复习绑定", error))?;
    let binding_rows = binding_statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| to_command_error("读取复习绑定", error))?;
    for row in binding_rows {
        note_ids.insert(row.map_err(|error| to_command_error("读取复习绑定", error))?);
    }

    let mut task_statement = connection
        .prepare("SELECT DISTINCT note_id FROM review_tasks")
        .map_err(|error| to_command_error("读取复习任务", error))?;
    let task_rows = task_statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| to_command_error("读取复习任务", error))?;
    for row in task_rows {
        note_ids.insert(row.map_err(|error| to_command_error("读取复习任务", error))?);
    }

    Ok(note_ids)
}

fn note_exists(connection: &Connection, note_id: i64) -> Result<bool, String> {
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM notes WHERE id = ?1", [note_id], |row| {
            row.get(0)
        })
        .map_err(|error| to_command_error("读取文件", error))?;

    Ok(count > 0)
}

fn clear_all_review_tables(transaction: &Connection) -> Result<(), String> {
    transaction
        .execute("DELETE FROM review_tasks", [])
        .map_err(|error| to_command_error("清空复习任务", error))?;
    transaction
        .execute("DELETE FROM note_review_bindings", [])
        .map_err(|error| to_command_error("清空复习绑定", error))?;
    transaction
        .execute("DELETE FROM review_plan_steps", [])
        .map_err(|error| to_command_error("清空复习步骤", error))?;
    transaction
        .execute("DELETE FROM review_plans", [])
        .map_err(|error| to_command_error("清空复习方案", error))?;
    Ok(())
}

fn create_default_review_plan(transaction: &Connection) -> Result<ReviewPlanWithStepsRecord, String> {
    transaction
        .execute(
            "
              INSERT INTO review_plans (name)
              VALUES (?1)
            ",
            [DEFAULT_REVIEW_PLAN_NAME],
        )
        .map_err(|error| to_command_error("创建系统默认复习计划", error))?;

    let plan_id = transaction.last_insert_rowid();
    for (index, offset_days) in DEFAULT_REVIEW_STEP_OFFSETS.iter().enumerate() {
        transaction
            .execute(
                "
                  INSERT INTO review_plan_steps (plan_id, step_index, offset_days)
                  VALUES (?1, ?2, ?3)
                ",
                params![plan_id, (index as i64) + 1, offset_days],
            )
            .map_err(|error| to_command_error("写入系统默认复习步骤", error))?;
    }

    fetch_review_plan_with_steps(transaction, plan_id)
}

fn fetch_default_review_plan(
    connection: &Connection,
) -> Result<Option<ReviewPlanWithStepsRecord>, String> {
    let plan_id = connection
        .query_row(
            "SELECT id FROM review_plans WHERE name = ?1 LIMIT 1",
            [DEFAULT_REVIEW_PLAN_NAME],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| to_command_error("读取系统默认复习计划", error))?;

    let Some(plan_id) = plan_id else {
        return Ok(None);
    };

    Ok(Some(fetch_review_plan_with_steps(connection, plan_id)?))
}

fn default_review_plan_is_valid(connection: &Connection) -> Result<bool, String> {
    let Some(plan) = fetch_default_review_plan(connection)? else {
        return Ok(false);
    };

    let plan_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM review_plans", [], |row| row.get(0))
        .map_err(|error| to_command_error("读取复习方案数量", error))?;

    if plan_count != 1 || plan.steps.len() != DEFAULT_REVIEW_STEP_OFFSETS.len() {
        return Ok(false);
    }

    Ok(plan
        .steps
        .iter()
        .zip(DEFAULT_REVIEW_STEP_OFFSETS.iter())
        .all(|(step, expected_offset)| step.offset_days == *expected_offset))
}

fn clear_review_schedule_for_note(
    transaction: &Connection,
    note_id: i64,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM review_tasks WHERE note_id = ?1", [note_id])
        .map_err(|error| to_command_error("删除复习任务", error))?;
    transaction
        .execute("DELETE FROM note_review_bindings WHERE note_id = ?1", [note_id])
        .map_err(|error| to_command_error("删除复习绑定", error))?;
    update_review_schedule_dirty_note_id(transaction, note_id, false)?;
    Ok(())
}

fn write_note_review_schedule(
    transaction: &Connection,
    note_id: i64,
    plan_id: i64,
    activated_at: &str,
    dates: &[String],
) -> Result<NoteReviewScheduleRecord, String> {
    ensure_note_exists(transaction, note_id)?;
    clear_review_schedule_for_note(transaction, note_id)?;

    transaction
        .execute(
            "
              INSERT INTO note_review_bindings (note_id, plan_id, start_date)
              VALUES (?1, ?2, ?3)
            ",
            params![note_id, plan_id, activated_at],
        )
        .map_err(|error| to_command_error("写入复习绑定", error))?;

    for (index, due_date) in dates.iter().enumerate() {
        transaction
            .execute(
                "
                  INSERT INTO review_tasks (
                    note_id,
                    plan_id,
                    due_date,
                    step_index,
                    is_completed,
                    completed_at
                  )
                  VALUES (?1, ?2, ?3, ?4, 0, NULL)
                ",
                params![note_id, plan_id, due_date, (index as i64) + 1],
            )
            .map_err(|error| to_command_error("写入复习任务", error))?;
    }

    fetch_note_review_schedule(transaction, note_id)
        .map(|schedule| schedule.unwrap_or(NoteReviewScheduleRecord {
            note_id,
            dates: dates.to_vec(),
            updated_at: None,
            activated_at: Some(activated_at.to_string()),
        }))
}

fn build_default_review_dates(base_date: &str) -> Result<Vec<String>, String> {
    DEFAULT_REVIEW_STEP_OFFSETS
        .iter()
        .map(|offset_days| add_days(base_date, *offset_days))
        .collect()
}

fn reset_note_review_schedule_to_default(
    transaction: &Connection,
    note_id: i64,
    base_date: &str,
) -> Result<Option<NoteReviewScheduleRecord>, String> {
    if !note_exists(transaction, note_id)? {
        update_review_schedule_dirty_note_id(transaction, note_id, false)?;
        return Ok(None);
    }

    let default_plan = fetch_default_review_plan(transaction)?
        .ok_or_else(|| "系统默认复习计划不存在。".to_string())?;
    let dates = build_default_review_dates(base_date)?;
    let schedule = write_note_review_schedule(
        transaction,
        note_id,
        default_plan.id,
        base_date,
        &dates,
    )?;

    Ok(Some(schedule))
}

fn rebuild_review_state_to_default(
    connection: &mut Connection,
    note_ids: &BTreeSet<i64>,
    base_date: &str,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启重建复习数据事务", error))?;

    clear_all_review_tables(&transaction)?;
    create_default_review_plan(&transaction)?;

    for note_id in note_ids {
        if note_exists(&transaction, *note_id)? {
            reset_note_review_schedule_to_default(&transaction, *note_id, base_date)?;
        }
    }

    set_app_meta_value(
        &transaction,
        APP_META_KEY_REVIEW_FEATURE_REBUILD_V1_DONE,
        "1",
    )?;
    set_review_schedule_dirty_note_ids(&transaction, &BTreeSet::new())?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交重建复习数据事务", error))
}

fn fetch_note_review_schedule(
    connection: &Connection,
    note_id: i64,
) -> Result<Option<NoteReviewScheduleRecord>, String> {
    let binding_row = connection
        .query_row(
            "
              SELECT
                plan_id,
                start_date,
                updated_at
              FROM note_review_bindings
              WHERE note_id = ?1
              LIMIT 1
            ",
            [note_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| to_command_error("读取复习绑定", error))?;

    let Some((plan_id, activated_at, updated_at)) = binding_row else {
        return Ok(None);
    };

    let mut statement = connection
        .prepare(
            "
              SELECT due_date
              FROM review_tasks
              WHERE note_id = ?1 AND plan_id = ?2
              ORDER BY due_date ASC, step_index ASC, id ASC
            ",
        )
        .map_err(|error| to_command_error("读取复习任务", error))?;
    let rows = statement
        .query_map(params![note_id, plan_id], |row| row.get::<_, String>(0))
        .map_err(|error| to_command_error("读取复习任务", error))?;

    let mut dates = Vec::new();
    for row in rows {
        dates.push(row.map_err(|error| to_command_error("读取复习任务", error))?);
    }

    if dates.is_empty() {
        return Ok(None);
    }

    Ok(Some(NoteReviewScheduleRecord {
        note_id,
        dates,
        updated_at: Some(updated_at),
        activated_at: Some(activated_at),
    }))
}

fn ensure_review_feature_ready_internal(connection: &mut Connection) -> Result<(), String> {
    ensure_app_meta_table(connection)?;

    let today = today_local_date_key();
    let rebuild_done =
        get_app_meta_value(connection, APP_META_KEY_REVIEW_FEATURE_REBUILD_V1_DONE)?.is_some();
    let collected_note_ids = collect_review_note_ids(connection)?;

    if !rebuild_done {
        rebuild_review_state_to_default(connection, &collected_note_ids, &today)?;
    } else if !default_review_plan_is_valid(connection)? {
        rebuild_review_state_to_default(connection, &collected_note_ids, &today)?;
    }

    let dirty_note_ids = get_review_schedule_dirty_note_ids(connection)?;
    if dirty_note_ids.is_empty() {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启恢复默认复习计划事务", error))?;
    if fetch_default_review_plan(&transaction)?.is_none() {
        clear_all_review_tables(&transaction)?;
        create_default_review_plan(&transaction)?;
    }

    for note_id in dirty_note_ids {
        reset_note_review_schedule_to_default(&transaction, note_id, &today)?;
    }

    set_review_schedule_dirty_note_ids(&transaction, &BTreeSet::new())?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交恢复默认复习计划事务", error))
}

fn activate_note_review_schedule_tx_internal(
    connection: &mut Connection,
    note_id: i64,
) -> Result<NoteReviewScheduleRecord, String> {
    ensure_review_feature_ready_internal(connection)?;
    let today = today_local_date_key();
    let default_plan = fetch_default_review_plan(connection)?
        .ok_or_else(|| "系统默认复习计划不存在。".to_string())?;
    let dates = build_default_review_dates(&today)?;
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启执行复习计划事务", error))?;
    let schedule = write_note_review_schedule(&transaction, note_id, default_plan.id, &today, &dates)?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交执行复习计划事务", error))?;
    Ok(schedule)
}

fn save_note_review_schedule_tx_internal(
    connection: &mut Connection,
    note_id: i64,
    dates: &[String],
) -> Result<NoteReviewScheduleRecord, String> {
    ensure_review_feature_ready_internal(connection)?;
    let today = Local::now().date_naive();
    let normalized_dates = normalize_review_dates(dates, today)?;

    if normalized_dates.is_empty() {
        return Err("复习日期不能为空。".to_string());
    }

    let current_binding = fetch_binding_row_by_note_id(connection, note_id)?;
    let activated_at = current_binding
        .as_ref()
        .map(|binding| binding.start_date.clone())
        .unwrap_or_else(today_local_date_key);
    let default_plan = fetch_default_review_plan(connection)?
        .ok_or_else(|| "系统默认复习计划不存在。".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启保存复习计划事务", error))?;
    let schedule = write_note_review_schedule(
        &transaction,
        note_id,
        default_plan.id,
        &activated_at,
        &normalized_dates,
    )?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交保存复习计划事务", error))?;
    Ok(schedule)
}

fn clear_note_review_schedule_tx_internal(
    connection: &mut Connection,
    note_id: i64,
) -> Result<(), String> {
    ensure_review_feature_ready_internal(connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启清空复习计划事务", error))?;
    ensure_note_exists(&transaction, note_id)?;
    clear_review_schedule_for_note(&transaction, note_id)?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交清空复习计划事务", error))
}

fn set_note_review_schedule_dirty_tx_internal(
    connection: &mut Connection,
    note_id: i64,
    is_dirty: bool,
) -> Result<(), String> {
    ensure_app_meta_table(connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启更新复习计划脏状态事务", error))?;
    ensure_note_exists(&transaction, note_id)?;
    update_review_schedule_dirty_note_id(&transaction, note_id, is_dirty)?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交更新复习计划脏状态事务", error))
}

fn create_note_tx_internal(
    connection: &mut Connection,
    notebook_id: i64,
    folder_id: i64,
    title: &str,
) -> Result<NoteRecord, String> {
    ensure_folder_belongs_to_notebook(connection, folder_id, notebook_id)?;
    ensure_note_search_ready_internal(connection)?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| to_command_error("开启创建文件事务", error))?;
    transaction
        .execute(
            "
              UPDATE notes
              SET sort_order = sort_order + 1
              WHERE folder_id = ?1
            ",
            [folder_id],
        )
        .map_err(|error| to_command_error("调整文件排序", error))?;
    transaction
        .execute(
            "
              INSERT INTO notes (notebook_id, folder_id, sort_order, title, content_plaintext)
              VALUES (?1, ?2, 0, ?3, NULL)
            ",
            params![notebook_id, folder_id, title],
        )
        .map_err(|error| to_command_error("创建文件", error))?;

    let note_id = transaction.last_insert_rowid();
    transaction
        .execute(
            "
              INSERT INTO note_search (rowid, title, body_plaintext)
              VALUES (?1, ?2, '')
            ",
            params![note_id, title],
        )
        .map_err(|error| to_command_error("写入文件搜索索引", error))?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交创建文件事务", error))?;

    fetch_note_by_id(connection, note_id)
}

fn ensure_notebook_tree_constraints_tx_internal(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| to_command_error("开启修复笔记结构事务", error))?;

    let notebook_ids = fetch_all_notebook_ids(&transaction)?;

    for notebook_id in notebook_ids {
        let mut ordered_folder_ids =
            fetch_notebook_folder_ids_in_tree_order(&transaction, notebook_id)?;
        let orphan_note_ids = fetch_orphan_note_ids_by_notebook(&transaction, notebook_id)?;

        transaction
            .execute(
                "
                  UPDATE folders
                  SET parent_folder_id = NULL
                  WHERE notebook_id = ?1 AND parent_folder_id IS NOT NULL
                ",
                [notebook_id],
            )
            .map_err(|error| to_command_error("拍平旧文件夹结构", error))?;

        if !orphan_note_ids.is_empty() {
            let existing_names = fetch_notebook_folder_names(&transaction, notebook_id)?;
            let recovery_folder_name =
                create_unique_name(LEGACY_RECOVERY_FOLDER_NAME, &existing_names);

            transaction
                .execute(
                    "
                      INSERT INTO folders (notebook_id, parent_folder_id, name, sort_order)
                      VALUES (?1, NULL, ?2, ?3)
                    ",
                    params![notebook_id, recovery_folder_name, ordered_folder_ids.len() as i64],
                )
                .map_err(|error| to_command_error("创建恢复文件夹", error))?;

            let recovery_folder_id = transaction.last_insert_rowid();
            ordered_folder_ids.push(recovery_folder_id);

            for note_id in &orphan_note_ids {
                transaction
                    .execute(
                        "
                          UPDATE notes
                          SET folder_id = ?1
                          WHERE id = ?2
                        ",
                        params![recovery_folder_id, note_id],
                    )
                    .map_err(|error| to_command_error("迁移未归档文件", error))?;
            }

            assign_note_sort_orders(&transaction, &orphan_note_ids)?;
        }

        assign_folder_sort_orders(&transaction, &ordered_folder_ids)?;

        for folder_id in ordered_folder_ids {
            let note_ids = fetch_note_ids_by_folder(&transaction, folder_id)?;
            assign_note_sort_orders(&transaction, &note_ids)?;
        }
    }

    transaction
        .commit()
        .map_err(|error| to_command_error("提交修复笔记结构事务", error))
}

fn reorder_notebooks_tx_internal(
    connection: &mut Connection,
    ordered_notebook_ids: &[i64],
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| to_command_error("开启保存笔记本排序事务", error))?;
    let current_notebook_ids = fetch_all_notebook_ids(&transaction)?;

    validate_reorder_ids(
        &current_notebook_ids,
        ordered_notebook_ids,
        "笔记本顺序数据不完整。",
        "笔记本顺序数据无效。",
    )?;
    assign_notebook_custom_sort_orders(&transaction, ordered_notebook_ids)?;

    transaction
        .commit()
        .map_err(|error| to_command_error("提交保存笔记本排序事务", error))
}

fn reorder_folders_tx_internal(
    connection: &mut Connection,
    notebook_id: i64,
    ordered_folder_ids: &[i64],
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| to_command_error("开启保存文件夹排序事务", error))?;

    if !notebook_exists(&transaction, notebook_id)? {
        return Err("目标笔记本不存在。".to_string());
    }

    let current_folder_ids = fetch_top_level_folder_ids(&transaction, notebook_id)?;
    validate_reorder_ids(
        &current_folder_ids,
        ordered_folder_ids,
        "文件夹顺序数据不完整。",
        "文件夹顺序数据无效。",
    )?;
    assign_folder_sort_orders(&transaction, ordered_folder_ids)?;

    transaction
        .commit()
        .map_err(|error| to_command_error("提交保存文件夹排序事务", error))
}

fn move_note_tx_internal(
    connection: &mut Connection,
    note_id: i64,
    target_folder_id: i64,
    target_index: usize,
) -> Result<NoteRecord, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| to_command_error("开启移动文件事务", error))?;

    let (note_notebook_id, source_folder_id) = transaction
        .query_row(
            "
              SELECT notebook_id, folder_id
              FROM notes
              WHERE id = ?1
            ",
            [note_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(|error| to_command_error("读取目标文件", error))?
        .ok_or_else(|| "目标文件不存在。".to_string())?;

    ensure_folder_belongs_to_notebook(&transaction, target_folder_id, note_notebook_id)?;

    let mut target_note_ids = fetch_note_ids_by_folder(&transaction, target_folder_id)?;

    if source_folder_id == Some(target_folder_id) {
        target_note_ids.retain(|current_id| *current_id != note_id);
        if target_index > target_note_ids.len() {
            return Err("目标插入位置无效。".to_string());
        }
        target_note_ids.insert(target_index, note_id);
        assign_note_sort_orders(&transaction, &target_note_ids)?;
    } else {
        if target_index > target_note_ids.len() {
            return Err("目标插入位置无效。".to_string());
        }

        if let Some(source_folder_id) = source_folder_id {
            let mut source_note_ids = fetch_note_ids_by_folder(&transaction, source_folder_id)?;
            source_note_ids.retain(|current_id| *current_id != note_id);
            assign_note_sort_orders(&transaction, &source_note_ids)?;
        }

        transaction
            .execute(
                "
                  UPDATE notes
                  SET folder_id = ?1
                  WHERE id = ?2
                ",
                params![target_folder_id, note_id],
            )
            .map_err(|error| to_command_error("更新文件归属", error))?;

        target_note_ids.insert(target_index, note_id);
        assign_note_sort_orders(&transaction, &target_note_ids)?;
    }

    transaction
        .commit()
        .map_err(|error| to_command_error("提交移动文件事务", error))?;

    fetch_note_by_id(connection, note_id)
}

fn fetch_review_plan_with_steps(
    connection: &Connection,
    plan_id: i64,
) -> Result<ReviewPlanWithStepsRecord, String> {
    let (id, name, created_at, updated_at) = fetch_review_plan_by_id(connection, plan_id)?;

    let mut statement = connection
        .prepare(
            "
              SELECT id, plan_id, step_index, offset_days
              FROM review_plan_steps
              WHERE plan_id = ?1
              ORDER BY step_index ASC, id ASC
            ",
        )
        .map_err(|error| to_command_error("读取复习步骤", error))?;

    let rows = statement
        .query_map([plan_id], |row| {
            Ok(ReviewPlanStepRecord {
                id: row.get(0)?,
                plan_id: row.get(1)?,
                step_index: row.get(2)?,
                offset_days: row.get(3)?,
            })
        })
        .map_err(|error| to_command_error("读取复习步骤", error))?;

    let mut steps = Vec::new();
    for row in rows {
        steps.push(row.map_err(|error| to_command_error("读取复习步骤", error))?);
    }

    Ok(ReviewPlanWithStepsRecord {
        id,
        name,
        created_at,
        updated_at,
        steps,
    })
}

fn fetch_binding_row_by_note_id(
    connection: &Connection,
    note_id: i64,
) -> Result<Option<NoteReviewBindingRecord>, String> {
    connection
        .query_row(
            "
              SELECT
                note_id,
                plan_id,
                start_date,
                created_at,
                updated_at
              FROM note_review_bindings
              WHERE note_id = ?1
              LIMIT 1
            ",
            [note_id],
            |row| {
                Ok(NoteReviewBindingRecord {
                    note_id: row.get(0)?,
                    plan_id: row.get(1)?,
                    start_date: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| to_command_error("读取复习绑定", error))
}

fn fetch_review_task_by_id(
    connection: &Connection,
    task_id: i64,
) -> Result<ReviewTaskRecord, String> {
    connection
        .query_row(
            "
              SELECT
                id,
                note_id,
                plan_id,
                due_date,
                step_index,
                is_completed,
                completed_at,
                created_at
              FROM review_tasks
              WHERE id = ?1
            ",
            [task_id],
            |row| {
                Ok(ReviewTaskRecord {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    plan_id: row.get(2)?,
                    due_date: row.get(3)?,
                    step_index: row.get(4)?,
                    is_completed: row.get::<_, i64>(5)? == 1,
                    completed_at: row.get(6)?,
                    created_at: row.get(7)?,
                })
            },
        )
        .map_err(|error| to_command_error("读取复习任务", error))
}

fn clear_pending_tasks_for_note(connection: &Connection, note_id: i64) -> Result<(), String> {
    connection
        .execute(
            "
              DELETE FROM review_tasks
              WHERE note_id = ?1 AND is_completed = 0
            ",
            [note_id],
        )
        .map_err(|error| to_command_error("清理未完成复习任务", error))?;
    Ok(())
}

fn add_days(date_key: &str, offset_days: i64) -> Result<String, String> {
    let date = NaiveDate::parse_from_str(date_key, "%Y-%m-%d")
        .map_err(|error| to_command_error("解析起始日期", error))?;
    let due_date = date
        .checked_add_days(chrono::Days::new(offset_days as u64))
        .ok_or_else(|| "复习日期超出范围。".to_string())?;
    Ok(due_date.format("%Y-%m-%d").to_string())
}

fn create_review_plan_tx_internal(
    connection: &mut Connection,
    name: &str,
    offsets: &[i64],
) -> Result<ReviewPlanWithStepsRecord, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启创建复习方案事务", error))?;
    transaction
        .execute(
            "
              INSERT INTO review_plans (name)
              VALUES (?1)
            ",
            [name],
        )
        .map_err(|error| to_command_error("创建复习方案", error))?;

    let plan_id = transaction.last_insert_rowid();
    for (index, offset_days) in offsets.iter().enumerate() {
        transaction
            .execute(
                "
                  INSERT INTO review_plan_steps (plan_id, step_index, offset_days)
                  VALUES (?1, ?2, ?3)
                ",
                params![plan_id, (index as i64) + 1, offset_days],
            )
            .map_err(|error| to_command_error("写入复习步骤", error))?;
    }
    transaction
        .commit()
        .map_err(|error| to_command_error("提交创建复习方案事务", error))?;

    fetch_review_plan_with_steps(connection, plan_id)
}

fn rename_review_plan_tx_internal(
    connection: &mut Connection,
    plan_id: i64,
    name: &str,
) -> Result<ReviewPlanWithStepsRecord, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启重命名复习方案事务", error))?;
    let updated = transaction
        .execute(
            "
              UPDATE review_plans
              SET name = ?1, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?2
            ",
            params![name, plan_id],
        )
        .map_err(|error| to_command_error("重命名复习方案", error))?;

    if updated == 0 {
        return Err("目标复习方案不存在。".to_string());
    }

    transaction
        .commit()
        .map_err(|error| to_command_error("提交重命名复习方案事务", error))?;

    fetch_review_plan_with_steps(connection, plan_id)
}

fn delete_review_plan_tx_internal(connection: &mut Connection, plan_id: i64) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启删除复习方案事务", error))?;
    let deleted = transaction
        .execute("DELETE FROM review_plans WHERE id = ?1", [plan_id])
        .map_err(|error| to_command_error("删除复习方案", error))?;

    if deleted == 0 {
        return Err("目标复习方案不存在。".to_string());
    }

    transaction
        .commit()
        .map_err(|error| to_command_error("提交删除复习方案事务", error))?;
    Ok(())
}

fn set_review_task_completed_tx_internal(
    connection: &mut Connection,
    task_id: i64,
    completed: bool,
) -> Result<ReviewTaskRecord, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启更新复习任务事务", error))?;
    let updated = transaction
        .execute(
            "
              UPDATE review_tasks
              SET
                is_completed = ?1,
                completed_at = CASE WHEN ?1 = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
              WHERE id = ?2
            ",
            params![if completed { 1_i64 } else { 0_i64 }, task_id],
        )
        .map_err(|error| to_command_error("更新复习任务状态", error))?;

    if updated == 0 {
        return Err("目标复习任务不存在。".to_string());
    }

    transaction
        .commit()
        .map_err(|error| to_command_error("提交更新复习任务事务", error))?;

    fetch_review_task_by_id(connection, task_id)
}

fn delete_notebook_tx_internal(
    connection: &mut Connection,
    notebook_id: i64,
) -> Result<(), String> {
    ensure_note_search_ready_internal(connection)?;

    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启删除笔记本事务", error))?;
    delete_notebook_search_entries(&transaction, notebook_id)?;
    let deleted = transaction
        .execute("DELETE FROM notebooks WHERE id = ?1", [notebook_id])
        .map_err(|error| to_command_error("删除笔记本", error))?;

    if deleted == 0 {
        return Err("目标笔记本不存在。".to_string());
    }

    transaction
        .commit()
        .map_err(|error| to_command_error("提交删除笔记本事务", error))?;
    Ok(())
}

fn delete_folder_tx_internal(connection: &mut Connection, folder_id: i64) -> Result<(), String> {
    ensure_note_search_ready_internal(connection)?;

    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启删除文件夹事务", error))?;
    delete_folder_search_entries(&transaction, folder_id)?;
    delete_notes_by_folder_subtree(&transaction, folder_id)?;
    let deleted = transaction
        .execute("DELETE FROM folders WHERE id = ?1", [folder_id])
        .map_err(|error| to_command_error("删除文件夹", error))?;

    if deleted == 0 {
        return Err("目标文件夹不存在。".to_string());
    }

    transaction
        .commit()
        .map_err(|error| to_command_error("提交删除文件夹事务", error))?;
    Ok(())
}

fn update_notebook_cover_image_tx_internal(
    connection: &mut Connection,
    notebook_id: i64,
    cover_image_path: &str,
) -> Result<NotebookRecord, String> {
    let trimmed_path = cover_image_path.trim();

    if trimmed_path.is_empty() {
        return Err("封面路径不能为空。".to_string());
    }

    let normalized_path = normalize_managed_resource_path(trimmed_path)?;

    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启保存笔记本封面事务", error))?;
    let updated = transaction
        .execute(
            "
              UPDATE notebooks
              SET cover_image_path = ?1, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?2
            ",
            params![normalized_path, notebook_id],
        )
        .map_err(|error| to_command_error("保存笔记本封面", error))?;

    if updated == 0 {
        return Err("目标笔记本不存在。".to_string());
    }

    transaction
        .commit()
        .map_err(|error| to_command_error("提交保存笔记本封面事务", error))?;

    fetch_notebook_by_id(connection, notebook_id)
}

fn clear_notebook_cover_image_tx_internal(
    connection: &mut Connection,
    notebook_id: i64,
) -> Result<NotebookRecord, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启清除笔记本封面事务", error))?;
    let updated = transaction
        .execute(
            "
              UPDATE notebooks
              SET cover_image_path = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?1
            ",
            [notebook_id],
        )
        .map_err(|error| to_command_error("清除笔记本封面", error))?;

    if updated == 0 {
        return Err("目标笔记本不存在。".to_string());
    }

    transaction
        .commit()
        .map_err(|error| to_command_error("提交清除笔记本封面事务", error))?;

    fetch_notebook_by_id(connection, notebook_id)
}

fn rename_note_tx_internal(
    connection: &mut Connection,
    note_id: i64,
    title: &str,
) -> Result<NoteRecord, String> {
    ensure_note_search_ready_internal(connection)?;

    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启重命名文件事务", error))?;
    let updated = transaction
        .execute(
            "
              UPDATE notes
              SET title = ?1, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?2
            ",
            params![title, note_id],
        )
        .map_err(|error| to_command_error("重命名文件", error))?;

    if updated == 0 {
        return Err("目标文件不存在。".to_string());
    }

    let (_, content_plaintext) = fetch_note_index_payload(&transaction, note_id)?;
    upsert_note_search_entry(&transaction, note_id, title, &content_plaintext)?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交重命名文件事务", error))?;

    fetch_note_by_id(connection, note_id)
}

fn update_note_content_tx_internal(
    connection: &mut Connection,
    note_id: i64,
    content: &str,
) -> Result<NoteRecord, String> {
    ensure_note_search_ready_internal(connection)?;

    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启保存正文事务", error))?;
    let updated = transaction
        .execute(
            "
              UPDATE notes
              SET content_plaintext = ?1, updated_at = STRFTIME('%Y-%m-%d %H:%M:%f', 'now')
              WHERE id = ?2
            ",
            params![content, note_id],
        )
        .map_err(|error| to_command_error("保存正文", error))?;

    if updated == 0 {
        return Err("目标文件不存在。".to_string());
    }

    let (title, content_plaintext) = fetch_note_index_payload(&transaction, note_id)?;
    upsert_note_search_entry(&transaction, note_id, &title, &content_plaintext)?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交保存正文事务", error))?;

    fetch_note_by_id(connection, note_id)
}

fn delete_note_tx_internal(connection: &mut Connection, note_id: i64) -> Result<(), String> {
    ensure_note_search_ready_internal(connection)?;

    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启删除文件事务", error))?;
    let deleted = transaction
        .execute("DELETE FROM notes WHERE id = ?1", [note_id])
        .map_err(|error| to_command_error("删除文件", error))?;

    if deleted == 0 {
        return Err("目标文件不存在。".to_string());
    }

    delete_note_search_entry(&transaction, note_id)?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交删除文件事务", error))?;
    Ok(())
}

fn add_tag_to_note_by_name_tx_internal(
    connection: &mut Connection,
    note_id: i64,
    name: &str,
) -> Result<Vec<TagRecord>, String> {
    let normalized_name = normalize_tag_name(name)?;
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启添加标签事务", error))?;
    ensure_note_exists(&transaction, note_id)?;

    let tag = if let Some(tag) = fetch_tag_by_name(&transaction, &normalized_name)? {
        tag
    } else {
        create_tag_record(&transaction, &normalized_name)?
    };

    transaction
        .execute(
            "
              INSERT OR IGNORE INTO note_tags (note_id, tag_id)
              VALUES (?1, ?2)
            ",
            params![note_id, tag.id],
        )
        .map_err(|error| to_command_error("绑定标签到文件", error))?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交添加标签事务", error))?;

    fetch_tags_by_note(connection, note_id)
}

fn remove_tag_from_note_tx_internal(
    connection: &mut Connection,
    note_id: i64,
    tag_id: i64,
) -> Result<Vec<TagRecord>, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启移除标签事务", error))?;
    ensure_note_exists(&transaction, note_id)?;
    transaction
        .execute(
            "
              DELETE FROM note_tags
              WHERE note_id = ?1 AND tag_id = ?2
            ",
            params![note_id, tag_id],
        )
        .map_err(|error| to_command_error("移除标签", error))?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交移除标签事务", error))?;

    fetch_tags_by_note(connection, note_id)
}

fn bind_review_plan_to_note_tx_internal(
    connection: &mut Connection,
    note_id: i64,
    plan_id: i64,
    start_date: &str,
) -> Result<NoteReviewBindingDetailRecord, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启绑定复习方案事务", error))?;
    ensure_note_exists(&transaction, note_id)?;
    let plan = fetch_review_plan_with_steps(&transaction, plan_id)?;

    if plan.steps.is_empty() || plan.steps.len() > 5 {
        return Err("当前复习方案的步骤数据无效。".to_string());
    }

    let current_binding = fetch_binding_row_by_note_id(&transaction, note_id)?;
    if let Some(binding) = current_binding {
        if binding.plan_id == plan_id && binding.start_date == start_date {
            transaction
                .commit()
                .map_err(|error| to_command_error("提交绑定复习方案事务", error))?;
            return Ok(NoteReviewBindingDetailRecord { binding, plan });
        }
    }

    clear_pending_tasks_for_note(&transaction, note_id)?;
    transaction
        .execute(
            "
              INSERT INTO note_review_bindings (note_id, plan_id, start_date)
              VALUES (?1, ?2, ?3)
              ON CONFLICT(note_id) DO UPDATE SET
                plan_id = excluded.plan_id,
                start_date = excluded.start_date,
                updated_at = CURRENT_TIMESTAMP
            ",
            params![note_id, plan_id, start_date],
        )
        .map_err(|error| to_command_error("写入复习绑定", error))?;

    for step in &plan.steps {
        let due_date = add_days(start_date, step.offset_days)?;
        transaction
            .execute(
                "
                  INSERT OR IGNORE INTO review_tasks (
                    note_id,
                    plan_id,
                    due_date,
                    step_index,
                    is_completed,
                    completed_at
                  )
                  VALUES (?1, ?2, ?3, ?4, 0, NULL)
                ",
                params![note_id, plan_id, due_date, step.step_index],
            )
            .map_err(|error| to_command_error("生成复习任务", error))?;
    }

    let binding = fetch_binding_row_by_note_id(&transaction, note_id)?
        .ok_or_else(|| "绑定复习方案失败，请稍后重试。".to_string())?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交绑定复习方案事务", error))?;

    Ok(NoteReviewBindingDetailRecord { binding, plan })
}

fn remove_review_plan_binding_tx_internal(
    connection: &mut Connection,
    note_id: i64,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启移除复习绑定事务", error))?;
    ensure_note_exists(&transaction, note_id)?;
    transaction
        .execute(
            "DELETE FROM note_review_bindings WHERE note_id = ?1",
            [note_id],
        )
        .map_err(|error| to_command_error("删除复习绑定", error))?;
    clear_pending_tasks_for_note(&transaction, note_id)?;
    transaction
        .commit()
        .map_err(|error| to_command_error("提交移除复习绑定事务", error))?;
    Ok(())
}

fn push_normalized_text(text: &mut String, last_was_space: &mut bool, value: &str) {
    for character in value.chars() {
        if character == '\u{00A0}' || character.is_whitespace() {
            if !*last_was_space {
                text.push(' ');
                *last_was_space = true;
            }
        } else {
            text.push(character);
            *last_was_space = false;
        }
    }
}

fn push_separator(text: &mut String, last_was_space: &mut bool) {
    if !text.is_empty() && !*last_was_space {
        text.push(' ');
        *last_was_space = true;
    }
}

fn decode_html_entity(entity: &str) -> Option<String> {
    match entity {
        "amp" => Some("&".to_string()),
        "lt" => Some("<".to_string()),
        "gt" => Some(">".to_string()),
        "quot" => Some("\"".to_string()),
        "apos" => Some("'".to_string()),
        "nbsp" => Some(" ".to_string()),
        _ if entity.starts_with("#x") || entity.starts_with("#X") => {
            u32::from_str_radix(&entity[2..], 16)
                .ok()
                .and_then(char::from_u32)
                .map(|character| character.to_string())
        }
        _ if entity.starts_with('#') => entity[1..]
            .parse::<u32>()
            .ok()
            .and_then(char::from_u32)
            .map(|character| character.to_string()),
        _ => None,
    }
}

fn decode_html_entities(value: &str) -> String {
    let mut decoded = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();

    while let Some(character) = characters.next() {
        if character != '&' {
            decoded.push(character);
            continue;
        }

        let mut entity = String::new();
        let mut consumed_semicolon = false;

        while let Some(next_character) = characters.peek().copied() {
            if next_character == ';' {
                consumed_semicolon = true;
                characters.next();
                break;
            }

            if next_character == '&'
                || next_character == '<'
                || next_character == '>'
                || next_character.is_whitespace()
                || entity.len() >= 32
            {
                break;
            }

            entity.push(next_character);
            characters.next();
        }

        if consumed_semicolon {
            if let Some(entity_value) = decode_html_entity(&entity) {
                decoded.push_str(&entity_value);
                continue;
            }

            decoded.push('&');
            decoded.push_str(&entity);
            decoded.push(';');
            continue;
        }

        decoded.push('&');
        decoded.push_str(&entity);
    }

    decoded
}

fn extract_tag_name(tag: &str) -> Option<String> {
    let trimmed = tag.trim();
    let inner = trimmed.strip_prefix('<')?.strip_suffix('>')?.trim();
    let inner = inner
        .strip_prefix('/')
        .unwrap_or(inner)
        .trim_start_matches(|character: char| character.is_whitespace());

    let name: String = inner
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric())
        .collect();

    if name.is_empty() {
        None
    } else {
        Some(name.to_ascii_lowercase())
    }
}

fn is_closing_tag(tag: &str) -> bool {
    let trimmed = tag.trim_start();
    trimmed.starts_with("</")
}

fn is_separator_tag(tag_name: &str) -> bool {
    matches!(
        tag_name,
        "p" | "div"
            | "li"
            | "ul"
            | "ol"
            | "blockquote"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "aside"
            | "br"
            | "hr"
            | "tr"
            | "td"
            | "th"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
    )
}

fn extract_tag_attribute(tag: &str, name: &str) -> Option<String> {
    let name_position = tag.find(name)?;
    let remainder = &tag[name_position + name.len()..];
    let remainder = remainder.trim_start();
    let remainder = remainder.strip_prefix('=')?.trim_start();

    if let Some(rest) = remainder.strip_prefix('"') {
        let value_end = rest.find('"')?;
        return Some(rest[..value_end].to_string());
    }

    if let Some(rest) = remainder.strip_prefix('\'') {
        let value_end = rest.find('\'')?;
        return Some(rest[..value_end].to_string());
    }

    let value_end = remainder
        .find(|character: char| character.is_whitespace() || character == '>')
        .unwrap_or(remainder.len());
    Some(remainder[..value_end].to_string())
}

fn extract_math_latex_from_tag(tag: &str) -> Option<String> {
    if !tag.contains("data-note-math") {
        return None;
    }

    let latex = extract_tag_attribute(tag, "data-latex")?;
    Some(decode_html_entities(&latex).trim().to_string())
}

fn extract_image_alt_from_tag(tag: &str) -> Option<String> {
    if !tag.contains("data-note-image") {
        return None;
    }

    let alt = extract_tag_attribute(tag, "alt")?;
    let normalized = decode_html_entities(&alt).trim().to_string();

    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn extract_image_resource_path_from_tag(tag: &str) -> Option<String> {
    if !tag.contains("data-note-image") {
        return None;
    }

    let resource_path = extract_tag_attribute(tag, "data-resource-path")?;
    normalize_managed_resource_path(&resource_path).ok()
}

fn extract_note_image_resource_paths(content: &str) -> Vec<String> {
    let mut resource_paths = BTreeSet::new();
    let mut characters = content.chars().peekable();

    while let Some(character) = characters.next() {
        if character != '<' {
            continue;
        }

        let mut tag = String::from("<");

        while let Some(next_character) = characters.next() {
            tag.push(next_character);
            if next_character == '>' {
                break;
            }
        }

        if let Some(resource_path) = extract_image_resource_path_from_tag(&tag) {
            resource_paths.insert(resource_path);
        }
    }

    resource_paths.into_iter().collect()
}

fn extract_indexable_plain_text(content: &str) -> String {
    let mut text = String::with_capacity(content.len());
    let mut last_was_space = false;
    let mut characters = content.chars().peekable();
    let mut skip_math_tag_name: Option<String> = None;

    while let Some(character) = characters.next() {
        if character == '<' {
            let mut tag = String::from("<");

            while let Some(next_character) = characters.next() {
                tag.push(next_character);
                if next_character == '>' {
                    break;
                }
            }

            if let Some(tag_name) = extract_tag_name(&tag) {
                if is_separator_tag(&tag_name) {
                    push_separator(&mut text, &mut last_was_space);
                }

                if is_closing_tag(&tag) {
                    if skip_math_tag_name.as_deref() == Some(tag_name.as_str()) {
                        skip_math_tag_name = None;
                    }
                    continue;
                }

                if skip_math_tag_name.is_none() {
                    if let Some(latex) = extract_math_latex_from_tag(&tag) {
                        push_separator(&mut text, &mut last_was_space);
                        push_normalized_text(&mut text, &mut last_was_space, &latex);
                        skip_math_tag_name = Some(tag_name);
                        continue;
                    }

                    if let Some(alt) = extract_image_alt_from_tag(&tag) {
                        push_separator(&mut text, &mut last_was_space);
                        push_normalized_text(&mut text, &mut last_was_space, &alt);
                    }
                }
            }

            continue;
        }

        if skip_math_tag_name.is_some() {
            continue;
        }

        if character == '&' {
            let mut entity = String::new();
            let mut consumed_semicolon = false;

            while let Some(next_character) = characters.peek().copied() {
                if next_character == ';' {
                    consumed_semicolon = true;
                    characters.next();
                    break;
                }

                if next_character == '<'
                    || next_character == '>'
                    || next_character.is_whitespace()
                    || entity.len() >= 32
                {
                    break;
                }

                entity.push(next_character);
                characters.next();
            }

            if consumed_semicolon {
                if let Some(decoded) = decode_html_entity(&entity) {
                    push_normalized_text(&mut text, &mut last_was_space, &decoded);
                    continue;
                }

                push_normalized_text(&mut text, &mut last_was_space, &format!("&{entity};"));
                continue;
            }

            push_normalized_text(&mut text, &mut last_was_space, "&");
            push_normalized_text(&mut text, &mut last_was_space, &entity);
            continue;
        }

        let mut literal = String::new();
        literal.push(character);
        push_normalized_text(&mut text, &mut last_was_space, &literal);
    }

    text.trim().to_string()
}

fn extend_resource_paths_from_note_content(paths: &mut BTreeSet<String>, content: &str) {
    for resource_path in extract_note_image_resource_paths(content) {
        paths.insert(resource_path);
    }
}

fn insert_normalized_resource_path(paths: &mut BTreeSet<String>, resource_path: &str) {
    if let Ok(normalized_path) = normalize_managed_resource_path(resource_path) {
        paths.insert(normalized_path);
    }
}

fn to_cleanup_failure(resource_path: impl Into<String>, message: impl Into<String>) -> ManagedResourceCleanupFailure {
    ManagedResourceCleanupFailure {
        resource_path: resource_path.into(),
        message: message.into(),
    }
}

fn collect_managed_resource_paths_for_note(
    connection: &Connection,
    note_id: i64,
) -> Result<Vec<String>, String> {
    let content = connection
        .query_row(
            "
              SELECT COALESCE(content_plaintext, '')
              FROM notes
              WHERE id = ?1
            ",
            [note_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| to_command_error("读取文件资源引用", error))?
        .ok_or_else(|| "目标文件不存在。".to_string())?;

    let mut resource_paths = BTreeSet::new();
    extend_resource_paths_from_note_content(&mut resource_paths, &content);
    Ok(resource_paths.into_iter().collect())
}

fn collect_managed_resource_paths_for_folder_subtree(
    connection: &Connection,
    folder_id: i64,
) -> Result<Vec<String>, String> {
    let folder_exists = connection
        .query_row(
            "SELECT 1 FROM folders WHERE id = ?1 LIMIT 1",
            [folder_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| to_command_error("校验文件夹是否存在", error))?;

    if folder_exists.is_none() {
        return Err("目标文件夹不存在。".to_string());
    }

    let mut statement = connection
        .prepare(
            "
              WITH RECURSIVE folder_tree(id) AS (
                SELECT id
                FROM folders
                WHERE id = ?1
                UNION ALL
                SELECT child.id
                FROM folders AS child
                INNER JOIN folder_tree ON child.parent_folder_id = folder_tree.id
              )
              SELECT COALESCE(content_plaintext, '')
              FROM notes
              WHERE folder_id IN (SELECT id FROM folder_tree)
            ",
        )
        .map_err(|error| to_command_error("读取文件夹资源引用", error))?;
    let rows = statement
        .query_map([folder_id], |row| row.get::<_, String>(0))
        .map_err(|error| to_command_error("读取文件夹资源引用", error))?;

    let mut resource_paths = BTreeSet::new();
    for row in rows {
        extend_resource_paths_from_note_content(
            &mut resource_paths,
            &row.map_err(|error| to_command_error("读取文件夹资源引用", error))?,
        );
    }

    Ok(resource_paths.into_iter().collect())
}

fn collect_managed_resource_paths_for_notebook(
    connection: &Connection,
    notebook_id: i64,
) -> Result<Vec<String>, String> {
    let cover_image_path = connection
        .query_row(
            "
              SELECT cover_image_path
              FROM notebooks
              WHERE id = ?1
            ",
            [notebook_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| to_command_error("读取笔记本资源引用", error))?
        .ok_or_else(|| "目标笔记本不存在。".to_string())?;

    let mut statement = connection
        .prepare(
            "
              SELECT COALESCE(content_plaintext, '')
              FROM notes
              WHERE notebook_id = ?1
            ",
        )
        .map_err(|error| to_command_error("读取笔记本资源引用", error))?;
    let rows = statement
        .query_map([notebook_id], |row| row.get::<_, String>(0))
        .map_err(|error| to_command_error("读取笔记本资源引用", error))?;

    let mut resource_paths = BTreeSet::new();
    if let Some(path) = cover_image_path.as_deref() {
        insert_normalized_resource_path(&mut resource_paths, path);
    }

    for row in rows {
        extend_resource_paths_from_note_content(
            &mut resource_paths,
            &row.map_err(|error| to_command_error("读取笔记本资源引用", error))?,
        );
    }

    Ok(resource_paths.into_iter().collect())
}

fn list_live_managed_resource_paths(connection: &Connection) -> Result<BTreeSet<String>, String> {
    let mut resource_paths = BTreeSet::new();

    let mut cover_statement = connection
        .prepare(
            "
              SELECT cover_image_path
              FROM notebooks
              WHERE cover_image_path IS NOT NULL
            ",
        )
        .map_err(|error| to_command_error("读取存活封面引用", error))?;
    let cover_rows = cover_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| to_command_error("读取存活封面引用", error))?;

    for row in cover_rows {
        insert_normalized_resource_path(
            &mut resource_paths,
            &row.map_err(|error| to_command_error("读取存活封面引用", error))?,
        );
    }

    let mut note_statement = connection
        .prepare(
            "
              SELECT COALESCE(content_plaintext, '')
              FROM notes
              WHERE content_plaintext IS NOT NULL
            ",
        )
        .map_err(|error| to_command_error("读取存活正文资源引用", error))?;
    let note_rows = note_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| to_command_error("读取存活正文资源引用", error))?;

    for row in note_rows {
        extend_resource_paths_from_note_content(
            &mut resource_paths,
            &row.map_err(|error| to_command_error("读取存活正文资源引用", error))?,
        );
    }

    Ok(resource_paths)
}

fn select_unreferenced_managed_resource_paths(
    connection: &Connection,
    candidate_paths: &[String],
) -> Result<Vec<String>, String> {
    let mut normalized_candidates = BTreeSet::new();
    for candidate_path in candidate_paths {
        insert_normalized_resource_path(&mut normalized_candidates, candidate_path);
    }

    if normalized_candidates.is_empty() {
        return Ok(Vec::new());
    }

    let live_resource_paths = list_live_managed_resource_paths(connection)?;
    Ok(normalized_candidates
        .into_iter()
        .filter(|candidate_path| !live_resource_paths.contains(candidate_path))
        .collect())
}

fn cleanup_candidate_unreferenced_managed_resources(
    root: &Path,
    connection: &Connection,
    candidate_paths: &[String],
) -> Result<ManagedResourceCleanupResult, String> {
    let cleanup_targets = select_unreferenced_managed_resource_paths(connection, candidate_paths)?;
    let mut result = ManagedResourceCleanupResult {
        deleted_count: 0,
        failed: Vec::new(),
    };

    for resource_path in cleanup_targets {
        match delete_managed_resource_internal(root, &resource_path) {
            Ok(()) => {
                result.deleted_count += 1;
            }
            Err(error) => {
                result
                    .failed
                    .push(to_cleanup_failure(resource_path, error));
            }
        }
    }

    Ok(result)
}

fn managed_resource_path_from_absolute_path(
    root: &Path,
    absolute_path: &Path,
) -> Result<String, String> {
    let relative_path = absolute_path
        .strip_prefix(root)
        .map_err(|_| "资源路径无效。".to_string())?;
    let mut segments = Vec::new();

    for component in relative_path.components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment
                    .to_str()
                    .ok_or_else(|| "资源路径包含无法识别的字符。".to_string())?;
                segments.push(segment);
            }
            _ => return Err("资源路径无效。".to_string()),
        }
    }

    normalize_managed_resource_path(&segments.join("/"))
}

fn collect_managed_resource_file_candidates(
    root: &Path,
    directory_name: &str,
    resource_paths: &mut BTreeSet<String>,
    failures: &mut Vec<ManagedResourceCleanupFailure>,
) {
    let directory_path = root.join(directory_name);

    if !directory_path.exists() {
        return;
    }

    for entry in WalkDir::new(&directory_path).min_depth(1) {
        match entry {
            Ok(entry) => {
                if !entry.file_type().is_file() {
                    continue;
                }

                let entry_path = entry.path();
                match managed_resource_path_from_absolute_path(root, entry_path) {
                    Ok(resource_path) => {
                        resource_paths.insert(resource_path);
                    }
                    Err(error) => {
                        failures.push(to_cleanup_failure(
                            entry_path.to_string_lossy().to_string(),
                            error,
                        ));
                    }
                }
            }
            Err(error) => {
                failures.push(to_cleanup_failure(directory_name.to_string(), error.to_string()));
            }
        }
    }
}

fn cleanup_unreferenced_managed_resources_internal(
    root: &Path,
    connection: &Connection,
) -> Result<ManagedResourceCleanupResult, String> {
    let mut candidate_paths = BTreeSet::new();
    let mut failures = Vec::new();

    collect_managed_resource_file_candidates(
        root,
        "resources/images",
        &mut candidate_paths,
        &mut failures,
    );
    collect_managed_resource_file_candidates(
        root,
        "resources/covers",
        &mut candidate_paths,
        &mut failures,
    );

    let mut result = cleanup_candidate_unreferenced_managed_resources(
        root,
        connection,
        &candidate_paths.into_iter().collect::<Vec<_>>(),
    )?;
    result.failed.extend(failures);

    Ok(result)
}

fn cleanup_unreferenced_managed_resources_best_effort<R: Runtime>(
    app: &AppHandle<R>,
    connection: &Connection,
    candidate_paths: &[String],
) {
    if candidate_paths.is_empty() {
        return;
    }

    let root = match resolve_app_root(app) {
        Ok(root) => root,
        Err(error) => {
            eprintln!("[database_ops] 清理孤儿资源失败 [读取应用数据目录]: {error}");
            return;
        }
    };

    match cleanup_candidate_unreferenced_managed_resources(&root, connection, candidate_paths) {
        Ok(result) => {
            for failure in result.failed {
                eprintln!(
                    "[database_ops] 清理孤儿资源失败 [{}]: {}",
                    failure.resource_path, failure.message
                );
            }
        }
        Err(error) => {
            eprintln!("[database_ops] 清理孤儿资源失败: {error}");
        }
    }
}

#[tauri::command]
pub fn ensure_note_search_ready(app: AppHandle) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    ensure_note_search_ready_internal(&mut connection)
}

#[tauri::command]
pub fn rebuild_note_search_index(app: AppHandle) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    check_fts5_support(&connection)?;
    ensure_app_meta_table(&connection)?;
    ensure_note_search_table(&connection)?;
    rebuild_note_search_index_internal(&mut connection)
}

#[tauri::command]
pub fn create_note_tx(
    app: AppHandle,
    notebook_id: i64,
    folder_id: i64,
    title: String,
) -> Result<NoteRecord, String> {
    let mut connection = open_database_connection(&app)?;
    create_note_tx_internal(&mut connection, notebook_id, folder_id, &title)
}

#[tauri::command]
pub fn create_notebook_tx(app: AppHandle, name: String) -> Result<NotebookRecord, String> {
    let mut connection = open_database_connection(&app)?;
    create_notebook_tx_internal(&mut connection, &name)
}

#[tauri::command]
pub fn create_folder_tx(
    app: AppHandle,
    notebook_id: i64,
    name: String,
) -> Result<FolderRecord, String> {
    let mut connection = open_database_connection(&app)?;
    create_folder_tx_internal(&mut connection, notebook_id, &name)
}

#[tauri::command]
pub fn ensure_notebook_tree_constraints_tx(app: AppHandle) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    ensure_notebook_tree_constraints_tx_internal(&mut connection)
}

#[tauri::command]
pub fn reorder_notebooks_tx(
    app: AppHandle,
    ordered_notebook_ids: Vec<i64>,
) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    reorder_notebooks_tx_internal(&mut connection, &ordered_notebook_ids)
}

#[tauri::command]
pub fn reorder_folders_tx(
    app: AppHandle,
    notebook_id: i64,
    ordered_folder_ids: Vec<i64>,
) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    reorder_folders_tx_internal(&mut connection, notebook_id, &ordered_folder_ids)
}

#[tauri::command]
pub fn move_note_tx(
    app: AppHandle,
    note_id: i64,
    target_folder_id: i64,
    target_index: usize,
) -> Result<NoteRecord, String> {
    let mut connection = open_database_connection(&app)?;
    move_note_tx_internal(&mut connection, note_id, target_folder_id, target_index)
}

#[tauri::command]
pub fn ensure_review_feature_ready_tx(app: AppHandle) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    ensure_review_feature_ready_internal(&mut connection)
}

#[tauri::command]
pub fn activate_note_review_schedule_tx(
    app: AppHandle,
    note_id: i64,
) -> Result<NoteReviewScheduleRecord, String> {
    let mut connection = open_database_connection(&app)?;
    activate_note_review_schedule_tx_internal(&mut connection, note_id)
}

#[tauri::command]
pub fn save_note_review_schedule_tx(
    app: AppHandle,
    note_id: i64,
    dates: Vec<String>,
) -> Result<NoteReviewScheduleRecord, String> {
    let mut connection = open_database_connection(&app)?;
    save_note_review_schedule_tx_internal(&mut connection, note_id, &dates)
}

#[tauri::command]
pub fn clear_note_review_schedule_tx(app: AppHandle, note_id: i64) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    clear_note_review_schedule_tx_internal(&mut connection, note_id)
}

#[tauri::command]
pub fn set_note_review_schedule_dirty_tx(
    app: AppHandle,
    note_id: i64,
    is_dirty: bool,
) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    set_note_review_schedule_dirty_tx_internal(&mut connection, note_id, is_dirty)
}

#[tauri::command]
pub fn create_review_plan_tx(
    app: AppHandle,
    name: String,
    offsets: Vec<i64>,
) -> Result<ReviewPlanWithStepsRecord, String> {
    let mut connection = open_database_connection(&app)?;
    create_review_plan_tx_internal(&mut connection, &name, &offsets)
}

#[tauri::command]
pub fn rename_review_plan_tx(
    app: AppHandle,
    plan_id: i64,
    name: String,
) -> Result<ReviewPlanWithStepsRecord, String> {
    let mut connection = open_database_connection(&app)?;
    rename_review_plan_tx_internal(&mut connection, plan_id, &name)
}

#[tauri::command]
pub fn delete_review_plan_tx(app: AppHandle, plan_id: i64) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    delete_review_plan_tx_internal(&mut connection, plan_id)
}

#[tauri::command]
pub fn delete_notebook_tx(app: AppHandle, notebook_id: i64) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    let candidate_paths = collect_managed_resource_paths_for_notebook(&connection, notebook_id)?;
    delete_notebook_tx_internal(&mut connection, notebook_id)?;
    cleanup_unreferenced_managed_resources_best_effort(&app, &connection, &candidate_paths);
    Ok(())
}

#[tauri::command]
pub fn delete_folder_tx(app: AppHandle, folder_id: i64) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    let candidate_paths =
        collect_managed_resource_paths_for_folder_subtree(&connection, folder_id)?;
    delete_folder_tx_internal(&mut connection, folder_id)?;
    cleanup_unreferenced_managed_resources_best_effort(&app, &connection, &candidate_paths);
    Ok(())
}

#[tauri::command]
pub fn update_notebook_cover_image_tx(
    app: AppHandle,
    notebook_id: i64,
    cover_image_path: String,
) -> Result<NotebookRecord, String> {
    let mut connection = open_database_connection(&app)?;
    let previous_cover_path = fetch_notebook_cover_image_path(&connection, notebook_id)?;
    let notebook =
        update_notebook_cover_image_tx_internal(&mut connection, notebook_id, &cover_image_path)?;

    if let Some(previous_cover_path) = previous_cover_path {
        if notebook.cover_image_path.as_deref() != Some(previous_cover_path.as_str()) {
            cleanup_unreferenced_managed_resources_best_effort(
                &app,
                &connection,
                &[previous_cover_path],
            );
        }
    }

    Ok(notebook)
}

#[tauri::command]
pub fn clear_notebook_cover_image_tx(
    app: AppHandle,
    notebook_id: i64,
) -> Result<NotebookRecord, String> {
    let mut connection = open_database_connection(&app)?;
    let previous_cover_path = fetch_notebook_cover_image_path(&connection, notebook_id)?;
    let notebook = clear_notebook_cover_image_tx_internal(&mut connection, notebook_id)?;

    if let Some(previous_cover_path) = previous_cover_path {
        cleanup_unreferenced_managed_resources_best_effort(
            &app,
            &connection,
            &[previous_cover_path],
        );
    }

    Ok(notebook)
}

#[tauri::command]
pub fn rename_note_tx(app: AppHandle, note_id: i64, title: String) -> Result<NoteRecord, String> {
    let mut connection = open_database_connection(&app)?;
    rename_note_tx_internal(&mut connection, note_id, &title)
}

#[tauri::command]
pub fn update_note_content_tx(
    app: AppHandle,
    note_id: i64,
    content: String,
) -> Result<NoteRecord, String> {
    let mut connection = open_database_connection(&app)?;
    update_note_content_tx_internal(&mut connection, note_id, &content)
}

#[tauri::command]
pub fn delete_note_tx(app: AppHandle, note_id: i64) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    let candidate_paths = collect_managed_resource_paths_for_note(&connection, note_id)?;
    delete_note_tx_internal(&mut connection, note_id)?;
    cleanup_unreferenced_managed_resources_best_effort(&app, &connection, &candidate_paths);
    Ok(())
}

#[tauri::command]
pub fn cleanup_unreferenced_managed_resources(
    app: AppHandle,
) -> Result<ManagedResourceCleanupResult, String> {
    let connection = open_database_connection(&app)?;
    let root = resolve_app_root(&app)?;
    cleanup_unreferenced_managed_resources_internal(&root, &connection)
}

#[tauri::command]
pub fn add_tag_to_note_by_name_tx(
    app: AppHandle,
    note_id: i64,
    name: String,
) -> Result<Vec<TagRecord>, String> {
    let mut connection = open_database_connection(&app)?;
    add_tag_to_note_by_name_tx_internal(&mut connection, note_id, &name)
}

#[tauri::command]
pub fn remove_tag_from_note_tx(
    app: AppHandle,
    note_id: i64,
    tag_id: i64,
) -> Result<Vec<TagRecord>, String> {
    let mut connection = open_database_connection(&app)?;
    remove_tag_from_note_tx_internal(&mut connection, note_id, tag_id)
}

#[tauri::command]
pub fn bind_review_plan_to_note_tx(
    app: AppHandle,
    note_id: i64,
    plan_id: i64,
    start_date: String,
) -> Result<NoteReviewBindingDetailRecord, String> {
    let mut connection = open_database_connection(&app)?;
    bind_review_plan_to_note_tx_internal(&mut connection, note_id, plan_id, &start_date)
}

#[tauri::command]
pub fn remove_review_plan_binding_tx(app: AppHandle, note_id: i64) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    remove_review_plan_binding_tx_internal(&mut connection, note_id)
}

#[tauri::command]
pub fn set_review_task_completed_tx(
    app: AppHandle,
    task_id: i64,
    completed: bool,
) -> Result<ReviewTaskRecord, String> {
    let mut connection = open_database_connection(&app)?;
    set_review_task_completed_tx_internal(&mut connection, task_id, completed)
}

#[cfg(test)]
mod tests {
    use super::{
        add_days, add_tag_to_note_by_name_tx_internal, bind_review_plan_to_note_tx_internal,
        activate_note_review_schedule_tx_internal, clear_note_review_schedule_tx_internal,
        cleanup_candidate_unreferenced_managed_resources,
        cleanup_unreferenced_managed_resources_internal, clear_notebook_cover_image_tx_internal,
        collect_managed_resource_paths_for_folder_subtree, collect_managed_resource_paths_for_notebook,
        create_folder_tx_internal, create_note_tx_internal, create_notebook_tx_internal,
        create_review_plan_tx_internal,
        delete_folder_tx_internal, delete_note_tx_internal, delete_notebook_tx_internal,
        delete_review_plan_tx_internal,
        ensure_app_meta_table, ensure_note_search_ready_internal, ensure_note_search_table,
        ensure_notebook_tree_constraints_tx_internal,
        ensure_review_feature_ready_internal,
        extract_indexable_plain_text, extract_note_image_resource_paths, rebuild_note_search_index_internal,
        move_note_tx_internal,
        rename_review_plan_tx_internal, set_review_task_completed_tx_internal,
        reorder_folders_tx_internal, reorder_notebooks_tx_internal,
        save_note_review_schedule_tx_internal, set_note_review_schedule_dirty_tx_internal,
        today_local_date_key, update_notebook_cover_image_tx_internal,
        APP_META_KEY_REVIEW_FEATURE_REBUILD_V1_DONE, APP_META_KEY_REVIEW_SCHEDULE_DIRTY_NOTE_IDS,
        DEFAULT_REVIEW_PLAN_NAME,
    };
    use chrono::Local;
    use rusqlite::Connection;
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory sqlite");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        connection
            .execute_batch(
                "
                CREATE TABLE notebooks (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  name TEXT NOT NULL,
                  cover_image_path TEXT,
                  custom_sort_order INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE folders (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  notebook_id INTEGER NOT NULL,
                  parent_folder_id INTEGER,
                  name TEXT NOT NULL,
                  sort_order INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
                  FOREIGN KEY (parent_folder_id) REFERENCES folders(id) ON DELETE CASCADE
                );
                CREATE TABLE notes (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  notebook_id INTEGER NOT NULL,
                  folder_id INTEGER,
                  sort_order INTEGER NOT NULL DEFAULT 0,
                  title TEXT NOT NULL,
                  content_plaintext TEXT,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
                  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
                );
                CREATE TABLE review_plans (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE review_plan_steps (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  plan_id INTEGER NOT NULL,
                  step_index INTEGER NOT NULL,
                  offset_days INTEGER NOT NULL,
                  FOREIGN KEY (plan_id) REFERENCES review_plans(id) ON DELETE CASCADE
                );
                CREATE TABLE tags (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                  color TEXT NOT NULL,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE note_tags (
                  note_id INTEGER NOT NULL,
                  tag_id INTEGER NOT NULL,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (note_id, tag_id),
                  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
                  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
                );
                CREATE TABLE note_review_bindings (
                  note_id INTEGER PRIMARY KEY,
                  plan_id INTEGER NOT NULL,
                  start_date TEXT NOT NULL,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
                  FOREIGN KEY (plan_id) REFERENCES review_plans(id) ON DELETE CASCADE
                );
                CREATE TABLE review_tasks (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  note_id INTEGER NOT NULL,
                  plan_id INTEGER NOT NULL,
                  due_date TEXT NOT NULL,
                  step_index INTEGER NOT NULL,
                  is_completed INTEGER NOT NULL DEFAULT 0,
                  completed_at TEXT,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  UNIQUE(note_id, plan_id, step_index, due_date),
                  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
                  FOREIGN KEY (plan_id) REFERENCES review_plans(id) ON DELETE CASCADE
                );
                ",
            )
            .expect("create test schema");
        ensure_app_meta_table(&connection).expect("ensure app_meta");
        ensure_note_search_table(&connection).expect("ensure note_search");
        connection
    }

    fn ensure_test_resource_dirs(root: &Path) {
        fs::create_dir_all(root.join("resources/images")).expect("create images dir");
        fs::create_dir_all(root.join("resources/covers")).expect("create covers dir");
    }

    fn write_test_resource(root: &Path, resource_path: &str) {
        let absolute_path = root.join(resource_path);

        if let Some(parent_path) = absolute_path.parent() {
            fs::create_dir_all(parent_path).expect("create parent dir");
        }

        fs::write(absolute_path, b"resource").expect("write resource");
    }

    #[test]
    fn ensure_note_search_ready_marks_empty_database_initialized() {
        let mut connection = test_connection();
        ensure_note_search_ready_internal(&mut connection).expect("ensure note search ready");

        let meta: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'note_search_initialized'",
                [],
                |row| row.get(0),
            )
            .expect("read app meta");

        assert_eq!(meta, "1");
    }

    #[test]
    fn rebuild_note_search_index_rebuilds_existing_notes() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '标题一', '<p>正文一</p>')",
                [],
            )
            .expect("insert note");

        rebuild_note_search_index_internal(&mut connection).expect("rebuild note_search");

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM note_search", [], |row| row.get(0))
            .expect("count note_search");

        assert_eq!(count, 1);
    }

    #[test]
    fn extract_indexable_plain_text_keeps_math_source_and_decodes_entities() {
        let content =
            "<p>矩阵 <span data-note-math=\"inline\" data-latex=\"a &amp; b\">a &amp; b</span> 展开</p>";

        let extracted = extract_indexable_plain_text(content);

        assert!(extracted.contains("矩阵"));
        assert!(extracted.contains("a & b"));
        assert!(extracted.contains("展开"));
    }

    #[test]
    fn rebuild_note_search_index_indexes_math_source() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (?1, ?2, ?3, ?4)",
                (
                    1_i64,
                    1_i64,
                    "公式文件",
                    "<p>能量公式 <span data-note-math=\"inline\" data-latex=\"E=mc^3\">E=mc^3</span></p><div data-note-math=\"block\" data-latex=\"\\frac{a}{b}\">\\frac{a}{b}</div>",
                ),
            )
            .expect("insert note");

        rebuild_note_search_index_internal(&mut connection).expect("rebuild note_search");

        let body_plaintext: String = connection
            .query_row(
                "SELECT body_plaintext FROM note_search WHERE rowid = 1",
                [],
                |row| row.get(0),
            )
            .expect("read note_search body_plaintext");

        assert!(body_plaintext.contains("E=mc^3"));
        assert!(body_plaintext.contains("\\frac{a}{b}"));
    }

    #[test]
    fn extract_indexable_plain_text_keeps_note_image_alt_text() {
        let content = "<p>图示如下</p><img data-note-image=\"true\" data-resource-path=\"resources/images/demo.png\" alt=\"流程图 A\" />";

        let extracted = extract_indexable_plain_text(content);

        assert!(extracted.contains("图示如下"));
        assert!(extracted.contains("流程图 A"));
    }

    #[test]
    fn extract_note_image_resource_paths_keeps_valid_paths_only_once() {
        let content = concat!(
            "<p>正文</p>",
            "<img data-note-image=\"true\" data-resource-path=\"resources/images/demo-a.png\" alt=\"A\" />",
            "<img data-note-image=\"true\" data-resource-path=\" resources/images/demo-a.png \" alt=\"A 副本\" />",
            "<img data-note-image=\"true\" data-resource-path=\"../escape.png\" alt=\"非法\" />",
            "<img data-note-image=\"true\" alt=\"缺路径\" />",
        );

        let paths = extract_note_image_resource_paths(content);

        assert_eq!(paths, vec!["resources/images/demo-a.png".to_string()]);
    }

    #[test]
    fn rebuild_note_search_index_accepts_image_only_note_content() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (?1, ?2, ?3, ?4)",
                (
                    1_i64,
                    1_i64,
                    "图片文件",
                    "<img data-note-image=\"true\" data-resource-path=\"resources/images/demo.png\" alt=\"示意图\" />",
                ),
            )
            .expect("insert note");

        rebuild_note_search_index_internal(&mut connection).expect("rebuild note_search");

        let body_plaintext: String = connection
            .query_row(
                "SELECT body_plaintext FROM note_search WHERE rowid = 1",
                [],
                |row| row.get(0),
            )
            .expect("read note_search body_plaintext");

        assert!(body_plaintext.contains("示意图"));
    }

    #[test]
    fn collect_managed_resource_paths_for_notebook_includes_cover_and_note_images() {
        let connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, cover_image_path) VALUES ('测试本', 'resources/covers/cover-a.png')",
                [],
            )
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (?1, ?2, ?3, ?4)",
                (
                    1_i64,
                    1_i64,
                    "图片文件",
                    "<p>示意图</p><img data-note-image=\"true\" data-resource-path=\"resources/images/demo-a.png\" alt=\"A\" />",
                ),
            )
            .expect("insert note");

        let paths =
            collect_managed_resource_paths_for_notebook(&connection, 1).expect("collect paths");

        assert_eq!(
            paths,
            vec![
                "resources/covers/cover-a.png".to_string(),
                "resources/images/demo-a.png".to_string(),
            ]
        );
    }

    #[test]
    fn cleanup_candidate_unreferenced_managed_resources_only_removes_orphans() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());

        for resource_path in [
            "resources/images/shared.png",
            "resources/images/orphan.png",
            "resources/covers/live-cover.png",
            "resources/covers/orphan-cover.png",
        ] {
            write_test_resource(temp_dir.path(), resource_path);
        }

        let connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, cover_image_path) VALUES ('测试本', 'resources/covers/live-cover.png')",
                [],
            )
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (?1, ?2, ?3, ?4)",
                (
                    1_i64,
                    1_i64,
                    "共享图片文件",
                    "<img data-note-image=\"true\" data-resource-path=\"resources/images/shared.png\" alt=\"共享图\" />",
                ),
            )
            .expect("insert note");

        let result = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &[
                "resources/images/shared.png".to_string(),
                "resources/images/orphan.png".to_string(),
                "resources/covers/live-cover.png".to_string(),
                "resources/covers/orphan-cover.png".to_string(),
            ],
        )
        .expect("delete orphan resources");

        assert_eq!(result.deleted_count, 2);
        assert!(result.failed.is_empty());
        assert!(temp_dir.path().join("resources/images/shared.png").is_file());
        assert!(!temp_dir.path().join("resources/images/orphan.png").exists());
        assert!(temp_dir.path().join("resources/covers/live-cover.png").is_file());
        assert!(!temp_dir.path().join("resources/covers/orphan-cover.png").exists());
    }

    #[test]
    fn cleanup_candidate_unreferenced_managed_resources_ignores_invalid_paths() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());
        write_test_resource(temp_dir.path(), "resources/images/kept.png");
        let connection = test_connection();

        let result = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &["../outside.png".to_string(), "resources/./images/kept.png".to_string()],
        )
        .expect("cleanup candidate resources");

        assert_eq!(result.deleted_count, 0);
        assert!(result.failed.is_empty());
        assert!(temp_dir.path().join("resources/images/kept.png").is_file());
    }

    #[test]
    fn cleanup_unreferenced_managed_resources_internal_deletes_disk_orphans() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());
        write_test_resource(temp_dir.path(), "resources/images/referenced.png");
        write_test_resource(temp_dir.path(), "resources/images/orphan.png");
        write_test_resource(temp_dir.path(), "resources/covers/live-cover.png");
        write_test_resource(temp_dir.path(), "resources/covers/orphan-cover.png");

        let connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, cover_image_path) VALUES ('测试本', 'resources/covers/live-cover.png')",
                [],
            )
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', '<img data-note-image=\"true\" data-resource-path=\"resources/images/referenced.png\" alt=\"示意图\" />')",
                [],
            )
            .expect("insert note");

        let result = cleanup_unreferenced_managed_resources_internal(temp_dir.path(), &connection)
            .expect("cleanup unreferenced managed resources");

        assert_eq!(result.deleted_count, 2);
        assert!(result.failed.is_empty());
        assert!(temp_dir.path().join("resources/images/referenced.png").is_file());
        assert!(!temp_dir.path().join("resources/images/orphan.png").exists());
        assert!(temp_dir.path().join("resources/covers/live-cover.png").is_file());
        assert!(!temp_dir.path().join("resources/covers/orphan-cover.png").exists());
    }

    #[test]
    fn create_review_plan_path_can_commit_three_times() {
        let mut connection = test_connection();

        for (name, offsets) in [
            ("方案一", vec![0_i64, 3]),
            ("方案二", vec![1_i64, 4]),
            ("方案三", vec![2_i64, 7]),
        ] {
            let plan = create_review_plan_tx_internal(&mut connection, name, &offsets)
                .expect("create plan");
            assert_eq!(plan.steps.len(), offsets.len());
        }
    }

    #[test]
    fn create_note_path_can_commit_three_times() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");

        for title in ["文件一", "文件二", "文件三"] {
            let note = create_note_tx_internal(&mut connection, 1, 1, title).expect("create note");
            assert_eq!(note.title, title);
            assert_eq!(note.sort_order, 0);
        }

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .expect("count notes");
        assert_eq!(count, 3);

        let ordered_titles = connection
            .prepare(
                "SELECT title FROM notes WHERE folder_id = 1 ORDER BY sort_order ASC, id ASC",
            )
            .expect("prepare ordered notes")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query ordered notes")
            .map(|row| row.expect("map ordered note"))
            .collect::<Vec<_>>();

        assert_eq!(ordered_titles, vec!["文件三", "文件二", "文件一"]);
    }

    #[test]
    fn create_notebook_path_appends_to_custom_order_tail() {
        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, custom_sort_order) VALUES ('测试本 A', 0), ('测试本 B', 1)",
                [],
            )
            .expect("insert notebooks");

        let notebook =
            create_notebook_tx_internal(&mut connection, "测试本 C").expect("create notebook");

        assert_eq!(notebook.name, "测试本 C");
        assert_eq!(notebook.custom_sort_order, 2);
    }

    #[test]
    fn reorder_notebooks_path_persists_custom_order() {
        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, custom_sort_order) VALUES ('测试本 A', 0), ('测试本 B', 1), ('测试本 C', 2)",
                [],
            )
            .expect("insert notebooks");

        reorder_notebooks_tx_internal(&mut connection, &[3, 1, 2])
            .expect("reorder notebooks");

        let ordered_ids = connection
            .prepare("SELECT id FROM notebooks ORDER BY custom_sort_order ASC, id ASC")
            .expect("prepare ordered notebooks")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("query ordered notebooks")
            .map(|row| row.expect("map ordered notebook"))
            .collect::<Vec<_>>();

        assert_eq!(ordered_ids, vec![3, 1, 2]);
    }

    #[test]
    fn create_note_path_reports_missing_folder() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");

        let error = create_note_tx_internal(&mut connection, 1, 999, "新文件")
            .expect_err("missing folder should fail");

        assert_eq!(error, "目标文件夹不存在。");
    }

    #[test]
    fn create_note_path_reports_folder_notebook_mismatch() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本 A')", [])
            .expect("insert notebook a");
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本 B')", [])
            .expect("insert notebook b");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (2, 'B 的文件夹', 0)",
                [],
            )
            .expect("insert folder for notebook b");

        let error = create_note_tx_internal(&mut connection, 1, 1, "新文件")
            .expect_err("folder notebook mismatch should fail");

        assert_eq!(error, "目标文件夹不属于当前笔记本。");
    }

    #[test]
    fn delete_folder_path_deletes_notes_in_folder_subtree_and_search_entries() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, parent_folder_id, name, sort_order) VALUES (1, NULL, '根文件夹', 0)",
                [],
            )
            .expect("insert root folder");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, parent_folder_id, name, sort_order) VALUES (1, 1, '子文件夹', 0)",
                [],
            )
            .expect("insert child folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '根文件', '<p>根正文</p>')",
                [],
            )
            .expect("insert root note");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 2, '子文件', '<p>子正文</p>')",
                [],
            )
            .expect("insert child note");
        rebuild_note_search_index_internal(&mut connection).expect("rebuild note_search");

        delete_folder_tx_internal(&mut connection, 1).expect("delete folder subtree");

        let note_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .expect("count notes");
        let note_search_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM note_search", [], |row| row.get(0))
            .expect("count note_search");
        let folder_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM folders", [], |row| row.get(0))
            .expect("count folders");

        assert_eq!(note_count, 0);
        assert_eq!(note_search_count, 0);
        assert_eq!(folder_count, 0);
    }

    #[test]
    fn delete_folder_cleanup_removes_unique_resources_and_keeps_shared_resources() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());
        write_test_resource(temp_dir.path(), "resources/images/folder-unique.png");
        write_test_resource(temp_dir.path(), "resources/images/shared.png");

        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, parent_folder_id, name, sort_order) VALUES (1, NULL, '根文件夹', 0)",
                [],
            )
            .expect("insert root folder");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '保留文件夹', 1)",
                [],
            )
            .expect("insert keep folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '待删文件', '<img data-note-image=\"true\" data-resource-path=\"resources/images/folder-unique.png\" alt=\"独占图\" /><img data-note-image=\"true\" data-resource-path=\"resources/images/shared.png\" alt=\"共享图\" />')",
                [],
            )
            .expect("insert folder note");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 2, '保留文件', '<img data-note-image=\"true\" data-resource-path=\"resources/images/shared.png\" alt=\"共享图\" />')",
                [],
            )
            .expect("insert keep note");

        let candidate_paths = collect_managed_resource_paths_for_folder_subtree(&connection, 1)
            .expect("collect folder subtree resource paths");
        delete_folder_tx_internal(&mut connection, 1).expect("delete folder subtree");
        let result = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &candidate_paths,
        )
        .expect("cleanup deleted folder resources");

        assert_eq!(result.deleted_count, 1);
        assert!(result.failed.is_empty());
        assert!(!temp_dir.path().join("resources/images/folder-unique.png").exists());
        assert!(temp_dir.path().join("resources/images/shared.png").is_file());
    }

    #[test]
    fn delete_folder_path_reports_missing_folder() {
        let mut connection = test_connection();

        let error = delete_folder_tx_internal(&mut connection, 999)
            .expect_err("missing folder should fail");

        assert_eq!(error, "目标文件夹不存在。");
    }

    #[test]
    fn delete_note_cleanup_deletes_unique_note_image() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());
        write_test_resource(temp_dir.path(), "resources/images/note-only.png");

        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', '<img data-note-image=\"true\" data-resource-path=\"resources/images/note-only.png\" alt=\"独占图\" />')",
                [],
            )
            .expect("insert note");

        delete_note_tx_internal(&mut connection, 1).expect("delete note");
        let result = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &["resources/images/note-only.png".to_string()],
        )
        .expect("cleanup deleted note resource");

        assert_eq!(result.deleted_count, 1);
        assert!(result.failed.is_empty());
        assert!(!temp_dir.path().join("resources/images/note-only.png").exists());
    }

    #[test]
    fn delete_note_cleanup_keeps_resource_when_another_note_still_references_it() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());
        write_test_resource(temp_dir.path(), "resources/images/shared-note.png");

        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', '<img data-note-image=\"true\" data-resource-path=\"resources/images/shared-note.png\" alt=\"共享图\" />')",
                [],
            )
            .expect("insert first note");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件二', '<img data-note-image=\"true\" data-resource-path=\"resources/images/shared-note.png\" alt=\"共享图\" />')",
                [],
            )
            .expect("insert second note");

        delete_note_tx_internal(&mut connection, 1).expect("delete first note");
        let result = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &["resources/images/shared-note.png".to_string()],
        )
        .expect("cleanup shared note resource");

        assert_eq!(result.deleted_count, 0);
        assert!(result.failed.is_empty());
        assert!(temp_dir.path().join("resources/images/shared-note.png").is_file());
    }

    #[test]
    fn create_folder_path_can_commit_three_times_with_stable_sort_order() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");

        for name in ["文件夹一", "文件夹二", "文件夹三"] {
            let folder =
                create_folder_tx_internal(&mut connection, 1, name).expect("create folder");
            assert_eq!(folder.name, name);
            assert_eq!(folder.sort_order, 0);
            assert_eq!(folder.parent_folder_id, None);
        }

        let ordered_folder_names = connection
            .prepare(
                "SELECT name FROM folders WHERE notebook_id = 1 ORDER BY sort_order ASC, id ASC",
            )
            .expect("prepare ordered folders")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query ordered folders")
            .map(|row| row.expect("map ordered folder"))
            .collect::<Vec<_>>();

        assert_eq!(ordered_folder_names, vec!["文件夹三", "文件夹二", "文件夹一"]);
    }

    #[test]
    fn create_folder_path_reports_missing_notebook() {
        let mut connection = test_connection();

        let error = create_folder_tx_internal(&mut connection, 999, "新文件夹")
            .expect_err("missing notebook should fail");

        assert_eq!(error, "目标笔记本不存在。");
    }

    #[test]
    fn reorder_folders_path_persists_top_level_order() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '文件夹一', 0), (1, '文件夹二', 1), (1, '文件夹三', 2)",
                [],
            )
            .expect("insert folders");

        reorder_folders_tx_internal(&mut connection, 1, &[3, 1, 2])
            .expect("reorder folders");

        let ordered_ids = connection
            .prepare(
                "SELECT id FROM folders WHERE notebook_id = 1 ORDER BY sort_order ASC, id ASC",
            )
            .expect("prepare ordered folders")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("query ordered folders")
            .map(|row| row.expect("map ordered folder"))
            .collect::<Vec<_>>();

        assert_eq!(ordered_ids, vec![3, 1, 2]);
    }

    #[test]
    fn move_note_path_can_reorder_within_same_folder() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, sort_order, title, content_plaintext) VALUES (1, 1, 0, '文件一', NULL), (1, 1, 1, '文件二', NULL), (1, 1, 2, '文件三', NULL)",
                [],
            )
            .expect("insert notes");

        let moved_note = move_note_tx_internal(&mut connection, 3, 1, 0).expect("move note");
        assert_eq!(moved_note.folder_id, Some(1));
        assert_eq!(moved_note.sort_order, 0);

        let ordered_ids = connection
            .prepare("SELECT id FROM notes WHERE folder_id = 1 ORDER BY sort_order ASC, id ASC")
            .expect("prepare ordered notes")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("query ordered notes")
            .map(|row| row.expect("map ordered note"))
            .collect::<Vec<_>>();

        assert_eq!(ordered_ids, vec![3, 1, 2]);
    }

    #[test]
    fn move_note_path_can_move_between_folders() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '文件夹 A', 0), (1, '文件夹 B', 1)",
                [],
            )
            .expect("insert folders");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, sort_order, title, content_plaintext) VALUES (1, 1, 0, '文件一', NULL), (1, 1, 1, '文件二', NULL), (1, 2, 0, '文件三', NULL)",
                [],
            )
            .expect("insert notes");

        let moved_note = move_note_tx_internal(&mut connection, 2, 2, 1).expect("move note");
        assert_eq!(moved_note.folder_id, Some(2));
        assert_eq!(moved_note.sort_order, 1);

        let folder_a_ids = connection
            .prepare("SELECT id FROM notes WHERE folder_id = 1 ORDER BY sort_order ASC, id ASC")
            .expect("prepare folder a notes")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("query folder a notes")
            .map(|row| row.expect("map folder a note"))
            .collect::<Vec<_>>();
        let folder_b_ids = connection
            .prepare("SELECT id FROM notes WHERE folder_id = 2 ORDER BY sort_order ASC, id ASC")
            .expect("prepare folder b notes")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("query folder b notes")
            .map(|row| row.expect("map folder b note"))
            .collect::<Vec<_>>();

        assert_eq!(folder_a_ids, vec![1]);
        assert_eq!(folder_b_ids, vec![3, 2]);
    }

    #[test]
    fn move_note_path_can_move_into_empty_folder() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '文件夹 A', 0), (1, '空文件夹', 1)",
                [],
            )
            .expect("insert folders");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, sort_order, title, content_plaintext) VALUES (1, 1, 0, '文件一', NULL), (1, 1, 1, '文件二', NULL)",
                [],
            )
            .expect("insert notes");

        let moved_note = move_note_tx_internal(&mut connection, 2, 2, 0).expect("move note");
        assert_eq!(moved_note.folder_id, Some(2));
        assert_eq!(moved_note.sort_order, 0);

        let folder_a_rows = connection
            .prepare("SELECT id, sort_order FROM notes WHERE folder_id = 1 ORDER BY sort_order ASC, id ASC")
            .expect("prepare folder a notes")
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .expect("query folder a notes")
            .map(|row| row.expect("map folder a note"))
            .collect::<Vec<_>>();
        let folder_b_rows = connection
            .prepare("SELECT id, sort_order FROM notes WHERE folder_id = 2 ORDER BY sort_order ASC, id ASC")
            .expect("prepare folder b notes")
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .expect("query folder b notes")
            .map(|row| row.expect("map folder b note"))
            .collect::<Vec<_>>();

        assert_eq!(folder_a_rows, vec![(1, 0)]);
        assert_eq!(folder_b_rows, vec![(2, 0)]);
    }

    #[test]
    fn ensure_notebook_tree_constraints_path_flattens_legacy_structure() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name, custom_sort_order) VALUES ('测试本', 0)", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, parent_folder_id, name, sort_order) VALUES (1, NULL, '根文件夹', 0)",
                [],
            )
            .expect("insert root folder");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, parent_folder_id, name, sort_order) VALUES (1, 1, '子文件夹', 0)",
                [],
            )
            .expect("insert child folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, sort_order, title, content_plaintext) VALUES (1, 2, 0, '子文件', NULL), (1, NULL, 0, '未归档文件', NULL)",
                [],
            )
            .expect("insert legacy notes");

        ensure_notebook_tree_constraints_tx_internal(&mut connection)
            .expect("repair notebook tree");

        let folder_rows = connection
            .prepare(
                "SELECT name, parent_folder_id, sort_order FROM folders WHERE notebook_id = 1 ORDER BY sort_order ASC, id ASC",
            )
            .expect("prepare folder rows")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .expect("query folder rows")
            .map(|row| row.expect("map folder row"))
            .collect::<Vec<_>>();

        assert_eq!(
            folder_rows,
            vec![
                ("根文件夹".to_string(), None, 0),
                ("子文件夹".to_string(), None, 1),
                ("未归档迁移".to_string(), None, 2),
            ]
        );

        let orphan_note_row: (Option<i64>, i64) = connection
            .query_row(
                "SELECT folder_id, sort_order FROM notes WHERE title = '未归档文件'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read repaired note");
        let child_note_row: (Option<i64>, i64) = connection
            .query_row(
                "SELECT folder_id, sort_order FROM notes WHERE title = '子文件'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read child note");

        assert_eq!(orphan_note_row, (Some(3), 0));
        assert_eq!(child_note_row, (Some(2), 0));
    }

    #[test]
    fn ensure_review_feature_ready_resets_existing_review_data_to_default() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert first note");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件二', NULL)",
                [],
            )
            .expect("insert second note");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件三', NULL)",
                [],
            )
            .expect("insert third note");
        create_review_plan_tx_internal(&mut connection, "方案一", &[0, 3]).expect("create plan 1");
        create_review_plan_tx_internal(&mut connection, "方案二", &[1, 4]).expect("create plan 2");
        bind_review_plan_to_note_tx_internal(&mut connection, 1, 1, "2026-04-07")
            .expect("bind first note");
        bind_review_plan_to_note_tx_internal(&mut connection, 2, 2, "2026-04-10")
            .expect("bind second note");

        let today = today_local_date_key();
        ensure_review_feature_ready_internal(&mut connection).expect("ensure review feature ready");

        let plan_name: String = connection
            .query_row("SELECT name FROM review_plans LIMIT 1", [], |row| row.get(0))
            .expect("read default plan name");
        let plan_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM review_plans", [], |row| row.get(0))
            .expect("count review plans");
        let done_marker: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = ?1",
                [APP_META_KEY_REVIEW_FEATURE_REBUILD_V1_DONE],
                |row| row.get(0),
            )
            .expect("read rebuild marker");
        let dirty_marker: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = ?1",
                [APP_META_KEY_REVIEW_SCHEDULE_DIRTY_NOTE_IDS],
                |row| row.get(0),
            )
            .expect("read dirty marker");
        let note_one_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM review_tasks WHERE note_id = 1",
                [],
                |row| row.get(0),
            )
            .expect("count note one tasks");
        let note_two_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM review_tasks WHERE note_id = 2",
                [],
                |row| row.get(0),
            )
            .expect("count note two tasks");
        let note_three_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM review_tasks WHERE note_id = 3",
                [],
                |row| row.get(0),
            )
            .expect("count note three tasks");

        assert_eq!(plan_name, DEFAULT_REVIEW_PLAN_NAME);
        assert_eq!(plan_count, 1);
        assert_eq!(done_marker, "1");
        assert_eq!(dirty_marker, "[]");
        assert_eq!(note_one_count, 4);
        assert_eq!(note_two_count, 4);
        assert_eq!(note_three_count, 0);

        let note_one_dates: Vec<String> = connection
            .prepare(
                "SELECT due_date FROM review_tasks WHERE note_id = 1 ORDER BY step_index ASC, id ASC",
            )
            .expect("prepare note one dates")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query note one dates")
            .map(|row| row.expect("map note one date"))
            .collect();

        assert_eq!(
            note_one_dates,
            vec![
                add_days(&today, 2).expect("day 2"),
                add_days(&today, 5).expect("day 5"),
                add_days(&today, 10).expect("day 10"),
                add_days(&today, 18).expect("day 18"),
            ]
        );
    }

    #[test]
    fn activate_note_review_schedule_generates_default_dates() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");

        let today = today_local_date_key();
        let schedule =
            activate_note_review_schedule_tx_internal(&mut connection, 1).expect("activate schedule");

        assert_eq!(schedule.note_id, 1);
        assert_eq!(schedule.activated_at.as_deref(), Some(today.as_str()));
        assert_eq!(
            schedule.dates,
            vec![
                add_days(&today, 2).expect("day 2"),
                add_days(&today, 5).expect("day 5"),
                add_days(&today, 10).expect("day 10"),
                add_days(&today, 18).expect("day 18"),
            ]
        );
    }

    #[test]
    fn save_note_review_schedule_rejects_past_duplicate_and_invalid_dates() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");
        activate_note_review_schedule_tx_internal(&mut connection, 1).expect("activate schedule");

        let past_date = Local::now()
            .date_naive()
            .checked_sub_days(chrono::Days::new(1))
            .expect("yesterday")
            .format("%Y-%m-%d")
            .to_string();
        let past_error = save_note_review_schedule_tx_internal(
            &mut connection,
            1,
            &[past_date],
        )
        .expect_err("past date should fail");
        let duplicate_error = save_note_review_schedule_tx_internal(
            &mut connection,
            1,
            &["2099-04-20".to_string(), "2099-04-20".to_string()],
        )
        .expect_err("duplicate date should fail");
        let invalid_error = save_note_review_schedule_tx_internal(
            &mut connection,
            1,
            &["2026-02-31".to_string()],
        )
        .expect_err("invalid date should fail");

        assert_eq!(past_error, "复习日期不能早于今天。");
        assert_eq!(duplicate_error, "同一文件内的复习日期不能重复。");
        assert_eq!(invalid_error, "复习日期无效。");
    }

    #[test]
    fn save_note_review_schedule_sorts_dates_and_keeps_activation_date() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");
        let activated =
            activate_note_review_schedule_tx_internal(&mut connection, 1).expect("activate schedule");

        let schedule = save_note_review_schedule_tx_internal(
            &mut connection,
            1,
            &[
                "2099-12-10".to_string(),
                "2099-01-01".to_string(),
                "2099-03-07".to_string(),
            ],
        )
        .expect("save reordered schedule");

        assert_eq!(
            schedule.dates,
            vec![
                "2099-01-01".to_string(),
                "2099-03-07".to_string(),
                "2099-12-10".to_string(),
            ]
        );
        assert_eq!(schedule.activated_at, activated.activated_at);
    }

    #[test]
    fn save_note_review_schedule_accepts_reduced_non_empty_dates() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");
        activate_note_review_schedule_tx_internal(&mut connection, 1).expect("activate schedule");

        let schedule = save_note_review_schedule_tx_internal(
            &mut connection,
            1,
            &["2099-02-18".to_string(), "2099-06-03".to_string()],
        )
        .expect("save reduced schedule");

        let task_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM review_tasks WHERE note_id = 1", [], |row| {
                row.get(0)
            })
            .expect("count tasks");

        assert_eq!(
            schedule.dates,
            vec!["2099-02-18".to_string(), "2099-06-03".to_string()]
        );
        assert_eq!(task_count, 2);
    }

    #[test]
    fn clear_note_review_schedule_removes_binding_and_tasks() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");
        activate_note_review_schedule_tx_internal(&mut connection, 1).expect("activate schedule");
        set_note_review_schedule_dirty_tx_internal(&mut connection, 1, true)
            .expect("mark dirty schedule");

        clear_note_review_schedule_tx_internal(&mut connection, 1).expect("clear schedule");

        let binding_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM note_review_bindings", [], |row| row.get(0))
            .expect("count bindings");
        let task_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM review_tasks", [], |row| row.get(0))
            .expect("count tasks");
        let dirty_marker: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = ?1",
                [APP_META_KEY_REVIEW_SCHEDULE_DIRTY_NOTE_IDS],
                |row| row.get(0),
            )
            .expect("read dirty marker");

        assert_eq!(binding_count, 0);
        assert_eq!(task_count, 0);
        assert_eq!(dirty_marker, "[]");
    }

    #[test]
    fn ensure_review_feature_ready_resets_dirty_notes_to_default_schedule() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");
        activate_note_review_schedule_tx_internal(&mut connection, 1).expect("activate schedule");
        save_note_review_schedule_tx_internal(
            &mut connection,
            1,
            &["2099-08-01".to_string(), "2099-08-09".to_string()],
        )
        .expect("save custom schedule");
        set_note_review_schedule_dirty_tx_internal(&mut connection, 1, true)
            .expect("mark dirty schedule");

        let today = today_local_date_key();
        ensure_review_feature_ready_internal(&mut connection).expect("ensure review feature ready");

        let due_dates: Vec<String> = connection
            .prepare(
                "SELECT due_date FROM review_tasks WHERE note_id = 1 ORDER BY step_index ASC, id ASC",
            )
            .expect("prepare tasks")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query tasks")
            .map(|row| row.expect("map task"))
            .collect();
        let dirty_marker: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = ?1",
                [APP_META_KEY_REVIEW_SCHEDULE_DIRTY_NOTE_IDS],
                |row| row.get(0),
            )
            .expect("read dirty marker");

        assert_eq!(
            due_dates,
            vec![
                add_days(&today, 2).expect("day 2"),
                add_days(&today, 5).expect("day 5"),
                add_days(&today, 10).expect("day 10"),
                add_days(&today, 18).expect("day 18"),
            ]
        );
        assert_eq!(dirty_marker, "[]");
    }

    #[test]
    fn review_rows_cascade_when_note_folder_and_notebook_are_deleted() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本一')", [])
            .expect("insert first notebook");
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本二')", [])
            .expect("insert second notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '文件夹一', 0)",
                [],
            )
            .expect("insert first folder");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (2, '文件夹二', 0)",
                [],
            )
            .expect("insert second folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert first note");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (2, 2, '文件二', NULL)",
                [],
            )
            .expect("insert second note");
        activate_note_review_schedule_tx_internal(&mut connection, 1).expect("activate first note");
        activate_note_review_schedule_tx_internal(&mut connection, 2).expect("activate second note");

        delete_note_tx_internal(&mut connection, 1).expect("delete first note");
        let after_note_delete: i64 = connection
            .query_row("SELECT COUNT(*) FROM review_tasks WHERE note_id = 1", [], |row| row.get(0))
            .expect("count first note review rows");
        assert_eq!(after_note_delete, 0);

        delete_folder_tx_internal(&mut connection, 2).expect("delete folder");
        let after_folder_delete: i64 = connection
            .query_row("SELECT COUNT(*) FROM review_tasks WHERE note_id = 2", [], |row| row.get(0))
            .expect("count second note review rows");
        assert_eq!(after_folder_delete, 0);

        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '文件夹三', 1)",
                [],
            )
            .expect("insert third folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 3, '文件三', NULL)",
                [],
            )
            .expect("insert third note");
        activate_note_review_schedule_tx_internal(&mut connection, 3).expect("activate third note");

        delete_notebook_tx_internal(&mut connection, 1).expect("delete notebook");
        let remaining_review_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM review_tasks", [], |row| row.get(0))
            .expect("count remaining review rows");
        assert_eq!(remaining_review_rows, 0);
    }

    #[test]
    fn bind_review_plan_path_is_idempotent_for_same_plan_and_date() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");
        create_review_plan_tx_internal(&mut connection, "方案一", &[0, 3]).expect("create plan");

        let first = bind_review_plan_to_note_tx_internal(&mut connection, 1, 1, "2026-04-07")
            .expect("bind review plan");
        let second = bind_review_plan_to_note_tx_internal(&mut connection, 1, 1, "2026-04-07")
            .expect("bind review plan again");

        let task_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM review_tasks", [], |row| row.get(0))
            .expect("count review tasks");

        assert_eq!(first.binding.plan_id, 1);
        assert_eq!(second.binding.plan_id, 1);
        assert_eq!(task_count, 2);
    }

    #[test]
    fn add_tag_to_note_path_does_not_duplicate_relation() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");

        let first = add_tag_to_note_by_name_tx_internal(&mut connection, 1, "重点")
            .expect("add tag first time");
        let second = add_tag_to_note_by_name_tx_internal(&mut connection, 1, "重点")
            .expect("add tag second time");

        let relation_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM note_tags", [], |row| row.get(0))
            .expect("count note_tags");

        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(relation_count, 1);
    }

    #[test]
    fn add_tag_to_note_path_rejects_empty_name() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");

        let error = add_tag_to_note_by_name_tx_internal(&mut connection, 1, "")
            .expect_err("empty tag name should fail");

        assert_eq!(error, "标签名称不能为空。");
    }

    #[test]
    fn add_tag_to_note_path_rejects_whitespace_only_name() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");

        let error = add_tag_to_note_by_name_tx_internal(&mut connection, 1, "   \t\n  ")
            .expect_err("whitespace-only tag name should fail");

        assert_eq!(error, "标签名称不能为空。");
    }

    #[test]
    fn add_tag_to_note_path_trims_and_normalizes_name_before_insert() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");

        let tags = add_tag_to_note_by_name_tx_internal(&mut connection, 1, "  重点\t标签  ")
            .expect("add normalized tag");
        let stored_name: String = connection
            .query_row("SELECT name FROM tags WHERE id = 1", [], |row| row.get(0))
            .expect("read stored tag name");

        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "重点 标签");
        assert_eq!(stored_name, "重点 标签");
    }

    #[test]
    fn rename_review_plan_path_can_commit_three_times() {
        let mut connection = test_connection();
        create_review_plan_tx_internal(&mut connection, "方案一", &[0, 3]).expect("create plan");

        for next_name in ["方案一-改", "方案一-再改", "方案一-最终"] {
            let updated =
                rename_review_plan_tx_internal(&mut connection, 1, next_name).expect("rename plan");
            assert_eq!(updated.name, next_name);
            assert_eq!(updated.steps.len(), 2);
        }
    }

    #[test]
    fn delete_review_plan_path_cascades_related_rows() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");
        create_review_plan_tx_internal(&mut connection, "方案一", &[0, 3]).expect("create plan");
        bind_review_plan_to_note_tx_internal(&mut connection, 1, 1, "2026-04-07")
            .expect("bind review plan");

        delete_review_plan_tx_internal(&mut connection, 1).expect("delete review plan");

        let step_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM review_plan_steps", [], |row| {
                row.get(0)
            })
            .expect("count review plan steps");
        let binding_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM note_review_bindings", [], |row| {
                row.get(0)
            })
            .expect("count note review bindings");
        let task_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM review_tasks", [], |row| row.get(0))
            .expect("count review tasks");
        let repeated_delete = delete_review_plan_tx_internal(&mut connection, 1)
            .expect_err("delete missing review plan should fail");

        assert_eq!(step_count, 0);
        assert_eq!(binding_count, 0);
        assert_eq!(task_count, 0);
        assert_eq!(repeated_delete, "目标复习方案不存在。");
    }

    #[test]
    fn update_notebook_cover_image_path_updates_cover_and_returns_notebook() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");

        let notebook = update_notebook_cover_image_tx_internal(
            &mut connection,
            1,
            "resources/covers/cover-a.png",
        )
        .expect("update notebook cover");

        let stored_cover_path: Option<String> = connection
            .query_row(
                "SELECT cover_image_path FROM notebooks WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("read notebook cover");

        assert_eq!(notebook.id, 1);
        assert_eq!(
            notebook.cover_image_path.as_deref(),
            Some("resources/covers/cover-a.png")
        );
        assert_eq!(
            stored_cover_path.as_deref(),
            Some("resources/covers/cover-a.png")
        );
    }

    #[test]
    fn cleanup_after_cover_update_deletes_old_cover_when_unreferenced() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());
        write_test_resource(temp_dir.path(), "resources/covers/cover-a.png");
        write_test_resource(temp_dir.path(), "resources/covers/cover-b.png");

        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, cover_image_path) VALUES ('测试本', 'resources/covers/cover-a.png')",
                [],
            )
            .expect("insert notebook");

        update_notebook_cover_image_tx_internal(&mut connection, 1, "resources/covers/cover-b.png")
            .expect("update cover");
        let result = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &["resources/covers/cover-a.png".to_string()],
        )
        .expect("cleanup old cover");

        assert_eq!(result.deleted_count, 1);
        assert!(result.failed.is_empty());
        assert!(!temp_dir.path().join("resources/covers/cover-a.png").exists());
        assert!(temp_dir.path().join("resources/covers/cover-b.png").is_file());
    }

    #[test]
    fn cleanup_after_cover_update_keeps_old_cover_when_note_still_references_it() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());
        write_test_resource(temp_dir.path(), "resources/covers/shared-cover.png");
        write_test_resource(temp_dir.path(), "resources/covers/cover-b.png");

        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, cover_image_path) VALUES ('测试本', 'resources/covers/shared-cover.png')",
                [],
            )
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', '<img data-note-image=\"true\" data-resource-path=\"resources/covers/shared-cover.png\" alt=\"共享封面\" />')",
                [],
            )
            .expect("insert note");

        update_notebook_cover_image_tx_internal(&mut connection, 1, "resources/covers/cover-b.png")
            .expect("update cover");
        let result = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &["resources/covers/shared-cover.png".to_string()],
        )
        .expect("cleanup old cover");

        assert_eq!(result.deleted_count, 0);
        assert!(result.failed.is_empty());
        assert!(temp_dir.path().join("resources/covers/shared-cover.png").is_file());
    }

    #[test]
    fn update_notebook_cover_image_path_rejects_empty_cover_path() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");

        let error = update_notebook_cover_image_tx_internal(&mut connection, 1, "   ")
            .expect_err("empty cover path should fail");

        assert_eq!(error, "封面路径不能为空。");
    }

    #[test]
    fn update_notebook_cover_image_path_rejects_invalid_cover_path() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");

        let error = update_notebook_cover_image_tx_internal(
            &mut connection,
            1,
            "/Users/test/cover-a.png",
        )
        .expect_err("absolute cover path should fail");

        assert_eq!(error, "资源路径无效。");
    }

    #[test]
    fn update_notebook_cover_image_path_reports_missing_notebook() {
        let mut connection = test_connection();

        let error = update_notebook_cover_image_tx_internal(
            &mut connection,
            999,
            "resources/covers/cover-a.png",
        )
        .expect_err("missing notebook should fail");

        assert_eq!(error, "目标笔记本不存在。");
    }

    #[test]
    fn clear_notebook_cover_image_path_clears_cover_and_returns_notebook() {
        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, cover_image_path) VALUES ('测试本', 'resources/covers/cover-a.png')",
                [],
            )
            .expect("insert notebook with cover");

        let notebook =
            clear_notebook_cover_image_tx_internal(&mut connection, 1).expect("clear cover");

        let stored_cover_path: Option<String> = connection
            .query_row(
                "SELECT cover_image_path FROM notebooks WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("read notebook cover");

        assert_eq!(notebook.id, 1);
        assert_eq!(notebook.cover_image_path, None);
        assert_eq!(stored_cover_path, None);
    }

    #[test]
    fn clear_cover_cleanup_keeps_resource_when_note_still_references_it() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());
        write_test_resource(temp_dir.path(), "resources/covers/shared-cover.png");

        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, cover_image_path) VALUES ('测试本', 'resources/covers/shared-cover.png')",
                [],
            )
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', '<img data-note-image=\"true\" data-resource-path=\"resources/covers/shared-cover.png\" alt=\"共享封面\" />')",
                [],
            )
            .expect("insert note");

        clear_notebook_cover_image_tx_internal(&mut connection, 1).expect("clear cover");
        let result = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &["resources/covers/shared-cover.png".to_string()],
        )
        .expect("cleanup cleared cover");

        assert_eq!(result.deleted_count, 0);
        assert!(result.failed.is_empty());
        assert!(temp_dir.path().join("resources/covers/shared-cover.png").is_file());
    }

    #[test]
    fn delete_note_cleanup_keeps_resource_when_cover_still_references_it() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());
        write_test_resource(temp_dir.path(), "resources/covers/shared-cover.png");

        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, cover_image_path) VALUES ('测试本', 'resources/covers/shared-cover.png')",
                [],
            )
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', '<img data-note-image=\"true\" data-resource-path=\"resources/covers/shared-cover.png\" alt=\"共享封面\" />')",
                [],
            )
            .expect("insert note");

        delete_note_tx_internal(&mut connection, 1).expect("delete note");
        let result = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &["resources/covers/shared-cover.png".to_string()],
        )
        .expect("cleanup deleted note");

        assert_eq!(result.deleted_count, 0);
        assert!(result.failed.is_empty());
        assert!(temp_dir.path().join("resources/covers/shared-cover.png").is_file());
    }

    #[test]
    fn shared_resource_between_note_and_cover_is_deleted_only_after_both_references_are_removed() {
        let temp_dir = tempdir().expect("create temp dir");
        ensure_test_resource_dirs(temp_dir.path());
        write_test_resource(temp_dir.path(), "resources/covers/shared-cover.png");

        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notebooks (name, cover_image_path) VALUES ('测试本', 'resources/covers/shared-cover.png')",
                [],
            )
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', '<img data-note-image=\"true\" data-resource-path=\"resources/covers/shared-cover.png\" alt=\"共享封面\" />')",
                [],
            )
            .expect("insert note");

        delete_note_tx_internal(&mut connection, 1).expect("delete note");
        let after_note = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &["resources/covers/shared-cover.png".to_string()],
        )
        .expect("cleanup after note deletion");
        assert_eq!(after_note.deleted_count, 0);
        assert!(temp_dir.path().join("resources/covers/shared-cover.png").is_file());

        clear_notebook_cover_image_tx_internal(&mut connection, 1).expect("clear cover");
        let after_cover = cleanup_candidate_unreferenced_managed_resources(
            temp_dir.path(),
            &connection,
            &["resources/covers/shared-cover.png".to_string()],
        )
        .expect("cleanup after cover removal");
        assert_eq!(after_cover.deleted_count, 1);
        assert!(after_cover.failed.is_empty());
        assert!(!temp_dir.path().join("resources/covers/shared-cover.png").exists());
    }

    #[test]
    fn clear_notebook_cover_image_path_reports_missing_notebook() {
        let mut connection = test_connection();

        let error = clear_notebook_cover_image_tx_internal(&mut connection, 999)
            .expect_err("missing notebook should fail");

        assert_eq!(error, "目标笔记本不存在。");
    }

    #[test]
    fn set_review_task_completed_path_can_toggle_five_times() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO notebooks (name) VALUES ('测试本')", [])
            .expect("insert notebook");
        connection
            .execute(
                "INSERT INTO folders (notebook_id, name, sort_order) VALUES (1, '收集箱', 0)",
                [],
            )
            .expect("insert folder");
        connection
            .execute(
                "INSERT INTO notes (notebook_id, folder_id, title, content_plaintext) VALUES (1, 1, '文件一', NULL)",
                [],
            )
            .expect("insert note");
        create_review_plan_tx_internal(&mut connection, "方案一", &[0, 3]).expect("create plan");
        bind_review_plan_to_note_tx_internal(&mut connection, 1, 1, "2026-04-07")
            .expect("bind review plan");

        for completed in [true, false, true, false, true] {
            let task = set_review_task_completed_tx_internal(&mut connection, 1, completed)
                .expect("toggle review task");
            assert_eq!(task.is_completed, completed);
            assert_eq!(task.completed_at.is_some(), completed);
        }
    }
}

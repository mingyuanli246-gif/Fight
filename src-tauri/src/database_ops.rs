use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

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
const TAG_COLOR_PALETTE: [&str; 8] = [
    "#2563EB", "#DC2626", "#CA8A04", "#059669", "#7C3AED", "#DB2777", "#0891B2", "#EA580C",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookRecord {
    pub id: i64,
    pub name: String,
    pub cover_image_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: i64,
    pub notebook_id: i64,
    pub folder_id: Option<i64>,
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
                    title: row.get(3)?,
                    content_plaintext: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
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
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(|error| to_command_error("读取笔记本", error))
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

fn create_note_tx_internal(
    connection: &mut Connection,
    notebook_id: i64,
    folder_id: i64,
    title: &str,
) -> Result<NoteRecord, String> {
    ensure_note_search_ready_internal(connection)?;

    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启创建文件事务", error))?;
    transaction
        .execute(
            "
              INSERT INTO notes (notebook_id, folder_id, title, content_plaintext)
              VALUES (?1, ?2, ?3, NULL)
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
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启删除文件夹事务", error))?;
    transaction
        .execute(
            "
              UPDATE notes
              SET folder_id = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE folder_id = ?1
            ",
            [folder_id],
        )
        .map_err(|error| to_command_error("重置文件所属文件夹", error))?;
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
    let normalized_path = cover_image_path.trim();

    if normalized_path.is_empty() {
        return Err("封面路径不能为空。".to_string());
    }

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
              SET content_plaintext = ?1, updated_at = CURRENT_TIMESTAMP
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
    let transaction = connection
        .transaction()
        .map_err(|error| to_command_error("开启添加标签事务", error))?;
    ensure_note_exists(&transaction, note_id)?;

    let tag = if let Some(tag) = fetch_tag_by_name(&transaction, name)? {
        tag
    } else {
        create_tag_record(&transaction, name)?
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
    delete_notebook_tx_internal(&mut connection, notebook_id)
}

#[tauri::command]
pub fn delete_folder_tx(app: AppHandle, folder_id: i64) -> Result<(), String> {
    let mut connection = open_database_connection(&app)?;
    delete_folder_tx_internal(&mut connection, folder_id)
}

#[tauri::command]
pub fn update_notebook_cover_image_tx(
    app: AppHandle,
    notebook_id: i64,
    cover_image_path: String,
) -> Result<NotebookRecord, String> {
    let mut connection = open_database_connection(&app)?;
    update_notebook_cover_image_tx_internal(&mut connection, notebook_id, &cover_image_path)
}

#[tauri::command]
pub fn clear_notebook_cover_image_tx(
    app: AppHandle,
    notebook_id: i64,
) -> Result<NotebookRecord, String> {
    let mut connection = open_database_connection(&app)?;
    clear_notebook_cover_image_tx_internal(&mut connection, notebook_id)
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
    delete_note_tx_internal(&mut connection, note_id)
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
        add_tag_to_note_by_name_tx_internal, bind_review_plan_to_note_tx_internal,
        clear_notebook_cover_image_tx_internal, create_note_tx_internal,
        create_review_plan_tx_internal, delete_review_plan_tx_internal, ensure_app_meta_table,
        ensure_note_search_ready_internal, ensure_note_search_table, extract_indexable_plain_text,
        rebuild_note_search_index_internal, rename_review_plan_tx_internal,
        set_review_task_completed_tx_internal, update_notebook_cover_image_tx_internal,
    };
    use rusqlite::Connection;

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
        }

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .expect("count notes");
        assert_eq!(count, 3);
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

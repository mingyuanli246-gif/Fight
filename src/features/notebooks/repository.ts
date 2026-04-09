import type Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import {
  FOLDER_ORDER,
  NOTEBOOK_ORDER,
  NOTE_ORDER,
  NOTE_TAG_ORDER,
  TAGGED_NOTE_ORDER,
  TAG_ORDER,
} from "./constants";
import { getNotebookDatabase } from "./db";
import type {
  Folder,
  Note,
  NoteSearchResult,
  Notebook,
  Tag,
  TaggedNoteResult,
  TagWithCount,
} from "./types";

class RepositoryValidationError extends Error {}

const MAX_TAG_NAME_LENGTH = 40;
const TAG_COLOR_PALETTE = [
  "#2563EB",
  "#DC2626",
  "#CA8A04",
  "#059669",
  "#7C3AED",
  "#DB2777",
  "#0891B2",
  "#EA580C",
];

type NoteSearchRow = {
  noteId: number;
  notebookId: number;
  folderId: number | null;
  title: string;
  notebookName: string;
  folderName: string | null;
  bodyPlaintext: string;
  updatedAt: string;
};

type TagWithCountRow = TagWithCount;
type TaggedNoteRow = TaggedNoteResult;

let noteSearchReadyPromise: Promise<void> | null = null;
let hasInitializedNoteSearch = false;

function getRawErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function classifyDatabaseError(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("database is locked")) {
    return "database is locked";
  }

  if (normalized.includes("cannot start a transaction within a transaction")) {
    return "cannot start a transaction within a transaction";
  }

  if (normalized.includes("cannot rollback - no transaction is active")) {
    return "cannot rollback - no transaction is active";
  }

  if (normalized.includes("no such table: app_meta")) {
    return "no such table: app_meta";
  }

  if (normalized.includes("no such table: note_search")) {
    return "no such table: note_search";
  }

  return "sqlite error";
}

function logRepositoryError(action: string, error: unknown) {
  const rawMessage = getRawErrorMessage(error);
  console.error(
    `[notebooks.repository] ${action}失败 [${classifyDatabaseError(rawMessage)}]`,
    error,
  );
}

function isRepositoryValidationMessage(message: string) {
  return [
    "封面路径不能为空。",
    "资源路径无效。",
    "目标笔记本不存在。",
    "目标文件夹不存在。",
    "目标文件夹不属于当前笔记本。",
    "目标文件不存在。",
    "目标标签不存在。",
    "创建标签失败，请稍后重试。",
  ].includes(message);
}

function toRepositoryError(action: string, error: unknown) {
  if (error instanceof Error && isRepositoryValidationMessage(error.message)) {
    return new RepositoryValidationError(error.message);
  }

  if (error instanceof RepositoryValidationError) {
    return error;
  }

  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("unique constraint failed: tags.name")
  ) {
    return new RepositoryValidationError("标签名称已存在。");
  }

  logRepositoryError(action, error);

  return new Error(`${action}失败，请稍后重试。`);
}

async function withRepositoryError<T>(
  action: string,
  operation: () => Promise<T>,
) {
  try {
    return await operation();
  } catch (error) {
    throw toRepositoryError(action, error);
  }
}

async function ensureNoteSearchReadyCommand() {
  return invoke<void>("ensure_note_search_ready");
}

async function rebuildNoteSearchIndexCommand() {
  return invoke<void>("rebuild_note_search_index");
}

async function createNoteCommand(
  notebookId: number,
  folderId: number,
  title: string,
) {
  return invoke<Note>("create_note_tx", {
    notebookId,
    folderId,
    title,
  });
}

async function createFolderCommand(notebookId: number, name: string) {
  return invoke<Folder>("create_folder_tx", {
    notebookId,
    name,
  });
}

async function deleteNotebookCommand(notebookId: number) {
  return invoke<void>("delete_notebook_tx", { notebookId });
}

async function deleteFolderCommand(folderId: number) {
  return invoke<void>("delete_folder_tx", { folderId });
}

async function updateNotebookCoverImageCommand(
  notebookId: number,
  coverImagePath: string,
) {
  return invoke<Notebook>("update_notebook_cover_image_tx", {
    notebookId,
    coverImagePath,
  });
}

async function clearNotebookCoverImageCommand(notebookId: number) {
  return invoke<Notebook>("clear_notebook_cover_image_tx", { notebookId });
}

async function renameNoteCommand(noteId: number, title: string) {
  return invoke<Note>("rename_note_tx", { noteId, title });
}

async function updateNoteContentCommand(noteId: number, content: string) {
  return invoke<Note>("update_note_content_tx", { noteId, content });
}

async function deleteNoteCommand(noteId: number) {
  return invoke<void>("delete_note_tx", { noteId });
}

async function addTagToNoteByNameCommand(noteId: number, name: string) {
  return invoke<Tag[]>("add_tag_to_note_by_name_tx", { noteId, name });
}

async function removeTagFromNoteCommand(noteId: number, tagId: number) {
  return invoke<Tag[]>("remove_tag_from_note_tx", { noteId, tagId });
}

function requireName(value: string, label: string) {
  const normalized = value.trim();

  if (!normalized) {
    throw new RepositoryValidationError(`${label}名称不能为空。`);
  }

  return normalized;
}

function normalizeTagName(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  const length = Array.from(normalized).length;

  if (!normalized) {
    throw new RepositoryValidationError("标签名称不能为空。");
  }

  if (length > MAX_TAG_NAME_LENGTH) {
    throw new RepositoryValidationError(
      `标签名称不能超过${MAX_TAG_NAME_LENGTH}个字符。`,
    );
  }

  return normalized;
}

function normalizeSearchInput(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function buildSafeFtsMatchExpression(query: string) {
  const normalized = normalizeSearchInput(query);

  if (!normalized) {
    return null;
  }

  const tokens = normalized.split(" ").filter(Boolean);

  if (tokens.length === 0 || tokens.some((token) => token.length < 3)) {
    return null;
  }

  return tokens
    .map((token) => `"${token.replace(/"/g, "\"\"")}"`)
    .join(" AND ");
}

function shouldUseLikeSearch(query: string) {
  const normalized = normalizeSearchInput(query);

  if (!normalized) {
    return false;
  }

  const tokens = normalized.split(" ").filter(Boolean);

  return normalized.length < 3 || tokens.some((token) => token.length < 3);
}

function buildExcerpt(value: string) {
  const normalized = value.trim();

  if (!normalized) {
    return "正文暂无内容";
  }

  return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized;
}

async function selectOne<T>(
  database: Database,
  query: string,
  bindValues: unknown[],
  missingMessage: string,
) {
  const rows = await database.select<T[]>(query, bindValues);
  const item = rows[0];

  if (!item) {
    throw new RepositoryValidationError(missingMessage);
  }

  return item;
}

async function fetchNotebookById(database: Database, id: number) {
  return selectOne<Notebook>(
    database,
    `
      SELECT
        id,
        name,
        cover_image_path AS coverImagePath,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM notebooks
      WHERE id = $1
    `,
    [id],
    "目标笔记本不存在。",
  );
}

async function fetchFolderById(database: Database, id: number) {
  return selectOne<Folder>(
    database,
    `
      SELECT
        id,
        notebook_id AS notebookId,
        parent_folder_id AS parentFolderId,
        name,
        sort_order AS sortOrder,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM folders
      WHERE id = $1
    `,
    [id],
    "目标文件夹不存在。",
  );
}

async function fetchNoteById(database: Database, id: number) {
  return selectOne<Note>(
    database,
    `
      SELECT
        id,
        notebook_id AS notebookId,
        folder_id AS folderId,
        title,
        content_plaintext AS contentPlaintext,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM notes
      WHERE id = $1
    `,
    [id],
    "目标文件不存在。",
  );
}

async function fetchTagById(database: Database, id: number) {
  return selectOne<Tag>(
    database,
    `
      SELECT
        id,
        name,
        color,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM tags
      WHERE id = $1
    `,
    [id],
    "目标标签不存在。",
  );
}

async function getNextTagColor(database: Database) {
  const rows = await database.select<{ count: number }[]>(
    "SELECT COUNT(*) AS count FROM tags",
  );
  const count = rows[0]?.count ?? 0;
  return TAG_COLOR_PALETTE[count % TAG_COLOR_PALETTE.length];
}

async function createTagRecord(database: Database, normalizedName: string) {
  const color = await getNextTagColor(database);
  const result = await database.execute(
    `
      INSERT INTO tags (name, color)
      VALUES ($1, $2)
    `,
    [normalizedName, color],
  );

  if (typeof result.lastInsertId !== "number") {
    throw new RepositoryValidationError("创建标签失败，请稍后重试。");
  }

  return fetchTagById(database, result.lastInsertId);
}

async function listTagsByNoteInternal(database: Database, noteId: number) {
  return database.select<Tag[]>(
    `
      SELECT
        tags.id,
        tags.name,
        tags.color,
        tags.created_at AS createdAt,
        tags.updated_at AS updatedAt
      FROM note_tags
      INNER JOIN tags ON tags.id = note_tags.tag_id
      WHERE note_tags.note_id = $1
      ${NOTE_TAG_ORDER}
    `,
    [noteId],
  );
}

async function ensureNoteSearchReadyInternal(database: Database) {
  void database;
  await ensureNoteSearchReadyCommand();
  hasInitializedNoteSearch = true;
}

async function ensureNoteSearchReady(database: Database) {
  if (hasInitializedNoteSearch) {
    return;
  }

  if (!noteSearchReadyPromise) {
    noteSearchReadyPromise = ensureNoteSearchReadyInternal(database).catch(
      (error) => {
        noteSearchReadyPromise = null;
        hasInitializedNoteSearch = false;
        throw error;
      },
    );
  }

  return noteSearchReadyPromise;
}

function toNoteSearchResult(row: NoteSearchRow): NoteSearchResult {
  return {
    noteId: row.noteId,
    notebookId: row.notebookId,
    folderId: row.folderId,
    title: row.title,
    notebookName: row.notebookName,
    folderName: row.folderName,
    excerpt: buildExcerpt(row.bodyPlaintext),
    updatedAt: row.updatedAt,
  };
}

export async function getNoteById(id: number) {
  return withRepositoryError("读取文件正文", async () => {
    const database = await getNotebookDatabase();
    return fetchNoteById(database, id);
  });
}

export async function initializeNotebookDatabase() {
  return withRepositoryError("数据库初始化", async () => {
    const database = await getNotebookDatabase();
    await ensureNoteSearchReady(database);
  });
}

export async function rebuildNoteSearchIndex() {
  return withRepositoryError("重建搜索索引", async () => {
    await getNotebookDatabase();
    await rebuildNoteSearchIndexCommand();
    hasInitializedNoteSearch = true;
  });
}

export async function listNotebooks() {
  return withRepositoryError("读取笔记本", async () => {
    const database = await getNotebookDatabase();

    return database.select<Notebook[]>(
      `
        SELECT
          id,
          name,
          cover_image_path AS coverImagePath,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM notebooks
        ${NOTEBOOK_ORDER}
      `,
    );
  });
}

export async function createNotebook(name: string) {
  return withRepositoryError("创建笔记本", async () => {
    const database = await getNotebookDatabase();
    const normalizedName = requireName(name, "笔记本");
    const result = await database.execute(
      `
        INSERT INTO notebooks (name, cover_image_path)
        VALUES ($1, NULL)
      `,
      [normalizedName],
    );

    if (typeof result.lastInsertId !== "number") {
      throw new RepositoryValidationError("创建笔记本失败，请稍后重试。");
    }

    return fetchNotebookById(database, result.lastInsertId);
  });
}

export async function renameNotebook(id: number, name: string) {
  return withRepositoryError("重命名笔记本", async () => {
    const database = await getNotebookDatabase();
    const normalizedName = requireName(name, "笔记本");
    const result = await database.execute(
      `
        UPDATE notebooks
        SET name = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `,
      [normalizedName, id],
    );

    if (result.rowsAffected === 0) {
      throw new RepositoryValidationError("目标笔记本不存在。");
    }

    return fetchNotebookById(database, id);
  });
}

export async function updateNotebookCoverImage(
  id: number,
  coverImagePath: string,
) {
  return withRepositoryError("保存笔记本封面", async () => {
    await getNotebookDatabase();
    const normalizedPath = coverImagePath.trim();

    try {
      if (!normalizedPath) {
        throw new RepositoryValidationError("封面路径不能为空。");
      }

      const notebook = await updateNotebookCoverImageCommand(id, normalizedPath);
      console.info("[notebooks.repository] updateNotebookCoverImage成功", {
        notebookId: id,
        coverImagePath: normalizedPath,
      });
      return notebook;
    } catch (error) {
      console.error("[notebooks.repository] updateNotebookCoverImage失败", {
        notebookId: id,
        coverImagePath: normalizedPath,
        error,
      });
      throw error;
    }
  });
}

export async function clearNotebookCoverImage(id: number) {
  return withRepositoryError("清除笔记本封面", async () => {
    await getNotebookDatabase();
    return clearNotebookCoverImageCommand(id);
  });
}

export async function deleteNotebook(id: number) {
  return withRepositoryError("删除笔记本", async () => {
    await getNotebookDatabase();
    await deleteNotebookCommand(id);
  });
}

export async function listFoldersByNotebook(notebookId: number) {
  return withRepositoryError("读取文件夹", async () => {
    const database = await getNotebookDatabase();

    return database.select<Folder[]>(
      `
        SELECT
          id,
          notebook_id AS notebookId,
          parent_folder_id AS parentFolderId,
          name,
          sort_order AS sortOrder,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM folders
        WHERE notebook_id = $1
        ${FOLDER_ORDER}
      `,
      [notebookId],
    );
  });
}

export async function createFolder(notebookId: number, name: string) {
  return withRepositoryError("创建文件夹", async () => {
    await getNotebookDatabase();
    const normalizedName = requireName(name, "文件夹");
    return createFolderCommand(notebookId, normalizedName);
  });
}

export async function renameFolder(id: number, name: string) {
  return withRepositoryError("重命名文件夹", async () => {
    const database = await getNotebookDatabase();
    const normalizedName = requireName(name, "文件夹");
    const result = await database.execute(
      `
        UPDATE folders
        SET name = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `,
      [normalizedName, id],
    );

    if (result.rowsAffected === 0) {
      throw new RepositoryValidationError("目标文件夹不存在。");
    }

    return fetchFolderById(database, id);
  });
}

export async function deleteFolder(id: number) {
  return withRepositoryError("删除文件夹", async () => {
    await getNotebookDatabase();
    await deleteFolderCommand(id);
  });
}

export async function listNotesByNotebook(notebookId: number) {
  return withRepositoryError("读取文件", async () => {
    const database = await getNotebookDatabase();

    return database.select<Note[]>(
      `
        SELECT
          id,
          notebook_id AS notebookId,
          folder_id AS folderId,
          title,
          content_plaintext AS contentPlaintext,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM notes
        WHERE notebook_id = $1
        ${NOTE_ORDER}
      `,
      [notebookId],
    );
  });
}

export async function createNote(
  notebookId: number,
  folderId: number | null,
  title: string,
) {
  return withRepositoryError("创建文件", async () => {
    await getNotebookDatabase();
    const normalizedTitle = requireName(title, "文件");

    if (folderId === null) {
      throw new RepositoryValidationError("请先选择文件夹，再创建文件。");
    }

    return createNoteCommand(notebookId, folderId, normalizedTitle);
  });
}

export async function renameNote(id: number, title: string) {
  return withRepositoryError("重命名文件", async () => {
    const normalizedTitle = requireName(title, "文件");
    await getNotebookDatabase();
    return renameNoteCommand(id, normalizedTitle);
  });
}

export async function updateNoteContent(id: number, content: string) {
  return withRepositoryError("保存正文", async () => {
    // 第四阶段起，content_plaintext 继续作为唯一正文列使用，但允许保存富文本 HTML。
    // 这是已知命名债，本阶段不做 schema 变更，后续如需拆分字段再单独迁移。
    await getNotebookDatabase();
    return updateNoteContentCommand(id, content);
  });
}

export async function deleteNote(id: number) {
  return withRepositoryError("删除文件", async () => {
    await getNotebookDatabase();
    await deleteNoteCommand(id);
  });
}

export async function searchNotes(query: string, limit = 20) {
  return withRepositoryError("搜索文件", async () => {
    const database = await getNotebookDatabase();
    await ensureNoteSearchReady(database);

    const normalizedQuery = normalizeSearchInput(query);

    if (!normalizedQuery) {
      return [] as NoteSearchResult[];
    }

    const safeLimit = Math.min(Math.max(limit, 1), 20);

    const baseSelect = `
      SELECT
        notes.id AS noteId,
        notes.notebook_id AS notebookId,
        notes.folder_id AS folderId,
        notes.title AS title,
        notebooks.name AS notebookName,
        folders.name AS folderName,
        note_search.body_plaintext AS bodyPlaintext,
        notes.updated_at AS updatedAt
      FROM note_search
      INNER JOIN notes ON notes.id = note_search.rowid
      INNER JOIN notebooks ON notebooks.id = notes.notebook_id
      LEFT JOIN folders ON folders.id = notes.folder_id
    `;

    if (shouldUseLikeSearch(normalizedQuery)) {
      const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
      const rows = await database.select<NoteSearchRow[]>(
        `
          ${baseSelect}
          WHERE note_search.title LIKE $1 ESCAPE '\\'
             OR note_search.body_plaintext LIKE $1 ESCAPE '\\'
          ORDER BY notes.updated_at DESC
          LIMIT $2
        `,
        [pattern, safeLimit],
      );

      return rows.map(toNoteSearchResult);
    }

    const matchExpression = buildSafeFtsMatchExpression(normalizedQuery);

    if (!matchExpression) {
      return [] as NoteSearchResult[];
    }

    const rows = await database.select<NoteSearchRow[]>(
      `
        ${baseSelect}
        WHERE note_search MATCH $1
        ORDER BY notes.updated_at DESC
        LIMIT $2
      `,
      [matchExpression, safeLimit],
    );

    return rows.map(toNoteSearchResult);
  });
}

export async function listTagsWithCounts() {
  return withRepositoryError("读取标签", async () => {
    const database = await getNotebookDatabase();

    return database.select<TagWithCountRow[]>(
      `
        SELECT
          tags.id AS id,
          tags.name AS name,
          tags.color AS color,
          tags.created_at AS createdAt,
          tags.updated_at AS updatedAt,
          COUNT(note_tags.note_id) AS noteCount
        FROM tags
        LEFT JOIN note_tags ON note_tags.tag_id = tags.id
        GROUP BY tags.id, tags.name, tags.color, tags.created_at, tags.updated_at
        ${TAG_ORDER}
      `,
    );
  });
}

export async function listTagsByNote(noteId: number) {
  return withRepositoryError("读取文件标签", async () => {
    const database = await getNotebookDatabase();
    await fetchNoteById(database, noteId);
    return listTagsByNoteInternal(database, noteId);
  });
}

export async function listNotesByTag(tagId: number) {
  return withRepositoryError("读取标签关联文件", async () => {
    const database = await getNotebookDatabase();
    await fetchTagById(database, tagId);

    return database.select<TaggedNoteRow[]>(
      `
        SELECT
          notes.id AS noteId,
          notes.notebook_id AS notebookId,
          notes.folder_id AS folderId,
          notes.title AS title,
          notebooks.name AS notebookName,
          folders.name AS folderName,
          notes.updated_at AS updatedAt
        FROM note_tags
        INNER JOIN notes ON notes.id = note_tags.note_id
        INNER JOIN notebooks ON notebooks.id = notes.notebook_id
        LEFT JOIN folders ON folders.id = notes.folder_id
        WHERE note_tags.tag_id = $1
        ${TAGGED_NOTE_ORDER}
      `,
      [tagId],
    );
  });
}

export async function createTag(name: string) {
  return withRepositoryError("创建标签", async () => {
    const database = await getNotebookDatabase();
    const normalizedName = normalizeTagName(name);
    return createTagRecord(database, normalizedName);
  });
}

export async function renameTag(id: number, name: string) {
  return withRepositoryError("重命名标签", async () => {
    const database = await getNotebookDatabase();
    const normalizedName = normalizeTagName(name);
    const result = await database.execute(
      `
        UPDATE tags
        SET name = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `,
      [normalizedName, id],
    );

    if (result.rowsAffected === 0) {
      throw new RepositoryValidationError("目标标签不存在。");
    }

    return fetchTagById(database, id);
  });
}

export async function deleteTag(id: number) {
  return withRepositoryError("删除标签", async () => {
    const database = await getNotebookDatabase();
    const result = await database.execute("DELETE FROM tags WHERE id = $1", [id]);

    if (result.rowsAffected === 0) {
      throw new RepositoryValidationError("目标标签不存在。");
    }
  });
}

export async function addTagToNoteByName(noteId: number, name: string) {
  return withRepositoryError("添加标签", async () => {
    const normalizedName = normalizeTagName(name);
    await getNotebookDatabase();
    return addTagToNoteByNameCommand(noteId, normalizedName);
  });
}

export async function removeTagFromNote(noteId: number, tagId: number) {
  return withRepositoryError("移除标签", async () => {
    await getNotebookDatabase();
    return removeTagFromNoteCommand(noteId, tagId);
  });
}

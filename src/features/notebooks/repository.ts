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
import { extractIndexablePlainText } from "./richTextContent";
import { findFirstExactSearchMatch } from "./searchQuery";
import { DEFAULT_TAG_COLOR, normalizeTagColor } from "./tagColors";
import { validateTagName } from "./tagNameValidation";
import type {
  Folder,
  Note,
  NoteSearchResult,
  Notebook,
  RestoreTrashResult,
  Tag,
  TagContentPreviewResult,
  TrashItemType,
  TrashRootItem,
  TextTagOccurrenceDraft,
  TagWithCount,
} from "./types";

class RepositoryValidationError extends Error {}

type NoteSearchRow = {
  noteId: number;
  notebookId: number;
  folderId: number | null;
  title: string;
  notebookName: string;
  folderName: string | null;
  storedContent: string | null;
  bodyPlaintext: string;
  updatedAt: string;
};

type TagWithCountRow = TagWithCount;
type TagContentPreviewRow = TagContentPreviewResult;
type CountRow = {
  count: number;
};

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
    "目标笔记本不能是当前笔记本。",
    "目标文件夹不存在。",
    "目标文件夹不属于当前笔记本。",
    "目标文件不存在。",
    "目标文件已在回收站。",
    "目标文件夹已在回收站。",
    "目标笔记本已在回收站。",
    "系统恢复笔记本不能移入回收站。",
    "目标回收站项目不存在或已被处理。",
    "只能操作顶层回收站项目。",
    "回收站项目类型无效。",
    "目标文件不在文件夹中。",
    "目标插入位置无效。",
    "目标标签不存在。",
    "笔记本顺序数据不完整。",
    "笔记本顺序数据无效。",
    "文件夹顺序数据不完整。",
    "文件夹顺序数据无效。",
    "创建标签失败，请稍后重试。",
    "该标签仍被正文标注引用，请先移除相关内容标注后再删除。",
    "标注数据无效，请重新应用标签后再保存。",
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
    return new RepositoryValidationError("标签名称已存在");
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

async function createNotebookCommand(name: string) {
  return invoke<Notebook>("create_notebook_tx", { name });
}

async function createFolderCommand(notebookId: number, name: string) {
  return invoke<Folder>("create_folder_tx", {
    notebookId,
    name,
  });
}

async function ensureNotebookTreeConstraintsCommand() {
  return invoke<void>("ensure_notebook_tree_constraints_tx");
}

async function moveNotebookToTrashCommand(notebookId: number) {
  return invoke<void>("move_notebook_to_trash_tx", { notebookId });
}

async function moveFolderToTrashCommand(folderId: number) {
  return invoke<void>("move_folder_to_trash_tx", { folderId });
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

async function saveNoteContentWithTagsCommand(
  noteId: number,
  content: string,
  occurrences: TextTagOccurrenceDraft[],
) {
  return invoke<Note>("save_note_content_with_tags_tx", {
    noteId,
    content,
    occurrences,
  });
}

async function moveNoteToTrashCommand(noteId: number) {
  return invoke<void>("move_note_to_trash_tx", { noteId });
}

async function listTrashRootsCommand() {
  return invoke<TrashRootItem[]>("list_trash_roots_tx");
}

async function restoreTrashedItemCommand(itemType: TrashItemType, itemId: number) {
  return invoke<RestoreTrashResult>("restore_trashed_item_tx", { itemType, itemId });
}

async function purgeTrashedItemCommand(itemType: TrashItemType, itemId: number) {
  return invoke<void>("purge_trashed_item_tx", { itemType, itemId });
}

async function cleanupExpiredTrashCommand() {
  return invoke<void>("cleanup_expired_trash_tx");
}

async function reorderNotebooksCommand(orderedNotebookIds: number[]) {
  return invoke<void>("reorder_notebooks_tx", { orderedNotebookIds });
}

async function reorderFoldersCommand(
  notebookId: number,
  orderedFolderIds: number[],
) {
  return invoke<void>("reorder_folders_tx", {
    notebookId,
    orderedFolderIds,
  });
}

async function moveNoteCommand(
  noteId: number,
  targetFolderId: number,
  targetIndex: number,
) {
  return invoke<Note>("move_note_tx", {
    noteId,
    targetFolderId,
    targetIndex,
  });
}

async function moveFolderToNotebookTopCommand(
  folderId: number,
  targetNotebookId: number,
) {
  return invoke<Folder>("move_folder_to_notebook_top_tx", {
    folderId,
    targetNotebookId,
  });
}

async function duplicateNoteAboveCommand(noteId: number) {
  return invoke<Note>("duplicate_note_above_tx", { noteId });
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
  const { name, error } = validateTagName(value);

  if (error) {
    throw new RepositoryValidationError(error);
  }

  return name;
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

const DISPLAY_EXCERPT_MAX_LENGTH = 120;
const HIGHLIGHT_EXCERPT_MAX_LENGTH = 48;

function buildExcerpt(value: string) {
  const normalized = value.trim();

  if (!normalized) {
    return "正文暂无内容";
  }

  return normalized.length > DISPLAY_EXCERPT_MAX_LENGTH
    ? `${normalized.slice(0, DISPLAY_EXCERPT_MAX_LENGTH)}…`
    : normalized;
}

function sliceAroundMatch(
  value: string,
  match: { start: number; end: number },
  maxLength: number,
) {
  const anchorLength = Math.max(match.end - match.start, 1);
  const beforeLength = Math.max(Math.floor((maxLength - anchorLength) / 3), 0);
  const afterLength = Math.max(maxLength - anchorLength - beforeLength, 0);

  let start = Math.max(0, match.start - beforeLength);
  let end = Math.min(value.length, match.end + afterLength);

  if (end - start < maxLength) {
    if (start === 0) {
      end = Math.min(value.length, maxLength);
    } else if (end === value.length) {
      start = Math.max(0, value.length - maxLength);
    }
  }

  const excerpt = value.slice(start, end).trim();

  if (!excerpt) {
    return null;
  }

  return {
    start,
    end,
    excerpt,
  };
}

function extractSearchableBodyText(row: NoteSearchRow) {
  const visibleText = extractIndexablePlainText(row.storedContent);

  if (visibleText) {
    return visibleText;
  }

  return extractIndexablePlainText(row.bodyPlaintext);
}

function buildMatchedExcerptPair(
  value: string,
  match: { start: number; end: number },
) {
  const normalized = value.trim();

  if (!normalized) {
    return {
      excerpt: "正文暂无内容",
      highlightExcerpt: undefined,
    };
  }

  const displayExcerpt = sliceAroundMatch(
    value,
    match,
    DISPLAY_EXCERPT_MAX_LENGTH,
  );
  const highlightExcerpt = sliceAroundMatch(
    value,
    match,
    HIGHLIGHT_EXCERPT_MAX_LENGTH,
  );

  if (!displayExcerpt) {
    return {
      excerpt: buildExcerpt(value),
      highlightExcerpt: undefined,
    };
  }

  return {
    excerpt: `${displayExcerpt.start > 0 ? "…" : ""}${displayExcerpt.excerpt}${
      displayExcerpt.end < value.length ? "…" : ""
    }`,
    highlightExcerpt: highlightExcerpt?.excerpt,
  };
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
        custom_sort_order AS customSortOrder,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM notebooks
      WHERE id = $1 AND deleted_at IS NULL
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
      WHERE id = $1 AND deleted_at IS NULL
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
        sort_order AS sortOrder,
        title,
        content_plaintext AS contentPlaintext,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM notes
      WHERE id = $1 AND deleted_at IS NULL
    `,
    [id],
    "目标文件不存在。",
  );
}

async function fetchTagById(database: Database, id: number) {
  const tag = await selectOne<Tag>(
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

  return {
    ...tag,
    color: normalizeTagColor(tag.color),
  };
}

async function createTagRecord(
  database: Database,
  normalizedName: string,
  color: string,
) {
  const normalizedColor = normalizeTagColor(color);
  const result = await database.execute(
    `
      INSERT INTO tags (name, color)
      VALUES ($1, $2)
    `,
    [normalizedName, normalizedColor],
  );

  if (typeof result.lastInsertId !== "number") {
    throw new RepositoryValidationError("创建标签失败，请稍后重试。");
  }

  return fetchTagById(database, result.lastInsertId);
}

async function listTagsByNoteInternal(database: Database, noteId: number) {
  const tags = await database.select<Tag[]>(
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

  return tags.map((tag) => ({
    ...tag,
    color: normalizeTagColor(tag.color),
  }));
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

function toNoteSearchResult(row: NoteSearchRow, query: string): NoteSearchResult {
  const bodyText = extractSearchableBodyText(row);
  const firstMatch = findFirstExactSearchMatch(bodyText, query);
  const excerptResult = firstMatch
    ? buildMatchedExcerptPair(bodyText, firstMatch)
    : {
        excerpt: buildExcerpt(bodyText),
        highlightExcerpt: undefined,
      };

  return {
    noteId: row.noteId,
    notebookId: row.notebookId,
    folderId: row.folderId,
    title: row.title,
    notebookName: row.notebookName,
    folderName: row.folderName,
    excerpt: excerptResult.excerpt,
    highlightExcerpt: excerptResult.highlightExcerpt,
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
    await ensureNotebookTreeConstraintsCommand();
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
          custom_sort_order AS customSortOrder,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM notebooks
        WHERE deleted_at IS NULL
        ${NOTEBOOK_ORDER}
      `,
    );
  });
}

export async function createNotebook(name: string) {
  return withRepositoryError("创建笔记本", async () => {
    const normalizedName = requireName(name, "笔记本");
    await getNotebookDatabase();
    return createNotebookCommand(normalizedName);
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
        WHERE id = $2 AND deleted_at IS NULL
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

export async function moveNotebookToTrash(id: number) {
  return withRepositoryError("移入回收站", async () => {
    await getNotebookDatabase();
    await moveNotebookToTrashCommand(id);
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
          AND deleted_at IS NULL
        ${FOLDER_ORDER}
      `,
      [notebookId],
    );
  });
}

export async function listAllFolders() {
  return withRepositoryError("读取全部文件夹", async () => {
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
        WHERE deleted_at IS NULL
        ${FOLDER_ORDER}
      `,
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
        WHERE id = $2 AND deleted_at IS NULL
      `,
      [normalizedName, id],
    );

    if (result.rowsAffected === 0) {
      throw new RepositoryValidationError("目标文件夹不存在。");
    }

    return fetchFolderById(database, id);
  });
}

export async function moveFolderToTrash(id: number) {
  return withRepositoryError("移入回收站", async () => {
    await getNotebookDatabase();
    await moveFolderToTrashCommand(id);
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
          sort_order AS sortOrder,
          title,
          content_plaintext AS contentPlaintext,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM notes
        WHERE notebook_id = $1
          AND deleted_at IS NULL
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

export async function reorderNotebooks(orderedNotebookIds: number[]) {
  return withRepositoryError("保存笔记本排序", async () => {
    await getNotebookDatabase();
    await reorderNotebooksCommand(orderedNotebookIds);
  });
}

export async function reorderFolders(
  notebookId: number,
  orderedFolderIds: number[],
) {
  return withRepositoryError("保存文件夹排序", async () => {
    await getNotebookDatabase();
    await reorderFoldersCommand(notebookId, orderedFolderIds);
  });
}

export async function moveNote(
  noteId: number,
  targetFolderId: number,
  targetIndex: number,
) {
  return withRepositoryError("保存文件排序", async () => {
    return moveNoteCommand(noteId, targetFolderId, targetIndex);
  });
}

export async function moveFolderToNotebookTop(
  folderId: number,
  targetNotebookId: number,
) {
  return withRepositoryError("移动文件夹", async () => {
    await getNotebookDatabase();
    return moveFolderToNotebookTopCommand(folderId, targetNotebookId);
  });
}

export async function duplicateNoteAbove(noteId: number) {
  return withRepositoryError("复制文件", async () => {
    await getNotebookDatabase();
    return duplicateNoteAboveCommand(noteId);
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

export async function saveNoteContentWithTags(
  id: number,
  content: string,
  occurrences: TextTagOccurrenceDraft[],
) {
  return withRepositoryError("保存正文", async () => {
    await getNotebookDatabase();
    return saveNoteContentWithTagsCommand(id, content, occurrences);
  });
}

export async function moveNoteToTrash(id: number) {
  return withRepositoryError("移入回收站", async () => {
    await getNotebookDatabase();
    await moveNoteToTrashCommand(id);
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
        notes.content_plaintext AS storedContent,
        note_search.body_plaintext AS bodyPlaintext,
        notes.updated_at AS updatedAt
      FROM note_search
      INNER JOIN notes ON notes.id = note_search.rowid
      INNER JOIN notebooks ON notebooks.id = notes.notebook_id
      LEFT JOIN folders ON folders.id = notes.folder_id AND folders.deleted_at IS NULL
    `;

    if (shouldUseLikeSearch(normalizedQuery)) {
      const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
      const rows = await database.select<NoteSearchRow[]>(
        `
          ${baseSelect}
          WHERE notes.deleted_at IS NULL
            AND notebooks.deleted_at IS NULL
            AND (
              note_search.title LIKE $1 ESCAPE '\\'
              OR note_search.body_plaintext LIKE $1 ESCAPE '\\'
            )
          ORDER BY notes.updated_at DESC
          LIMIT $2
        `,
        [pattern, safeLimit],
      );

      return rows.map((row) => toNoteSearchResult(row, normalizedQuery));
    }

    const matchExpression = buildSafeFtsMatchExpression(normalizedQuery);

    if (!matchExpression) {
      return [] as NoteSearchResult[];
    }

    const rows = await database.select<NoteSearchRow[]>(
      `
        ${baseSelect}
        WHERE notes.deleted_at IS NULL
          AND notebooks.deleted_at IS NULL
          AND note_search MATCH $1
        ORDER BY notes.updated_at DESC
        LIMIT $2
      `,
      [matchExpression, safeLimit],
    );

    return rows.map((row) => toNoteSearchResult(row, normalizedQuery));
  });
}

export async function listTagsWithCounts() {
  return withRepositoryError("读取标签", async () => {
    const database = await getNotebookDatabase();

    const tags = await database.select<TagWithCountRow[]>(
      `
        SELECT
          tags.id AS id,
          tags.name AS name,
          tags.color AS color,
          tags.created_at AS createdAt,
          tags.updated_at AS updatedAt,
          COUNT(notes.id) AS noteCount
        FROM tags
        LEFT JOIN note_tags ON note_tags.tag_id = tags.id
        LEFT JOIN notes ON notes.id = note_tags.note_id AND notes.deleted_at IS NULL
        GROUP BY tags.id, tags.name, tags.color, tags.created_at, tags.updated_at
        ${TAG_ORDER}
      `,
    );

    return tags.map((tag) => ({
      ...tag,
      color: normalizeTagColor(tag.color),
    }));
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
  return listTagContentPreviews(tagId);
}

async function countTagUsageNoteCountInternal(database: Database, tagId: number) {
  const rows = await database.select<CountRow[]>(
    `
      SELECT COUNT(DISTINCT note_id) AS count
      FROM note_tag_occurrences
      WHERE tag_id = $1
    `,
    [tagId],
  );

  return rows[0]?.count ?? 0;
}

function buildTagUsageBlockedMessage(noteCount: number) {
  return `该标签仍被 ${noteCount} 个文件使用，需先移除正文中的标签后才能删除。`;
}

export async function countTagUsageNotes(tagId: number) {
  return withRepositoryError("读取标签使用情况", async () => {
    const database = await getNotebookDatabase();
    await fetchTagById(database, tagId);
    return countTagUsageNoteCountInternal(database, tagId);
  });
}

export async function listTagContentPreviews(tagId: number) {
  return withRepositoryError("读取标签关联内容", async () => {
    const database = await getNotebookDatabase();
    await fetchTagById(database, tagId);

    return database.select<TagContentPreviewRow[]>(
      `
        WITH ranked_occurrences AS (
          SELECT
            note_tag_occurrences.id AS occurrenceId,
            note_tag_occurrences.note_id AS noteId,
            note_tag_occurrences.snippet_text AS previewText,
            ROW_NUMBER() OVER (
              PARTITION BY note_tag_occurrences.note_id
              ORDER BY note_tag_occurrences.sort_order ASC, note_tag_occurrences.id ASC
            ) AS occurrenceRank
          FROM note_tag_occurrences
          WHERE note_tag_occurrences.tag_id = $1
        )
        SELECT
          notes.id AS noteId,
          notes.notebook_id AS notebookId,
          notes.folder_id AS folderId,
          notes.title AS title,
          ranked_occurrences.previewText AS previewText
        FROM ranked_occurrences
        INNER JOIN notes ON notes.id = ranked_occurrences.noteId
        INNER JOIN notebooks ON notebooks.id = notes.notebook_id
        WHERE ranked_occurrences.occurrenceRank = 1
          AND notes.deleted_at IS NULL
          AND notebooks.deleted_at IS NULL
        ${TAGGED_NOTE_ORDER}
      `,
      [tagId],
    );
  });
}

export async function listTrashRoots() {
  return withRepositoryError("读取回收站", async () => {
    await getNotebookDatabase();
    return listTrashRootsCommand();
  });
}

export async function restoreTrashedItem(itemType: TrashItemType, itemId: number) {
  return withRepositoryError("恢复回收站项目", async () => {
    await getNotebookDatabase();
    return restoreTrashedItemCommand(itemType, itemId);
  });
}

export async function purgeTrashedItem(itemType: TrashItemType, itemId: number) {
  return withRepositoryError("永久删除回收站项目", async () => {
    await getNotebookDatabase();
    await purgeTrashedItemCommand(itemType, itemId);
  });
}

export async function cleanupExpiredTrash() {
  return withRepositoryError("清理过期回收站", async () => {
    await getNotebookDatabase();
    await cleanupExpiredTrashCommand();
  });
}

export async function createTag(name: string, color = DEFAULT_TAG_COLOR) {
  return withRepositoryError("创建标签", async () => {
    const database = await getNotebookDatabase();
    const normalizedName = normalizeTagName(name);
    return createTagRecord(database, normalizedName, color);
  });
}

export async function renameTag(
  id: number,
  name: string,
  color = DEFAULT_TAG_COLOR,
) {
  return withRepositoryError("重命名标签", async () => {
    const database = await getNotebookDatabase();
    const normalizedName = normalizeTagName(name);
    const normalizedColor = normalizeTagColor(color);
    const result = await database.execute(
      `
        UPDATE tags
        SET name = $1, color = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `,
      [normalizedName, normalizedColor, id],
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
    const occurrenceCount = await countTagUsageNoteCountInternal(database, id);

    if (occurrenceCount > 0) {
      throw new RepositoryValidationError(
        buildTagUsageBlockedMessage(occurrenceCount),
      );
    }

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

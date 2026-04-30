import { invoke } from "@tauri-apps/api/core";
import { getNotebookDatabase } from "../notebooks/db";
import type { NoteReviewSchedule, TodayReviewTaskItem } from "./types";

class ReviewValidationError extends Error {}

type TodayReviewTaskRow = TodayReviewTaskItem;

let reviewFeatureReadyPromise: Promise<void> | null = null;

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

  return "sqlite error";
}

function logReviewError(action: string, error: unknown) {
  const rawMessage = getRawErrorMessage(error);
  console.error(
    `[review.repository] ${action}失败 [${classifyDatabaseError(rawMessage)}]`,
    error,
  );
}

function isReviewValidationMessage(message: string) {
  return [
    "目标文件不存在。",
    "系统默认复习计划不存在。",
    "复习日期不能为空。",
    "复习日期不能早于今天。",
    "复习日期无效。",
    "同一文件内的复习日期不能重复。",
  ].includes(message);
}

function toReviewError(action: string, error: unknown) {
  if (error instanceof Error && isReviewValidationMessage(error.message)) {
    return new ReviewValidationError(error.message);
  }

  if (error instanceof ReviewValidationError) {
    return error;
  }

  logReviewError(action, error);
  return new Error(`${action}失败，请稍后重试。`);
}

async function withReviewError<T>(action: string, operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    throw toReviewError(action, error);
  }
}

async function ensureReviewFeatureReadyCommand() {
  return invoke<void>("ensure_review_feature_ready_tx");
}

async function getNoteReviewScheduleCommand(noteId: number) {
  return invoke<NoteReviewSchedule | null>("get_note_review_schedule_tx", {
    noteId,
  });
}

async function cleanupExpiredReviewSchedulesCommand() {
  return invoke<void>("cleanup_expired_review_schedules_tx");
}

async function activateNoteReviewScheduleCommand(noteId: number) {
  return invoke<NoteReviewSchedule>("activate_note_review_schedule_tx", {
    noteId,
  });
}

async function saveNoteReviewScheduleCommand(noteId: number, dates: string[]) {
  return invoke<NoteReviewSchedule>("save_note_review_schedule_tx", {
    noteId,
    dates,
  });
}

async function clearNoteReviewScheduleCommand(noteId: number) {
  return invoke<void>("clear_note_review_schedule_tx", { noteId });
}

async function setNoteReviewScheduleDirtyCommand(
  noteId: number,
  isDirty: boolean,
) {
  return invoke<void>("set_note_review_schedule_dirty_tx", {
    noteId,
    isDirty,
  });
}

function toLocalDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function ensureReviewFeatureReady() {
  await getNotebookDatabase();

  if (!reviewFeatureReadyPromise) {
    reviewFeatureReadyPromise = ensureReviewFeatureReadyCommand().catch((error) => {
      reviewFeatureReadyPromise = null;
      throw error;
    });
  }

  await withReviewError("初始化复习功能", async () => {
    await reviewFeatureReadyPromise;
  });
}

export async function getNoteReviewSchedule(noteId: number) {
  return withReviewError("读取复习计划", async () => {
    await ensureReviewFeatureReady();
    return getNoteReviewScheduleCommand(noteId);
  });
}

export async function cleanupExpiredReviewSchedules() {
  return withReviewError("清理过期复习计划", async () => {
    await ensureReviewFeatureReady();
    await cleanupExpiredReviewSchedulesCommand();
  });
}

export async function activateNoteReviewSchedule(noteId: number) {
  return withReviewError("执行复习计划", async () => {
    await ensureReviewFeatureReady();
    return activateNoteReviewScheduleCommand(noteId);
  });
}

export async function saveNoteReviewSchedule(noteId: number, dates: string[]) {
  return withReviewError("保存复习计划", async () => {
    await ensureReviewFeatureReady();
    return saveNoteReviewScheduleCommand(noteId, dates);
  });
}

export async function clearNoteReviewSchedule(noteId: number) {
  return withReviewError("清空复习计划", async () => {
    await ensureReviewFeatureReady();
    await clearNoteReviewScheduleCommand(noteId);
  });
}

export async function setNoteReviewScheduleDirty(
  noteId: number,
  isDirty: boolean,
) {
  return withReviewError("记录复习计划编辑状态", async () => {
    await ensureReviewFeatureReady();
    await setNoteReviewScheduleDirtyCommand(noteId, isDirty);
  });
}

export async function listTodayReviewTasks() {
  return withReviewError("读取今日复习任务", async () => {
    await ensureReviewFeatureReady();
    const database = await getNotebookDatabase();
    const today = toLocalDateKey(new Date());

    const rows = await database.select<TodayReviewTaskRow[]>(
      `
        WITH RECURSIVE folder_paths AS (
          SELECT
            id,
            notebook_id AS notebookId,
            parent_folder_id AS parentFolderId,
            name,
            name AS folderPath
          FROM folders
          WHERE parent_folder_id IS NULL
            AND deleted_at IS NULL

          UNION ALL

          SELECT
            child.id,
            child.notebook_id AS notebookId,
            child.parent_folder_id AS parentFolderId,
            child.name,
            folder_paths.folderPath || ' / ' || child.name AS folderPath
          FROM folders AS child
          INNER JOIN folder_paths ON folder_paths.id = child.parent_folder_id
          WHERE child.deleted_at IS NULL
        ),
        today_task_notes AS (
          SELECT
            review_tasks.note_id AS noteId,
            MIN(review_tasks.due_date) AS dueDate
          FROM review_tasks
          INNER JOIN note_review_bindings
            ON note_review_bindings.note_id = review_tasks.note_id
           AND note_review_bindings.plan_id = review_tasks.plan_id
          WHERE review_tasks.due_date = $1
          GROUP BY review_tasks.note_id
        )
        SELECT
          today_task_notes.noteId AS noteId,
          notes.notebook_id AS notebookId,
          notes.folder_id AS folderId,
          notes.title AS title,
          notebooks.name AS notebookName,
          CASE
            WHEN notes.folder_id IS NULL THEN '未归档笔记'
            ELSE COALESCE(folder_paths.folderPath, '未归档笔记')
          END AS folderPath,
          today_task_notes.dueDate AS dueDate
        FROM today_task_notes
        INNER JOIN notes ON notes.id = today_task_notes.noteId AND notes.deleted_at IS NULL
        INNER JOIN notebooks ON notebooks.id = notes.notebook_id AND notebooks.deleted_at IS NULL
        LEFT JOIN folder_paths ON folder_paths.id = notes.folder_id
      `,
      [today],
    );

    const collator = new Intl.Collator(["zh-Hans-CN-u-co-pinyin", "zh-CN", "en"], {
      numeric: true,
      sensitivity: "base",
    });

    return [...rows].sort((left, right) => {
      const titleDiff = collator.compare(left.title, right.title);
      if (titleDiff !== 0) {
        return titleDiff;
      }

      return left.noteId - right.noteId;
    });
  });
}

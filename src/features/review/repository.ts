import type Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { getNotebookDatabase } from "../notebooks/db";
import type {
  NoteReviewBinding,
  NoteReviewBindingDetail,
  ReviewCalendarTaskItem,
  ReviewPlan,
  ReviewPlanStep,
  ReviewPlanWithSteps,
  ReviewTask,
} from "./types";

class ReviewValidationError extends Error {}

const MAX_REVIEW_PLAN_NAME_LENGTH = 60;
const MAX_REVIEW_STEPS = 5;

type ReviewTaskRow = Omit<ReviewCalendarTaskItem, "isCompleted"> & {
  isCompleted: number;
};

type ReviewTaskBaseRow = Omit<ReviewTask, "isCompleted"> & {
  isCompleted: number;
};

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
    "目标复习方案不存在。",
    "当前复习方案的步骤数据无效。",
    "绑定复习方案失败，请稍后重试。",
  ].includes(message);
}

function toReviewError(action: string, error: unknown) {
  if (error instanceof Error && isReviewValidationMessage(error.message)) {
    return new ReviewValidationError(error.message);
  }

  if (error instanceof ReviewValidationError) {
    return error;
  }

  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("unique constraint failed: review_plans.name")
  ) {
    return new ReviewValidationError("复习方案名称已存在。");
  }

  logReviewError(action, error);
  return new Error(`${action}失败，请稍后重试。`);
}

async function withReviewError<T>(
  action: string,
  operation: () => Promise<T>,
) {
  try {
    return await operation();
  } catch (error) {
    throw toReviewError(action, error);
  }
}

async function createReviewPlanCommand(name: string, offsets: number[]) {
  return invoke<ReviewPlanWithSteps>("create_review_plan_tx", {
    name,
    offsets,
  });
}

async function bindReviewPlanToNoteCommand(
  noteId: number,
  planId: number,
  startDate: string,
) {
  return invoke<NoteReviewBindingDetail>("bind_review_plan_to_note_tx", {
    noteId,
    planId,
    startDate,
  });
}

async function removeReviewPlanBindingCommand(noteId: number) {
  return invoke<void>("remove_review_plan_binding_tx", { noteId });
}

function normalizeReviewPlanName(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  const length = Array.from(normalized).length;

  if (!normalized) {
    throw new ReviewValidationError("复习方案名称不能为空。");
  }

  if (length > MAX_REVIEW_PLAN_NAME_LENGTH) {
    throw new ReviewValidationError(
      `复习方案名称不能超过${MAX_REVIEW_PLAN_NAME_LENGTH}个字符。`,
    );
  }

  return normalized;
}

function normalizeOffsets(offsets: number[]) {
  if (offsets.length === 0) {
    throw new ReviewValidationError("至少需要设置 1 个复习间隔。");
  }

  if (offsets.length > MAX_REVIEW_STEPS) {
    throw new ReviewValidationError(`一个复习方案最多支持 ${MAX_REVIEW_STEPS} 个间隔。`);
  }

  const normalized = offsets.map((offset) => {
    if (!Number.isInteger(offset)) {
      throw new ReviewValidationError("复习间隔必须是整数天。");
    }

    if (offset < 0) {
      throw new ReviewValidationError("复习间隔不能为负数。");
    }

    return offset;
  });

  const uniqueOffsets = new Set(normalized);

  if (uniqueOffsets.size !== normalized.length) {
    throw new ReviewValidationError("同一个复习方案中的间隔天数不能重复。");
  }

  return [...normalized].sort((left, right) => left - right);
}

function createLocalDate(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  return new Date(year, month - 1, day);
}

function formatLocalDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeStartDate(value: string) {
  const normalized = value.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new ReviewValidationError("起始日期格式不正确。");
  }

  const date = createLocalDate(normalized);

  if (Number.isNaN(date.getTime()) || formatLocalDate(date) !== normalized) {
    throw new ReviewValidationError("起始日期无效。");
  }

  return normalized;
}

function mapReviewTask(row: ReviewTaskBaseRow): ReviewTask {
  return {
    id: row.id,
    noteId: row.noteId,
    planId: row.planId,
    dueDate: row.dueDate,
    stepIndex: row.stepIndex,
    isCompleted: row.isCompleted === 1,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}

function mapReviewCalendarTask(row: ReviewTaskRow): ReviewCalendarTaskItem {
  return {
    ...mapReviewTask(row),
    notebookId: row.notebookId,
    folderId: row.folderId,
    title: row.title,
    notebookName: row.notebookName,
    folderName: row.folderName,
    planName: row.planName,
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
    throw new ReviewValidationError(missingMessage);
  }

  return item;
}

async function ensureNoteExists(database: Database, noteId: number) {
  await selectOne<{ id: number }>(
    database,
    "SELECT id FROM notes WHERE id = $1",
    [noteId],
    "目标文件不存在。",
  );
}

async function fetchReviewPlanById(database: Database, id: number) {
  return selectOne<ReviewPlan>(
    database,
    `
      SELECT
        id,
        name,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM review_plans
      WHERE id = $1
    `,
    [id],
    "目标复习方案不存在。",
  );
}

async function listReviewPlanStepsInternal(database: Database, planId: number) {
  return database.select<ReviewPlanStep[]>(
    `
      SELECT
        id,
        plan_id AS planId,
        step_index AS stepIndex,
        offset_days AS offsetDays
      FROM review_plan_steps
      WHERE plan_id = $1
      ORDER BY step_index ASC, id ASC
    `,
    [planId],
  );
}

async function fetchReviewPlanWithStepsById(database: Database, planId: number) {
  const plan = await fetchReviewPlanById(database, planId);
  const steps = await listReviewPlanStepsInternal(database, planId);

  if (steps.length === 0 || steps.length > MAX_REVIEW_STEPS) {
    throw new ReviewValidationError("当前复习方案的步骤数据无效。");
  }

  return {
    ...plan,
    steps,
  } satisfies ReviewPlanWithSteps;
}

async function fetchBindingRowByNoteId(database: Database, noteId: number) {
  const rows = await database.select<NoteReviewBinding[]>(
    `
      SELECT
        note_id AS noteId,
        plan_id AS planId,
        start_date AS startDate,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM note_review_bindings
      WHERE note_id = $1
      LIMIT 1
    `,
    [noteId],
  );

  return rows[0] ?? null;
}

async function fetchBindingDetailByNoteId(
  database: Database,
  noteId: number,
): Promise<NoteReviewBindingDetail | null> {
  const binding = await fetchBindingRowByNoteId(database, noteId);

  if (!binding) {
    return null;
  }

  const plan = await fetchReviewPlanWithStepsById(database, binding.planId);

  return {
    binding,
    plan,
  };
}

async function fetchReviewTaskById(database: Database, taskId: number) {
  return selectOne<ReviewTaskBaseRow>(
    database,
    `
      SELECT
        id,
        note_id AS noteId,
        plan_id AS planId,
        due_date AS dueDate,
        step_index AS stepIndex,
        is_completed AS isCompleted,
        completed_at AS completedAt,
        created_at AS createdAt
      FROM review_tasks
      WHERE id = $1
    `,
    [taskId],
    "目标复习任务不存在。",
  );
}

export async function listReviewPlans() {
  return withReviewError("读取复习方案", async () => {
    const database = await getNotebookDatabase();
    const plans = await database.select<ReviewPlan[]>(
      `
        SELECT
          id,
          name,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM review_plans
        ORDER BY updated_at DESC, id DESC
      `,
    );

    if (plans.length === 0) {
      return [] as ReviewPlanWithSteps[];
    }

    const allSteps = await database.select<ReviewPlanStep[]>(
      `
        SELECT
          id,
          plan_id AS planId,
          step_index AS stepIndex,
          offset_days AS offsetDays
        FROM review_plan_steps
        ORDER BY plan_id ASC, step_index ASC, id ASC
      `,
    );

    const stepsByPlanId = new Map<number, ReviewPlanStep[]>();

    for (const step of allSteps) {
      const currentSteps = stepsByPlanId.get(step.planId) ?? [];
      currentSteps.push(step);
      stepsByPlanId.set(step.planId, currentSteps);
    }

    return plans.map((plan) => ({
      ...plan,
      steps: stepsByPlanId.get(plan.id) ?? [],
    }));
  });
}

export async function createReviewPlan(name: string, offsets: number[]) {
  return withReviewError("创建复习方案", async () => {
    const normalizedName = normalizeReviewPlanName(name);
    const normalizedOffsets = normalizeOffsets(offsets);
    await getNotebookDatabase();
    return createReviewPlanCommand(normalizedName, normalizedOffsets);
  });
}

export async function renameReviewPlan(id: number, name: string) {
  return withReviewError("重命名复习方案", async () => {
    const database = await getNotebookDatabase();
    const normalizedName = normalizeReviewPlanName(name);
    const result = await database.execute(
      `
        UPDATE review_plans
        SET name = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `,
      [normalizedName, id],
    );

    if (result.rowsAffected === 0) {
      throw new ReviewValidationError("目标复习方案不存在。");
    }

    return fetchReviewPlanWithStepsById(database, id);
  });
}

export async function deleteReviewPlan(id: number) {
  return withReviewError("删除复习方案", async () => {
    const database = await getNotebookDatabase();
    const result = await database.execute(
      "DELETE FROM review_plans WHERE id = $1",
      [id],
    );

    if (result.rowsAffected === 0) {
      throw new ReviewValidationError("目标复习方案不存在。");
    }
  });
}

export async function listReviewPlanSteps(planId: number) {
  return withReviewError("读取复习步骤", async () => {
    const database = await getNotebookDatabase();
    await fetchReviewPlanById(database, planId);
    return listReviewPlanStepsInternal(database, planId);
  });
}

export async function getNoteReviewBinding(noteId: number) {
  return withReviewError("读取复习绑定", async () => {
    const database = await getNotebookDatabase();
    await ensureNoteExists(database, noteId);
    return fetchBindingDetailByNoteId(database, noteId);
  });
}

export async function bindReviewPlanToNote(
  noteId: number,
  planId: number,
  startDate: string,
) {
  return withReviewError("绑定复习方案", async () => {
    const normalizedStartDate = normalizeStartDate(startDate);
    await getNotebookDatabase();
    return bindReviewPlanToNoteCommand(noteId, planId, normalizedStartDate);
  });
}

export async function removeReviewPlanBinding(noteId: number) {
  return withReviewError("移除复习绑定", async () => {
    await getNotebookDatabase();
    await removeReviewPlanBindingCommand(noteId);
  });
}

export async function listReviewTasksByMonth(
  monthStart: string,
  monthEnd: string,
  planId: number | null = null,
) {
  return withReviewError("读取复习任务", async () => {
    const database = await getNotebookDatabase();
    const normalizedMonthStart = normalizeStartDate(monthStart);
    const normalizedMonthEnd = normalizeStartDate(monthEnd);

    const rows = await database.select<ReviewTaskRow[]>(
      `
        SELECT
          review_tasks.id AS id,
          review_tasks.note_id AS noteId,
          review_tasks.plan_id AS planId,
          review_tasks.due_date AS dueDate,
          review_tasks.step_index AS stepIndex,
          review_tasks.is_completed AS isCompleted,
          review_tasks.completed_at AS completedAt,
          review_tasks.created_at AS createdAt,
          notes.notebook_id AS notebookId,
          notes.folder_id AS folderId,
          notes.title AS title,
          notebooks.name AS notebookName,
          folders.name AS folderName,
          review_plans.name AS planName
        FROM review_tasks
        INNER JOIN notes ON notes.id = review_tasks.note_id
        INNER JOIN notebooks ON notebooks.id = notes.notebook_id
        INNER JOIN review_plans ON review_plans.id = review_tasks.plan_id
        LEFT JOIN folders ON folders.id = notes.folder_id
        WHERE review_tasks.due_date >= $1
          AND review_tasks.due_date <= $2
          AND ($3 IS NULL OR review_tasks.plan_id = $3)
        ORDER BY
          review_tasks.due_date ASC,
          review_tasks.is_completed ASC,
          review_tasks.step_index ASC,
          notes.updated_at DESC,
          review_tasks.id ASC
      `,
      [normalizedMonthStart, normalizedMonthEnd, planId],
    );

    return rows.map(mapReviewCalendarTask);
  });
}

export async function setReviewTaskCompleted(taskId: number, completed: boolean) {
  return withReviewError(completed ? "标记复习完成" : "取消复习完成", async () => {
    const database = await getNotebookDatabase();
    const result = await database.execute(
      `
        UPDATE review_tasks
        SET
          is_completed = $1,
          completed_at = CASE WHEN $1 = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
        WHERE id = $2
      `,
      [completed ? 1 : 0, taskId],
    );

    if (result.rowsAffected === 0) {
      throw new ReviewValidationError("目标复习任务不存在。");
    }

    return mapReviewTask(await fetchReviewTaskById(database, taskId));
  });
}

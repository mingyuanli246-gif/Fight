import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteOpenRequest } from "../notebooks/types";
import {
  createReviewPlan,
  deleteReviewPlan,
  listReviewPlans,
  listReviewTasksByMonth,
  renameReviewPlan,
  setReviewTaskCompleted,
} from "./repository";
import type {
  ReviewCalendarTaskItem,
  ReviewPlanWithSteps,
} from "./types";
import styles from "./ReviewCalendarWorkspace.module.css";

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

interface ReviewCalendarWorkspaceProps {
  onOpenNote: (target: Pick<NoteOpenRequest, "noteId" | "notebookId">) => void;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "复习计划操作失败，请稍后重试。";
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function addMonths(date: Date, delta: number) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function getMonthLabel(date: Date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function getCalendarDates(currentMonth: Date) {
  const firstDay = startOfMonth(currentMonth);
  const weekdayOffset = (firstDay.getDay() + 6) % 7;
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - weekdayOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return date;
  });
}

function formatSteps(plan: ReviewPlanWithSteps | null) {
  if (!plan || plan.steps.length === 0) {
    return "暂无步骤";
  }

  return plan.steps
    .map((step) => (step.offsetDays === 0 ? "当天" : `+${step.offsetDays} 天`))
    .join(" / ");
}

function formatTaskPath(task: ReviewCalendarTaskItem) {
  return `${task.notebookName} / ${task.folderName ?? "未归类"}`;
}

function createEmptyOffsetInputs() {
  return ["", "", "", "", ""];
}

export function ReviewCalendarWorkspace({
  onOpenNote,
}: ReviewCalendarWorkspaceProps) {
  const [plans, setPlans] = useState<ReviewPlanWithSteps[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<ReviewCalendarTaskItem[]>([]);
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));
  const [createName, setCreateName] = useState("");
  const [createOffsets, setCreateOffsets] = useState<string[]>(createEmptyOffsetInputs);
  const [renameValue, setRenameValue] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const requestVersionRef = useRef(0);

  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.id === selectedPlanId) ?? null,
    [plans, selectedPlanId],
  );

  const calendarDates = useMemo(
    () => getCalendarDates(currentMonth),
    [currentMonth],
  );

  const tasksByDate = useMemo(() => {
    const map = new Map<string, ReviewCalendarTaskItem[]>();

    for (const task of tasks) {
      const currentTasks = map.get(task.dueDate) ?? [];
      currentTasks.push(task);
      map.set(task.dueDate, currentTasks);
    }

    return map;
  }, [tasks]);

  async function refreshPlans(preferredPlanId?: number | null) {
    const nextPlans = await listReviewPlans();
    setPlans(nextPlans);

    const nextSelectedPlanId =
      preferredPlanId === undefined
        ? nextPlans.some((plan) => plan.id === selectedPlanId)
          ? selectedPlanId
          : (nextPlans[0]?.id ?? null)
        : preferredPlanId !== null &&
            nextPlans.some((plan) => plan.id === preferredPlanId)
          ? preferredPlanId
          : (nextPlans[0]?.id ?? null);

    setSelectedPlanId(nextSelectedPlanId);
    setIsConfirmingDelete(false);
    return nextSelectedPlanId;
  }

  useEffect(() => {
    void (async () => {
      setErrorMessage(null);
      setIsInitializing(true);

      try {
        await refreshPlans();
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
        setPlans([]);
        setSelectedPlanId(null);
        setTasks([]);
      } finally {
        setIsInitializing(false);
      }
    })();
  }, []);

  useEffect(() => {
    setRenameValue(selectedPlan?.name ?? "");
    setIsConfirmingDelete(false);
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;

    if (selectedPlanId === null) {
      setTasks([]);
      setIsLoadingTasks(false);
      return;
    }

    setIsLoadingTasks(true);

    void (async () => {
      try {
        const nextTasks = await listReviewTasksByMonth(
          toDateKey(startOfMonth(currentMonth)),
          toDateKey(endOfMonth(currentMonth)),
          selectedPlanId,
        );

        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTasks(nextTasks);
      } catch (error) {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setTasks([]);
        setErrorMessage(getErrorMessage(error));
      } finally {
        if (requestVersion === requestVersionRef.current) {
          setIsLoadingTasks(false);
        }
      }
    })();
  }, [currentMonth, selectedPlan, selectedPlanId]);

  async function runMutation(operation: () => Promise<void>) {
    setErrorMessage(null);
    setIsBusy(true);

    try {
      await operation();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
      throw error;
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreatePlan() {
    return runMutation(async () => {
      const offsets = createOffsets
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => Number(value));
      const createdPlan = await createReviewPlan(createName, offsets);
      setCreateName("");
      setCreateOffsets(createEmptyOffsetInputs());
      await refreshPlans(createdPlan.id);
    });
  }

  async function handleRenamePlan() {
    if (selectedPlanId === null) {
      return;
    }

    return runMutation(async () => {
      await renameReviewPlan(selectedPlanId, renameValue);
      await refreshPlans(selectedPlanId);
    });
  }

  async function handleDeletePlan() {
    if (selectedPlanId === null) {
      return;
    }

    return runMutation(async () => {
      await deleteReviewPlan(selectedPlanId);
      await refreshPlans(null);
    });
  }

  async function handleToggleTask(task: ReviewCalendarTaskItem) {
    setErrorMessage(null);

    try {
      const updatedTask = await setReviewTaskCompleted(task.id, !task.isCompleted);
      setTasks((currentTasks) =>
        currentTasks.map((currentTask) =>
          currentTask.id === updatedTask.id
            ? {
                ...currentTask,
                isCompleted: updatedTask.isCompleted,
                completedAt: updatedTask.completedAt,
              }
            : currentTask,
        ),
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }

  if (isInitializing) {
    return (
      <div className={styles.statusCard}>
        <strong className={styles.statusTitle}>正在读取复习日历</strong>
        <p className={styles.statusText}>正在载入复习方案与日历任务。</p>
      </div>
    );
  }

  return (
    <>
      {errorMessage ? (
        <div className={styles.errorBanner}>
          <div>
            <p className={styles.errorTitle}>复习计划操作失败</p>
            <p className={styles.errorText}>{errorMessage}</p>
          </div>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setErrorMessage(null)}
          >
            关闭提示
          </button>
        </div>
      ) : null}

      <div className={styles.workspace}>
        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <div>
              <h3 className={styles.panelTitle}>复习方案</h3>
              <p className={styles.panelDescription}>
                创建、选择并管理当前阶段的复习步骤。
              </p>
            </div>
          </header>

          <div className={styles.panelBody}>
            <section className={styles.actionCard}>
              <h4 className={styles.cardTitle}>创建方案</h4>
              <div className={styles.form}>
                <input
                  type="text"
                  className={styles.input}
                  value={createName}
                  onChange={(event) => setCreateName(event.currentTarget.value)}
                  placeholder="输入复习方案名称"
                  maxLength={60}
                  disabled={isBusy}
                />
                <div className={styles.offsetGrid}>
                  {createOffsets.map((value, index) => (
                    <input
                      key={index}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      className={styles.input}
                      value={value}
                      onChange={(event) => {
                        const nextOffsets = [...createOffsets];
                        nextOffsets[index] = event.currentTarget.value;
                        setCreateOffsets(nextOffsets);
                      }}
                      placeholder={`第 ${index + 1} 步天数`}
                      disabled={isBusy}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className={styles.actionButton}
                  onClick={() => {
                    void handleCreatePlan().catch(() => undefined);
                  }}
                  disabled={isBusy}
                >
                  创建复习方案
                </button>
              </div>
            </section>

            {plans.length === 0 ? (
              <div className={styles.emptyBlock}>
                <p className={styles.emptyTitle}>还没有任何复习方案</p>
                <p className={styles.emptyText}>
                  先创建一个方案，之后就可以在文件正文区把它绑定到具体 note。
                </p>
              </div>
            ) : (
              <ul className={styles.planList}>
                {plans.map((plan) => (
                  <li key={plan.id}>
                    <button
                      type="button"
                      className={`${styles.planItem} ${
                        selectedPlanId === plan.id ? styles.planItemActive : ""
                      }`}
                      onClick={() => {
                        setErrorMessage(null);
                        setSelectedPlanId(plan.id);
                      }}
                      disabled={isBusy}
                    >
                      <span className={styles.planTitle}>{plan.name}</span>
                      <span className={styles.planMeta}>{formatSteps(plan)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {selectedPlan ? (
              <section className={styles.actionCard}>
                <h4 className={styles.cardTitle}>当前方案管理</h4>
                <div className={styles.form}>
                  <input
                    type="text"
                    className={styles.input}
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.currentTarget.value)}
                    placeholder="输入新的方案名称"
                    maxLength={60}
                    disabled={isBusy}
                  />
                  <div className={styles.previewBlock}>
                    <p className={styles.previewLabel}>步骤预览</p>
                    <p className={styles.previewText}>{formatSteps(selectedPlan)}</p>
                  </div>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() => {
                      void handleRenamePlan().catch(() => undefined);
                    }}
                    disabled={isBusy}
                  >
                    保存名称
                  </button>
                </div>

                {!isConfirmingDelete ? (
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => setIsConfirmingDelete(true)}
                    disabled={isBusy}
                  >
                    删除方案
                  </button>
                ) : (
                  <div className={styles.confirmBox}>
                    <p className={styles.confirmText}>
                      确认删除“{selectedPlan.name}”吗？这会清理该方案的绑定与任务。
                    </p>
                    <div className={styles.actionRow}>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => setIsConfirmingDelete(false)}
                        disabled={isBusy}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className={styles.dangerButton}
                        onClick={() => {
                          void handleDeletePlan().catch(() => undefined);
                        }}
                        disabled={isBusy}
                      >
                        确认删除
                      </button>
                    </div>
                  </div>
                )}
              </section>
            ) : null}
          </div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <div>
              <h3 className={styles.panelTitle}>月历视图</h3>
              <p className={styles.panelDescription}>
                查看当前方案在本月需要复习的文件，并直接打开或标记完成。
              </p>
            </div>
            <div className={styles.monthActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setCurrentMonth((value) => addMonths(value, -1))}
              >
                上月
              </button>
              <strong className={styles.monthLabel}>{getMonthLabel(currentMonth)}</strong>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setCurrentMonth((value) => addMonths(value, 1))}
              >
                下月
              </button>
            </div>
          </header>

          <div className={styles.panelBody}>
            {selectedPlan === null ? (
              <div className={styles.emptyBlock}>
                <p className={styles.emptyTitle}>先创建并选择一个复习方案</p>
                <p className={styles.emptyText}>
                  选中方案后，这里会按月展示需要复习的文件任务。
                </p>
              </div>
            ) : (
              <>
                <div className={styles.calendarLegend}>
                  {isLoadingTasks ? (
                    <span className={styles.legendText}>正在读取本月任务…</span>
                  ) : tasks.length === 0 ? (
                    <span className={styles.legendText}>本月没有复习任务</span>
                  ) : (
                    <span className={styles.legendText}>
                      本月共有 {tasks.length} 条复习任务
                    </span>
                  )}
                </div>

                <div className={styles.calendarGrid}>
                  {WEEKDAY_LABELS.map((label) => (
                    <div key={label} className={styles.weekdayCell}>
                      {label}
                    </div>
                  ))}

                  {calendarDates.map((date) => {
                    const dateKey = toDateKey(date);
                    const dateTasks = tasksByDate.get(dateKey) ?? [];
                    const isOutsideMonth =
                      date.getMonth() !== currentMonth.getMonth();

                    return (
                      <div
                        key={dateKey}
                        className={`${styles.dayCell} ${
                          isOutsideMonth ? styles.dayCellMuted : ""
                        }`}
                      >
                        <div className={styles.dayHeader}>
                          <span className={styles.dayNumber}>{date.getDate()}</span>
                        </div>
                        <div className={styles.dayTasks}>
                          {dateTasks.map((task) => (
                            <article
                              key={task.id}
                              className={`${styles.taskCard} ${
                                task.isCompleted ? styles.taskCardCompleted : ""
                              }`}
                            >
                              <button
                                type="button"
                                className={styles.taskTitleButton}
                                onClick={() =>
                                  onOpenNote({
                                    noteId: task.noteId,
                                    notebookId: task.notebookId,
                                  })
                                }
                              >
                                {task.title}
                              </button>
                              <p className={styles.taskPath}>{formatTaskPath(task)}</p>
                              <div className={styles.taskActions}>
                                <span className={styles.taskStatus}>
                                  {task.isCompleted ? "已完成" : "待完成"}
                                </span>
                                <button
                                  type="button"
                                  className={styles.taskToggleButton}
                                  onClick={() => {
                                    void handleToggleTask(task);
                                  }}
                                >
                                  {task.isCompleted ? "取消完成" : "完成"}
                                </button>
                              </div>
                            </article>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

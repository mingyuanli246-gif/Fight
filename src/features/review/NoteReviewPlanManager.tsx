import { useEffect, useMemo, useRef, useState } from "react";
import {
  bindReviewPlanToNote,
  getNoteReviewBinding,
  listReviewPlans,
  removeReviewPlanBinding,
} from "./repository";
import type { NoteReviewBindingDetail, ReviewPlanWithSteps } from "./types";
import styles from "./NoteReviewPlanManager.module.css";

interface NoteReviewPlanManagerProps {
  noteId: number;
  disabled: boolean;
  onError: (message: string) => void;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "复习计划操作失败，请稍后重试。";
}

function getTodayDateKey() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatSteps(plan: ReviewPlanWithSteps | null) {
  if (!plan || plan.steps.length === 0) {
    return "暂无步骤";
  }

  return plan.steps
    .map((step) => (step.offsetDays === 0 ? "当天" : `+${step.offsetDays} 天`))
    .join(" / ");
}

export function NoteReviewPlanManager({
  noteId,
  disabled,
  onError,
}: NoteReviewPlanManagerProps) {
  const [plans, setPlans] = useState<ReviewPlanWithSteps[]>([]);
  const [bindingDetail, setBindingDetail] = useState<NoteReviewBindingDetail | null>(
    null,
  );
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(getTodayDateKey());
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);
  const requestVersionRef = useRef(0);
  const activeNoteIdRef = useRef(noteId);

  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.id === selectedPlanId) ?? null,
    [plans, selectedPlanId],
  );

  const isCurrentBinding =
    bindingDetail !== null &&
    bindingDetail.binding.planId === selectedPlanId &&
    bindingDetail.binding.startDate === startDate;

  useEffect(() => {
    activeNoteIdRef.current = noteId;
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;
    setIsLoading(true);
    setIsConfirmingRemove(false);

    void (async () => {
      try {
        const [nextPlans, nextBinding] = await Promise.all([
          listReviewPlans(),
          getNoteReviewBinding(noteId),
        ]);

        if (
          requestVersion !== requestVersionRef.current ||
          activeNoteIdRef.current !== noteId
        ) {
          return;
        }

        setPlans(nextPlans);
        setBindingDetail(nextBinding);

        if (nextBinding) {
          setSelectedPlanId(nextBinding.plan.id);
          setStartDate(nextBinding.binding.startDate);
        } else {
          setSelectedPlanId(nextPlans[0]?.id ?? null);
          setStartDate(getTodayDateKey());
        }
      } catch (error) {
        if (
          requestVersion !== requestVersionRef.current ||
          activeNoteIdRef.current !== noteId
        ) {
          return;
        }

        setPlans([]);
        setBindingDetail(null);
        setSelectedPlanId(null);
        setStartDate(getTodayDateKey());
        onError(getErrorMessage(error));
      } finally {
        if (
          requestVersion === requestVersionRef.current &&
          activeNoteIdRef.current === noteId
        ) {
          setIsLoading(false);
        }
      }
    })();
  }, [noteId, onError]);

  async function handleBind() {
    if (disabled || isBusy || selectedPlanId === null) {
      return;
    }

    const expectedNoteId = noteId;
    setIsBusy(true);

    try {
      const nextBinding = await bindReviewPlanToNote(
        expectedNoteId,
        selectedPlanId,
        startDate,
      );

      if (activeNoteIdRef.current !== expectedNoteId) {
        return;
      }

      setBindingDetail(nextBinding);
      setSelectedPlanId(nextBinding.plan.id);
      setStartDate(nextBinding.binding.startDate);
      setIsConfirmingRemove(false);
    } catch (error) {
      if (activeNoteIdRef.current === expectedNoteId) {
        onError(getErrorMessage(error));
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRemoveBinding() {
    if (disabled || isBusy) {
      return;
    }

    const expectedNoteId = noteId;
    setIsBusy(true);

    try {
      await removeReviewPlanBinding(expectedNoteId);

      if (activeNoteIdRef.current !== expectedNoteId) {
        return;
      }

      setBindingDetail(null);
      setStartDate(getTodayDateKey());
      setSelectedPlanId((current) =>
        current !== null && plans.some((plan) => plan.id === current)
          ? current
          : (plans[0]?.id ?? null),
      );
      setIsConfirmingRemove(false);
    } catch (error) {
      if (activeNoteIdRef.current === expectedNoteId) {
        onError(getErrorMessage(error));
      }
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className={styles.manager}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>复习计划</p>
          <p className={styles.hint}>
            为当前文件绑定一个复习方案，并按本地日历日自动生成任务。
          </p>
        </div>
      </div>

      {isLoading ? (
        <p className={styles.stateText}>正在读取复习方案…</p>
      ) : plans.length === 0 ? (
        <div className={styles.emptyBlock}>
          <p className={styles.stateTitle}>还没有任何复习方案</p>
          <p className={styles.stateText}>
            请先到“复习日历”页面创建方案，然后再给当前文件绑定。
          </p>
        </div>
      ) : (
        <>
          <div className={styles.currentBlock}>
            <p className={styles.currentLabel}>当前绑定</p>
            {bindingDetail ? (
              <>
                <p className={styles.currentTitle}>{bindingDetail.plan.name}</p>
                <p className={styles.currentMeta}>
                  起始日期：{bindingDetail.binding.startDate}
                </p>
                <p className={styles.currentMeta}>
                  复习节奏：{formatSteps(bindingDetail.plan)}
                </p>
              </>
            ) : (
              <p className={styles.stateText}>当前文件还没有绑定复习方案。</p>
            )}
          </div>

          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>方案</span>
              <select
                className={styles.select}
                value={selectedPlanId ?? ""}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setSelectedPlanId(nextValue ? Number(nextValue) : null);
                  setIsConfirmingRemove(false);
                }}
                disabled={disabled || isBusy}
              >
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>起始日期</span>
              <input
                type="date"
                className={styles.input}
                value={startDate}
                onChange={(event) => setStartDate(event.currentTarget.value)}
                disabled={disabled || isBusy}
              />
            </label>
          </div>

          <div className={styles.previewBlock}>
            <p className={styles.fieldLabel}>方案预览</p>
            <p className={styles.stateText}>{formatSteps(selectedPlan)}</p>
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.actionButton}
              onClick={() => {
                void handleBind();
              }}
              disabled={disabled || isBusy || selectedPlanId === null || isCurrentBinding}
            >
              {bindingDetail === null
                ? "绑定方案"
                : isCurrentBinding
                  ? "当前方案已生效"
                  : "替换方案"}
            </button>
          </div>

          {bindingDetail ? (
            !isConfirmingRemove ? (
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => setIsConfirmingRemove(true)}
                disabled={disabled || isBusy}
              >
                移除绑定
              </button>
            ) : (
              <div className={styles.confirmBox}>
                <p className={styles.confirmText}>
                  确认移除当前复习绑定吗？未完成任务会被清理，已完成历史会保留。
                </p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => setIsConfirmingRemove(false)}
                    disabled={disabled || isBusy}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => {
                      void handleRemoveBinding();
                    }}
                    disabled={disabled || isBusy}
                  >
                    确认移除
                  </button>
                </div>
              </div>
            )
          ) : null}
        </>
      )}
    </section>
  );
}

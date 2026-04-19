import {
  useCallback,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  activateNoteReviewSchedule,
  clearNoteReviewSchedule,
  getNoteReviewSchedule,
  saveNoteReviewSchedule,
  setNoteReviewScheduleDirty,
} from "./repository";
import type { NoteReviewSchedule } from "./types";
import styles from "./NoteReviewPlanManager.module.css";

interface NoteReviewPlanManagerProps {
  noteId: number;
  disabled: boolean;
  onError: (message: string) => void;
}

interface DateEditDraft {
  year: string;
  month: string;
  day: string;
}

export interface NoteReviewPlanManagerRef {
  hasUnsavedChanges: () => boolean;
  savePendingChanges: () => Promise<boolean>;
}

const EMPTY_REVIEW_DATES: string[] = [];

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

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatDisplayDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${year}/${month}/${day}`;
}

function splitDateKey(value: string): DateEditDraft {
  const [year = "", month = "", day = ""] = value.split("-");
  return { year, month, day };
}

function stripDigits(value: string, maxLength: number) {
  return value.replace(/\D/g, "").slice(0, maxLength);
}

function isValidDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map((part) => Number(part));
  const date = new Date(year, month - 1, day);

  return (
    Number.isFinite(date.getTime()) &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function validateDateKey(value: string, existingDates: string[], originalValue?: string) {
  if (!isValidDateKey(value)) {
    return "请输入有效日期。";
  }

  if (value < getTodayDateKey()) {
    return "复习日期不能早于今天。";
  }

  const duplicateDates = existingDates.filter((date) => date === value);
  const allowedDuplicates = originalValue === value ? 1 : 0;

  if (duplicateDates.length > allowedDuplicates) {
    return "同一文件内的复习日期不能重复。";
  }

  return null;
}

function toSortedDates(dates: string[]) {
  return [...dates].sort((left, right) => left.localeCompare(right));
}

export const NoteReviewPlanManager = forwardRef<
  NoteReviewPlanManagerRef,
  NoteReviewPlanManagerProps
>(function NoteReviewPlanManager(
  { noteId, disabled, onError },
  ref,
) {
  const [savedSchedule, setSavedSchedule] = useState<NoteReviewSchedule | null>(null);
  const [draftDates, setDraftDates] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<DateEditDraft | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const requestVersionRef = useRef(0);
  const activeNoteIdRef = useRef(noteId);
  const hasLoadedRef = useRef(false);
  const lastDirtyRef = useRef(false);

  const savedDates = savedSchedule?.dates ?? EMPTY_REVIEW_DATES;
  const isDirty = useMemo(
    () => !arraysEqual(savedDates, draftDates),
    [draftDates, savedDates],
  );
  const isScheduleActive = savedSchedule !== null;

  const loadSchedule = useCallback(async (expectedNoteId: number, requestVersion: number) => {
    try {
      const nextSchedule = await getNoteReviewSchedule(expectedNoteId);

      if (
        activeNoteIdRef.current !== expectedNoteId ||
        requestVersion !== requestVersionRef.current
      ) {
        return;
      }

      setSavedSchedule(nextSchedule);
      setDraftDates(nextSchedule?.dates ?? []);
      setSelectedIndex(null);
      setEditingIndex(null);
      setEditDraft(null);
      setErrorMessage(null);
      hasLoadedRef.current = true;
      lastDirtyRef.current = false;
    } catch (error) {
      if (
        activeNoteIdRef.current !== expectedNoteId ||
        requestVersion !== requestVersionRef.current
      ) {
        return;
      }

      setSavedSchedule(null);
      setDraftDates([]);
      setSelectedIndex(null);
      setEditingIndex(null);
      setEditDraft(null);
      setErrorMessage(getErrorMessage(error));
      hasLoadedRef.current = true;
      lastDirtyRef.current = false;
      onError(getErrorMessage(error));
    } finally {
      if (
        activeNoteIdRef.current === expectedNoteId &&
        requestVersion === requestVersionRef.current
      ) {
        setIsLoading(false);
      }
    }
  }, [onError]);

  useEffect(() => {
    activeNoteIdRef.current = noteId;
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;
    hasLoadedRef.current = false;
    setIsLoading(true);
    setIsBusy(false);
    setErrorMessage(null);
    setSelectedIndex(null);
    setEditingIndex(null);
    setEditDraft(null);
    setSavedSchedule(null);
    setDraftDates([]);
    void loadSchedule(noteId, requestVersion);
  }, [loadSchedule, noteId]);

  useEffect(() => {
    if (!hasLoadedRef.current) {
      return;
    }

    if (lastDirtyRef.current === isDirty) {
      return;
    }

    lastDirtyRef.current = isDirty;
    void setNoteReviewScheduleDirty(noteId, isDirty).catch((error) => {
      if (activeNoteIdRef.current !== noteId) {
        return;
      }

      onError(getErrorMessage(error));
    });
  }, [isDirty, noteId, onError]);

  async function handleActivate() {
    if (disabled || isBusy || isScheduleActive) {
      return;
    }

    const expectedNoteId = noteId;
    setIsBusy(true);
    setErrorMessage(null);

    try {
      const schedule = await activateNoteReviewSchedule(expectedNoteId);

      if (activeNoteIdRef.current !== expectedNoteId) {
        return;
      }

      setSavedSchedule(schedule);
      setDraftDates(schedule.dates);
      setSelectedIndex(null);
      setEditingIndex(null);
      setEditDraft(null);
      lastDirtyRef.current = false;
    } catch (error) {
      if (activeNoteIdRef.current === expectedNoteId) {
        const message = getErrorMessage(error);
        setErrorMessage(message);
        onError(message);
      }
    } finally {
      if (activeNoteIdRef.current === expectedNoteId) {
        setIsBusy(false);
      }
    }
  }

  function startEditingDate(index: number) {
    const dateValue = draftDates[index];

    if (!dateValue) {
      return;
    }

    setSelectedIndex(index);
    setEditingIndex(index);
    setEditDraft(splitDateKey(dateValue));
    setErrorMessage(null);
  }

  function handleSelect(index: number) {
    if (editingIndex !== null) {
      return;
    }

    setSelectedIndex(index);
    setErrorMessage(null);
  }

  function updateEditDraft(part: keyof DateEditDraft, value: string) {
    setEditDraft((current) =>
      current
        ? {
            ...current,
            [part]: stripDigits(value, part === "year" ? 4 : 2),
          }
        : current,
    );
  }

  function stopEditing() {
    setEditingIndex(null);
    setEditDraft(null);
  }

  function commitDateEdit() {
    if (editingIndex === null || editDraft === null) {
      return draftDates;
    }

    if (
      editDraft.year.length !== 4 ||
      editDraft.month.length !== 2 ||
      editDraft.day.length !== 2
    ) {
      setErrorMessage("请补全日期。");
      return null;
    }

    const nextDate = `${editDraft.year.padStart(4, "0")}-${editDraft.month.padStart(
      2,
      "0",
    )}-${editDraft.day.padStart(2, "0")}`;
    const originalValue = draftDates[editingIndex];
    const validationMessage = validateDateKey(nextDate, draftDates, originalValue);

    if (validationMessage) {
      setErrorMessage(validationMessage);
      return null;
    }

    const nextDates = [...draftDates];
    nextDates.splice(editingIndex, 1, nextDate);
    const sortedDates = toSortedDates(nextDates);
    setDraftDates(sortedDates);
    setSelectedIndex(sortedDates.indexOf(nextDate));
    stopEditing();
    setErrorMessage(null);
    return sortedDates;
  }

  function handleAddDate() {
    if (disabled || isBusy || !isScheduleActive || editingIndex !== null) {
      return;
    }

    const nextDates = [...draftDates, getTodayDateKey()];
    setDraftDates(nextDates);
    setSelectedIndex(nextDates.length - 1);
    setEditingIndex(nextDates.length - 1);
    setEditDraft(splitDateKey(getTodayDateKey()));
    setErrorMessage(null);
  }

  async function handleDeleteDate() {
    if (
      disabled ||
      isBusy ||
      !isScheduleActive ||
      editingIndex !== null ||
      selectedIndex === null ||
      !draftDates[selectedIndex]
    ) {
      return;
    }

    const nextDates = draftDates.filter((_, index) => index !== selectedIndex);

    if (nextDates.length === 0) {
      const expectedNoteId = noteId;
      setIsBusy(true);
      setErrorMessage(null);

      try {
        await clearNoteReviewSchedule(expectedNoteId);

        if (activeNoteIdRef.current !== expectedNoteId) {
          return;
        }

        setSavedSchedule(null);
        setDraftDates([]);
        setSelectedIndex(null);
        setEditingIndex(null);
        setEditDraft(null);
        lastDirtyRef.current = false;
      } catch (error) {
        if (activeNoteIdRef.current === expectedNoteId) {
          const message = getErrorMessage(error);
          setErrorMessage(message);
          onError(message);
        }
      } finally {
        if (activeNoteIdRef.current === expectedNoteId) {
          setIsBusy(false);
        }
      }

      return;
    }

    setDraftDates(nextDates);
    setSelectedIndex(Math.min(selectedIndex, nextDates.length - 1));
    stopEditing();
    setErrorMessage(null);
  }

  async function savePendingChanges() {
    if (!isDirty) {
      return true;
    }

    if (!isScheduleActive) {
      return true;
    }

    let nextDates = draftDates;

    if (editingIndex !== null) {
      const committedDates = commitDateEdit();

      if (!committedDates) {
        return false;
      }

      nextDates = committedDates;
    }

    const expectedNoteId = noteId;
    setIsBusy(true);
    setErrorMessage(null);

    try {
      const schedule = await saveNoteReviewSchedule(expectedNoteId, nextDates);

      if (activeNoteIdRef.current !== expectedNoteId) {
        return false;
      }

      setSavedSchedule(schedule);
      setDraftDates(schedule.dates);
      setSelectedIndex(null);
      setEditingIndex(null);
      setEditDraft(null);
      lastDirtyRef.current = false;
      return true;
    } catch (error) {
      if (activeNoteIdRef.current === expectedNoteId) {
        const message = getErrorMessage(error);
        setErrorMessage(message);
        onError(message);
      }

      return false;
    } finally {
      if (activeNoteIdRef.current === expectedNoteId) {
        setIsBusy(false);
      }
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      hasUnsavedChanges: () => isDirty,
      savePendingChanges,
    }),
  );

  return (
    <section className={styles.manager}>
      <div className={styles.header}>
        <div className={styles.headerTop}>
          {isDirty ? (
            <button
              type="button"
              className={styles.saveButton}
              onClick={() => {
                void savePendingChanges();
              }}
              disabled={disabled || isBusy}
            >
              保存
            </button>
          ) : null}
          <div>
            <p className={styles.label}>复习计划</p>
            <p className={styles.hint}>每个文件独立维护自己的复习日期，默认按第 2 / 5 / 10 / 18 天生成。</p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className={styles.stateText}>正在读取复习计划…</p>
      ) : !isScheduleActive ? (
        <div className={styles.emptyBlock}>
          <p className={styles.stateTitle}>当前文件还没有执行复习计划</p>
          <button
            type="button"
            className={styles.activateButton}
            onClick={() => {
              void handleActivate();
            }}
            disabled={disabled || isBusy}
          >
            执行复习计划
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className={styles.activateButtonDisabled}
            disabled
          >
            执行复习计划
          </button>

          <div className={styles.listBlock}>
            <ul className={styles.dateList}>
              {draftDates.map((dateValue, index) => {
                const isSelected = selectedIndex === index;
                const isEditing = editingIndex === index && editDraft !== null;

                return (
                  <li key={`${dateValue}-${index}`} className={styles.dateListItem}>
                    {isEditing ? (
                      <div className={`${styles.dateRow} ${styles.dateRowEditing}`}>
                        <input
                          type="text"
                          inputMode="numeric"
                          className={styles.dateInputYear}
                          value={editDraft.year}
                          onChange={(event) =>
                            updateEditDraft("year", event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitDateEdit();
                            }

                            if (event.key === "Escape") {
                              event.preventDefault();
                              stopEditing();
                            }
                          }}
                          autoFocus
                        />
                        <span className={styles.dateSeparator}>/</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          className={styles.dateInput}
                          value={editDraft.month}
                          onChange={(event) =>
                            updateEditDraft("month", event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitDateEdit();
                            }

                            if (event.key === "Escape") {
                              event.preventDefault();
                              stopEditing();
                            }
                          }}
                        />
                        <span className={styles.dateSeparator}>/</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          className={styles.dateInput}
                          value={editDraft.day}
                          onChange={(event) =>
                            updateEditDraft("day", event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitDateEdit();
                            }

                            if (event.key === "Escape") {
                              event.preventDefault();
                              stopEditing();
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={`${styles.dateRow} ${
                          isSelected ? styles.dateRowSelected : ""
                        }`}
                        onClick={() => handleSelect(index)}
                        onDoubleClick={() => startEditingDate(index)}
                        disabled={disabled || isBusy}
                      >
                        {formatDisplayDate(dateValue)}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.circleButton}
                onClick={handleAddDate}
                disabled={disabled || isBusy || editingIndex !== null}
                aria-label="新增复习日期"
              >
                ➕
              </button>
              <button
                type="button"
                className={styles.circleButton}
                onClick={() => {
                  void handleDeleteDate();
                }}
                disabled={disabled || isBusy || selectedIndex === null || editingIndex !== null}
                aria-label="删除选中复习日期"
              >
                ➖
              </button>
            </div>
          </div>
        </>
      )}

      {errorMessage ? <p className={styles.errorText}>{errorMessage}</p> : null}
    </section>
  );
});

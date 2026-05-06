export type NotebookLeaveReason =
  | "section-change"
  | "window-close"
  | "before-unload"
  | "restore-backup";

export function shouldPromptReviewScheduleSave(reason: NotebookLeaveReason) {
  return (
    reason === "section-change" ||
    reason === "restore-backup" ||
    reason === "window-close" ||
    reason === "before-unload"
  );
}

interface NotebookUnsavedChangesOptions {
  hasNoteContentUnsavedChanges: boolean;
  hasReviewScheduleUnsavedChanges: boolean;
  reason?: NotebookLeaveReason;
}

export function hasNotebookUnsavedChanges({
  hasNoteContentUnsavedChanges,
  hasReviewScheduleUnsavedChanges,
  reason = "section-change",
}: NotebookUnsavedChangesOptions) {
  if (hasNoteContentUnsavedChanges) {
    return true;
  }

  return shouldPromptReviewScheduleSave(reason) && hasReviewScheduleUnsavedChanges;
}

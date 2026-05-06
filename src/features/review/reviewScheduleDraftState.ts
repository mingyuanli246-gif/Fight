function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface DiscardedReviewScheduleState {
  draftDates: string[];
  selectedIndex: null;
  editSession: null;
  editDraft: null;
  errorMessage: null;
  shouldClearPersistedDirty: boolean;
}

export function buildDiscardedReviewScheduleState(
  savedDates: string[],
  draftDates: string[],
): DiscardedReviewScheduleState {
  return {
    draftDates: [...savedDates],
    selectedIndex: null,
    editSession: null,
    editDraft: null,
    errorMessage: null,
    shouldClearPersistedDirty: !arraysEqual(savedDates, draftDates),
  };
}

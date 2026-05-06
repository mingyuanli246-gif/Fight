// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import {
  hasNotebookUnsavedChanges,
  shouldPromptReviewScheduleSave,
} from "./leaveProtection.ts";

test("window-close treats review schedule edits as unsaved changes", () => {
  assert.equal(shouldPromptReviewScheduleSave("window-close"), true);
  assert.equal(
    hasNotebookUnsavedChanges({
      hasNoteContentUnsavedChanges: false,
      hasReviewScheduleUnsavedChanges: true,
      reason: "window-close",
    }),
    true,
  );
});

test("before-unload treats review schedule edits as unsaved changes", () => {
  assert.equal(shouldPromptReviewScheduleSave("before-unload"), true);
  assert.equal(
    hasNotebookUnsavedChanges({
      hasNoteContentUnsavedChanges: false,
      hasReviewScheduleUnsavedChanges: true,
      reason: "before-unload",
    }),
    true,
  );
});

test("note content unsaved protection still wins for every leave reason", () => {
  assert.equal(
    hasNotebookUnsavedChanges({
      hasNoteContentUnsavedChanges: true,
      hasReviewScheduleUnsavedChanges: false,
      reason: "window-close",
    }),
    true,
  );
  assert.equal(
    hasNotebookUnsavedChanges({
      hasNoteContentUnsavedChanges: true,
      hasReviewScheduleUnsavedChanges: false,
      reason: "before-unload",
    }),
    true,
  );
});

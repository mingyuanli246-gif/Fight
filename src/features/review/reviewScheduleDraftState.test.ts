// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { buildDiscardedReviewScheduleState } from "./reviewScheduleDraftState.ts";

test("discard keeps the last saved custom review schedule", () => {
  const result = buildDiscardedReviewScheduleState(
    ["2099-08-01", "2099-08-09"],
    ["2099-08-03", "2099-08-11"],
  );

  assert.deepEqual(result.draftDates, ["2099-08-01", "2099-08-09"]);
  assert.equal(result.shouldClearPersistedDirty, true);
  assert.equal(result.selectedIndex, null);
  assert.equal(result.editSession, null);
  assert.equal(result.editDraft, null);
  assert.equal(result.errorMessage, null);
});

test("discard does not request a backend dirty reset for transient-only edits", () => {
  const result = buildDiscardedReviewScheduleState(
    ["2099-08-01", "2099-08-09"],
    ["2099-08-01", "2099-08-09"],
  );

  assert.equal(result.shouldClearPersistedDirty, false);
});

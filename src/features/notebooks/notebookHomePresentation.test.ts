import test from "node:test";
import assert from "node:assert/strict";

import {
  formatNotebookUpdatedLabel,
  getNotebookCoverTheme,
  groupNotebookNoteCounts,
} from "./notebookHomePresentation.ts";

test("cover theme rotates through the five built-in themes by index", () => {
  assert.equal(getNotebookCoverTheme(0).key, "blue");
  assert.equal(getNotebookCoverTheme(1).key, "purple");
  assert.equal(getNotebookCoverTheme(2).key, "pink");
  assert.equal(getNotebookCoverTheme(3).key, "yellow");
  assert.equal(getNotebookCoverTheme(4).key, "green");
  assert.equal(getNotebookCoverTheme(5).key, "blue");
});

test("note counts are grouped by notebook id", () => {
  const result = groupNotebookNoteCounts([
    { id: 1, notebookId: 12 },
    { id: 2, notebookId: 12 },
    { id: 3, notebookId: 18 },
  ]);

  assert.deepEqual(result, {
    12: 2,
    18: 1,
  });
});

test("updated label shows today when the notebook was updated on the same day", () => {
  const result = formatNotebookUpdatedLabel("2026-05-08 14:32:05", new Date("2026-05-08T22:10:00"));
  assert.equal(result, "今天 14:32 更新");
});

test("updated label falls back to calendar date when the notebook was updated on another day", () => {
  const result = formatNotebookUpdatedLabel("2026-04-30 08:05:00", new Date("2026-05-08T22:10:00"));
  assert.equal(result, "2026-04-30 更新");
});

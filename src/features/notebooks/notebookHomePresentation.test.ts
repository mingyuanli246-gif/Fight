// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import {
  formatNotebookUpdatedLabel,
  getNotebookCoverThemeByIdentity,
  isValidNotebookCoverThemeKey,
  resolveNotebookCoverThemeKey,
  stableHash,
} from "./notebookHomePresentation.ts";

test("stableHash is deterministic for the same identity", () => {
  assert.equal(stableHash(42), stableHash(42));
  assert.equal(stableHash("notebook-42"), stableHash("notebook-42"));
});

test("resolveNotebookCoverThemeKey keeps valid persisted keys", () => {
  assert.equal(
    resolveNotebookCoverThemeKey({ id: 7, coverThemeKey: "purple-planet" }),
    "purple-planet",
  );
});

test("resolveNotebookCoverThemeKey falls back to stable hash when key is missing", () => {
  const expectedTheme = getNotebookCoverThemeByIdentity(7).key;
  assert.equal(resolveNotebookCoverThemeKey({ id: 7, coverThemeKey: null }), expectedTheme);
});

test("resolveNotebookCoverThemeKey falls back to stable hash when key is invalid", () => {
  const expectedTheme = getNotebookCoverThemeByIdentity("notebook-7").key;
  assert.equal(
    resolveNotebookCoverThemeKey({
      id: "notebook-7",
      coverThemeKey: "pink" as never,
    }),
    expectedTheme,
  );
});

test("theme key validator only accepts the persisted five keys", () => {
  assert.equal(isValidNotebookCoverThemeKey("green-study"), true);
  assert.equal(isValidNotebookCoverThemeKey("blue-mountain"), true);
  assert.equal(isValidNotebookCoverThemeKey("purple-planet"), true);
  assert.equal(isValidNotebookCoverThemeKey("pink-biology"), true);
  assert.equal(isValidNotebookCoverThemeKey("yellow-math"), true);
  assert.equal(isValidNotebookCoverThemeKey("blue"), false);
  assert.equal(isValidNotebookCoverThemeKey(""), false);
});

test("updated label shows today when the notebook was updated on the same day", () => {
  const result = formatNotebookUpdatedLabel("2026-05-08 14:32:05", new Date("2026-05-08T22:10:00"));
  assert.equal(result, "今天 14:32 更新");
});

test("updated label falls back to calendar date when the notebook was updated on another day", () => {
  const result = formatNotebookUpdatedLabel("2026-04-30 08:05:00", new Date("2026-05-08T22:10:00"));
  assert.equal(result, "2026-04-30 更新");
});

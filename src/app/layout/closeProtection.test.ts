// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import {
  flushAllPendingChangesBeforeClose,
  shouldWarnBeforeUnload,
} from "./closeProtection.ts";

function createWorkspace() {
  return {
    hasUnsavedChanges: () => true,
    flushBeforeLeave: async () => true,
  };
}

test("window close waits for note-content flush to finish", async () => {
  let resolved = false;
  let releaseFlush: (() => void) | null = null;
  const workspace = {
    hasUnsavedChanges: (reason) => reason === "window-close",
    flushBeforeLeave: async (reason) => {
      assert.equal(reason, "window-close");
      await new Promise<void>((resolve) => {
        releaseFlush = () => {
          resolved = true;
          resolve();
        };
      });
      return true;
    },
  };

  const closing = flushAllPendingChangesBeforeClose({
    currentSection: "notebooks",
    notebookWorkspace: workspace,
    reason: "window-close",
  });

  await Promise.resolve();
  assert.equal(resolved, false);
  releaseFlush?.();
  assert.equal(await closing, "success");
  assert.equal(resolved, true);
});

test("window close routes review schedule changes through the same flush chain", async () => {
  const calls: string[] = [];
  const workspace = {
    hasUnsavedChanges: (reason) => {
      calls.push(`has:${reason}`);
      return reason === "window-close";
    },
    flushBeforeLeave: async (reason) => {
      calls.push(`flush:${reason}`);
      return true;
    },
  };

  const result = await flushAllPendingChangesBeforeClose({
    currentSection: "notebooks",
    notebookWorkspace: workspace,
    reason: "window-close",
  });

  assert.equal(result, "success");
  assert.deepEqual(calls, ["has:window-close", "flush:window-close"]);
});

test("failed flush blocks window close", async () => {
  const workspace = {
    hasUnsavedChanges: (reason) => reason === "window-close",
    flushBeforeLeave: async () => false,
  };

  const result = await flushAllPendingChangesBeforeClose({
    currentSection: "notebooks",
    notebookWorkspace: workspace,
    reason: "window-close",
  });

  assert.equal(result, "blocked");
});

test("beforeunload only warns and never starts async flush", () => {
  let flushCalled = false;
  const workspace = {
    hasUnsavedChanges: (reason) => reason === "before-unload",
    flushBeforeLeave: async () => {
      flushCalled = true;
      return true;
    },
  };

  assert.equal(
    shouldWarnBeforeUnload({
      currentSection: "notebooks",
      notebookWorkspace: workspace,
    }),
    true,
  );
  assert.equal(flushCalled, false);
});

test("non-notebook sections skip close protection work", async () => {
  const workspace = createWorkspace();

  assert.equal(
    shouldWarnBeforeUnload({
      currentSection: "settings",
      notebookWorkspace: workspace,
    }),
    false,
  );
  assert.equal(
    await flushAllPendingChangesBeforeClose({
      currentSection: "settings",
      notebookWorkspace: workspace,
      reason: "window-close",
    }),
    "success",
  );
});

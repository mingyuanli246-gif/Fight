// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCleanupConfirmationMessage,
  canRunResourceCleanup,
  getResourceTrashDeleteLabel,
} from "./resourceManagementState.ts";

test("cleanup action stays disabled without a scan result", () => {
  assert.equal(canRunResourceCleanup(null), false);
});

test("cleanup action stays disabled when scan result has zero candidates", () => {
  assert.equal(
    canRunResourceCleanup({
      items: [],
      totalCount: 0,
      totalBytes: 0,
      skippedFiles: [],
      warnings: [],
    }),
    false,
  );
});

test("cleanup action is enabled only when the latest result contains candidates", () => {
  assert.equal(
    canRunResourceCleanup({
      items: [
        {
          resourcePath: "resources/images/11111111-1111-4111-8111-111111111111.png",
          kind: "image",
          sizeBytes: 8,
        },
      ],
      totalCount: 1,
      totalBytes: 8,
      skippedFiles: [],
      warnings: [],
    }),
    true,
  );
});

test("cleanup confirmation explains the backend re-scan and non-destructive move", () => {
  const message = buildCleanupConfirmationMessage();

  assert.match(message, /重新扫描/);
  assert.match(message, /可能少于当前列表显示数量/);
  assert.match(message, /不会直接永久删除/);
  assert.match(message, /移入图片资源回收站/);
});

test("trash delete label prefers originalPath", () => {
  assert.equal(
    getResourceTrashDeleteLabel({
      trashId: "11111111-1111-4111-8111-111111111111",
      resourceKind: "image",
      originalPath: "resources/images/11111111-1111-4111-8111-111111111111.png",
      trashPath: null,
      deletedAt: null,
      source: null,
      extension: null,
      fileExists: true,
      manifestValid: true,
      canRestore: true,
      status: "ok",
      message: null,
    }),
    "resources/images/11111111-1111-4111-8111-111111111111.png",
  );
});

test("trash delete label falls back to trashId when originalPath is missing", () => {
  assert.equal(
    getResourceTrashDeleteLabel({
      trashId: "22222222-2222-4222-8222-222222222222",
      resourceKind: "cover",
      originalPath: null,
      trashPath: null,
      deletedAt: null,
      source: null,
      extension: null,
      fileExists: true,
      manifestValid: true,
      canRestore: false,
      status: "broken",
      message: "manifest missing",
    }),
    "22222222-2222-4222-8222-222222222222",
  );
});

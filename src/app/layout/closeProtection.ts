import type { AppSection } from "../sections";
import type {
  NotebookLeaveReason,
  NotebookWorkspaceRef,
} from "../../features/notebooks/NotebookWorkspace";

interface CloseProtectionOptions {
  currentSection: AppSection;
  notebookWorkspace: NotebookWorkspaceRef | null;
}

interface FlushBeforeCloseOptions extends CloseProtectionOptions {
  reason: NotebookLeaveReason;
}

export type CloseFlushResult = "success" | "blocked";

export function shouldWarnBeforeUnload({
  currentSection,
  notebookWorkspace,
}: CloseProtectionOptions) {
  if (currentSection !== "notebooks") {
    return false;
  }

  return notebookWorkspace?.hasUnsavedChanges("before-unload") ?? false;
}

export async function flushAllPendingChangesBeforeClose({
  currentSection,
  notebookWorkspace,
  reason,
}: FlushBeforeCloseOptions): Promise<CloseFlushResult> {
  if (currentSection !== "notebooks") {
    return "success";
  }

  if (!notebookWorkspace?.hasUnsavedChanges(reason)) {
    return "success";
  }

  const canLeave = await notebookWorkspace.flushBeforeLeave(reason);
  return canLeave ? "success" : "blocked";
}

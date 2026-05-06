import type {
  OrphanResourceScanResult,
  ResourceTrashListItem,
} from "../notebooks/resourceCommands";

export function canRunResourceCleanup(
  result: OrphanResourceScanResult | null,
): boolean {
  return !!result && result.totalCount > 0;
}

export function buildCleanupConfirmationMessage() {
  return "系统会在清理前重新扫描无引用图片。最终移入回收站的数量可能少于当前列表显示数量。确认后，只会把仍然无人引用的资源移入图片资源回收站，不会直接永久删除。";
}

export function getResourceTrashDeleteLabel(item: ResourceTrashListItem): string {
  const originalPath = item.originalPath?.trim();
  if (originalPath) {
    return originalPath;
  }

  return item.trashId;
}

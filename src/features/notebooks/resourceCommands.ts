import { invoke } from "@tauri-apps/api/core";

export type SelectAndImportImageTarget = "note-image" | "notebook-cover";

export interface SelectAndImportImageCancelledResult {
  status: "cancelled";
}

export interface SelectAndImportImageImportedResult {
  status: "imported";
  target: SelectAndImportImageTarget;
  resourcePath: string;
}

export type SelectAndImportImageResult =
  | SelectAndImportImageCancelledResult
  | SelectAndImportImageImportedResult;

export interface ResolveManagedResourceResolvedResult {
  status: "resolved";
  resourcePath: string;
}

export interface ResolveManagedResourceMissingResult {
  status: "missing";
  resourcePath: string;
}

export type ResolveManagedResourceResult =
  | ResolveManagedResourceResolvedResult
  | ResolveManagedResourceMissingResult;

function getCommandErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

export async function ensureResourceDirectories() {
  try {
    return await invoke<void>("ensure_resource_directories");
  } catch (error) {
    throw new Error(
      getCommandErrorMessage(error, "初始化资源目录失败，请稍后重试。"),
    );
  }
}

export async function selectAndImportImage(target: SelectAndImportImageTarget) {
  try {
    return await invoke<SelectAndImportImageResult>("select_and_import_image", {
      target,
    });
  } catch (error) {
    throw new Error(getCommandErrorMessage(error, "图片导入失败，请稍后重试。"));
  }
}

export async function resolveManagedResource(resourcePath: string) {
  try {
    return await invoke<ResolveManagedResourceResult>("resolve_managed_resource", {
      resourcePath,
    });
  } catch (error) {
    throw new Error(getCommandErrorMessage(error, "资源路径无效。"));
  }
}

export async function deleteManagedResource(resourcePath: string) {
  try {
    await invoke<void>("delete_managed_resource", { resourcePath });
  } catch (error) {
    throw new Error(
      getCommandErrorMessage(error, "图片资源清理失败，请稍后重试。"),
    );
  }
}

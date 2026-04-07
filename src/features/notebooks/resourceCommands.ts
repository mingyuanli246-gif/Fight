import { invoke } from "@tauri-apps/api/core";

export type SelectAndImportImageTarget = "note-image" | "notebook-cover";

export interface ManagedResourcePayload {
  resourcePath: string;
  absolutePath: string;
  assetUrl: string;
}

export interface SelectAndImportImageCancelledResult {
  status: "cancelled";
}

export interface SelectAndImportImageImportedResult extends ManagedResourcePayload {
  status: "imported";
  target: SelectAndImportImageTarget;
}

export type SelectAndImportImageResult =
  | SelectAndImportImageCancelledResult
  | SelectAndImportImageImportedResult;

export interface ResolveManagedResourceResolvedResult extends ManagedResourcePayload {
  status: "resolved";
}

export interface ResolveManagedResourceMissingResult extends ManagedResourcePayload {
  status: "missing";
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
    const result = await invoke<SelectAndImportImageResult>("select_and_import_image", {
      target,
    });
    if (result.status === "imported") {
      console.info("[resources] 图片导入成功", {
        target: result.target,
        resourcePath: result.resourcePath,
        absolutePath: result.absolutePath,
        assetUrl: result.assetUrl,
      });
    }
    return result;
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
    console.error("[resources] 资源解析失败", {
      resourcePath,
      error,
    });
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

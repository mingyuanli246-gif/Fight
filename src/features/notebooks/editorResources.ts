import { convertFileSrc } from "@tauri-apps/api/core";
import { appConfigDir, join } from "@tauri-apps/api/path";
import { resolveManagedResource } from "./resourceCommands";

export const RESOURCE_ROOT_PATH = "resources";
export const RESOURCE_IMAGES_PATH = "resources/images";
export const RESOURCE_COVERS_PATH = "resources/covers";
export const INVALID_RESOURCE_PATH_MESSAGE = "资源路径无效。";
export const MISSING_RESOURCE_MESSAGE = "图片资源不存在或已损坏。";

export interface ImageResourceReference {
  resourcePath: string;
  alt: string;
}

export interface ResolvedLocalResourceResult {
  status: "resolved";
  resourcePath: string;
  absolutePath: string;
  assetUrl: string;
}

export interface MissingLocalResourceResult {
  status: "missing";
  resourcePath: string;
  absolutePath: string;
  assetUrl: string;
  message: string;
}

export interface InvalidLocalResourceResult {
  status: "invalid";
  resourcePath: string;
  message: string;
}

export type LocalResourceResolutionResult =
  | ResolvedLocalResourceResult
  | MissingLocalResourceResult
  | InvalidLocalResourceResult;

let appConfigDirPromise: Promise<string> | null = null;
const resolvedResourceCache = new Map<
  string,
  Promise<LocalResourceResolutionResult>
>();

function isWindowsDrivePath(value: string) {
  return /^[A-Za-z]:/.test(value);
}

export function normalizeManagedResourcePath(resourcePath: string) {
  const trimmed = resourcePath.trim();

  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.includes("\\") ||
    isWindowsDrivePath(trimmed)
  ) {
    throw new Error(INVALID_RESOURCE_PATH_MESSAGE);
  }

  const segments = trimmed.split("/");

  if (
    segments.length < 2 ||
    segments[0] !== RESOURCE_ROOT_PATH ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(INVALID_RESOURCE_PATH_MESSAGE);
  }

  return segments.join("/");
}

async function getAppConfigRoot() {
  if (!appConfigDirPromise) {
    appConfigDirPromise = appConfigDir().catch((error) => {
      appConfigDirPromise = null;
      throw error;
    });
  }

  return appConfigDirPromise;
}

async function buildAbsoluteResourcePath(resourcePath: string) {
  return join(await getAppConfigRoot(), resourcePath);
}

async function resolveLocalResourcePathUncached(
  normalizedResourcePath: string,
): Promise<LocalResourceResolutionResult> {
  try {
    const resolved = await resolveManagedResource(normalizedResourcePath);
    const absolutePath = await buildAbsoluteResourcePath(resolved.resourcePath);
    const assetUrl = convertFileSrc(absolutePath);

    if (resolved.status === "missing") {
      return {
        status: "missing",
        resourcePath: resolved.resourcePath,
        absolutePath,
        assetUrl,
        message: MISSING_RESOURCE_MESSAGE,
      };
    }

    return {
      status: "resolved",
      resourcePath: resolved.resourcePath,
      absolutePath,
      assetUrl,
    };
  } catch (error) {
    return {
      status: "invalid",
      resourcePath: normalizedResourcePath,
      message:
        error instanceof Error && error.message.trim()
          ? error.message
          : INVALID_RESOURCE_PATH_MESSAGE,
    };
  }
}

export async function resolveLocalResourcePath(
  resourcePath: string,
): Promise<LocalResourceResolutionResult> {
  let normalizedPath: string;

  try {
    normalizedPath = normalizeManagedResourcePath(resourcePath);
  } catch (error) {
    return {
      status: "invalid",
      resourcePath,
      message:
        error instanceof Error && error.message.trim()
          ? error.message
          : INVALID_RESOURCE_PATH_MESSAGE,
    };
  }

  const cachedResult = resolvedResourceCache.get(normalizedPath);

  if (cachedResult) {
    return cachedResult;
  }

  const resultPromise = resolveLocalResourcePathUncached(normalizedPath).then(
    (result) => {
      if (result.status !== "resolved") {
        resolvedResourceCache.delete(normalizedPath);
      }

      return result;
    },
  );

  resolvedResourceCache.set(normalizedPath, resultPromise);
  return resultPromise;
}

export function clearManagedResourceResolution(resourcePath?: string) {
  if (!resourcePath) {
    resolvedResourceCache.clear();
    return;
  }

  try {
    resolvedResourceCache.delete(normalizeManagedResourcePath(resourcePath));
  } catch {
    resolvedResourceCache.delete(resourcePath);
  }
}

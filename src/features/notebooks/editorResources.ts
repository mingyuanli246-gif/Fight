import type { ManagedResourcePayload } from "./resourceCommands";
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

async function resolveLocalResourcePathUncached(
  normalizedResourcePath: string,
): Promise<LocalResourceResolutionResult> {
  try {
    const resolved = await resolveManagedResource(normalizedResourcePath);

    if (resolved.status === "missing") {
      return {
        status: "missing",
        resourcePath: resolved.resourcePath,
        absolutePath: resolved.absolutePath,
        assetUrl: resolved.assetUrl,
        message: MISSING_RESOURCE_MESSAGE,
      };
    }

    return {
      status: "resolved",
      resourcePath: resolved.resourcePath,
      absolutePath: resolved.absolutePath,
      assetUrl: resolved.assetUrl,
    };
  } catch (error) {
    console.error("[resources] 资源解析失败", {
      resourcePath: normalizedResourcePath,
      error,
    });
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
    console.error("[resources] 资源解析失败", {
      resourcePath,
      error,
    });
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

export function primeManagedResourceResolution(result: ManagedResourcePayload) {
  const normalizedPath = normalizeManagedResourcePath(result.resourcePath);
  resolvedResourceCache.set(
    normalizedPath,
    Promise.resolve({
      status: "resolved",
      resourcePath: normalizedPath,
      absolutePath: result.absolutePath,
      assetUrl: result.assetUrl,
    }),
  );
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

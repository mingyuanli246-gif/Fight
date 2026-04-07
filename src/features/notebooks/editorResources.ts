export interface LocalResourcePlaceholderResult {
  status: "not-implemented";
  capability: "localResources";
  message: string;
  resourcePath: string;
}

export function resolveLocalResourcePath(
  resourcePath: string,
): LocalResourcePlaceholderResult {
  return {
    status: "not-implemented",
    capability: "localResources",
    message: "本地资源路径解析将在后续阶段接入，本阶段仅保留接口约定。",
    resourcePath,
  };
}

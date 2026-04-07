import { useEffect, useMemo, useState } from "react";
import {
  MISSING_RESOURCE_MESSAGE,
  resolveLocalResourcePath,
  type LocalResourceResolutionResult,
} from "./editorResources";
import styles from "./NotebookWorkspace.module.css";

interface ManagedResourceImageProps {
  resourcePath: string | null;
  alt: string;
  imageClassName: string;
  fallbackClassName: string;
  loadingClassName?: string;
  fallbackTitle: string;
  fallbackMessage?: string;
}

export function ManagedResourceImage({
  resourcePath,
  alt,
  imageClassName,
  fallbackClassName,
  loadingClassName,
  fallbackTitle,
  fallbackMessage,
}: ManagedResourceImageProps) {
  const [resolution, setResolution] = useState<LocalResourceResolutionResult | null>(
    null,
  );
  const [didImageFail, setDidImageFail] = useState(false);

  const normalizedFallbackMessage = useMemo(
    () => fallbackMessage?.trim() ?? "",
    [fallbackMessage],
  );

  useEffect(() => {
    let cancelled = false;

    if (!resourcePath) {
      setResolution(null);
      setDidImageFail(false);
      return;
    }

    setResolution(null);
    setDidImageFail(false);

    void resolveLocalResourcePath(resourcePath).then((result) => {
      if (!cancelled) {
        setResolution(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [resourcePath]);

  if (!resourcePath) {
    return (
      <span className={fallbackClassName}>
        <strong className={styles.noteImageFallbackTitle}>{fallbackTitle}</strong>
        {normalizedFallbackMessage ? (
          <span className={styles.noteImageFallbackText}>
            {normalizedFallbackMessage}
          </span>
        ) : null}
      </span>
    );
  }

  if (resolution === null) {
    return (
      <span className={loadingClassName ?? fallbackClassName}>正在加载图片…</span>
    );
  }

  const fallbackDetail =
    didImageFail || resolution.status === "resolved"
      ? MISSING_RESOURCE_MESSAGE
      : resolution.message;

  if (resolution.status !== "resolved" || didImageFail) {
    return (
      <span className={fallbackClassName}>
        <strong className={styles.noteImageFallbackTitle}>{fallbackTitle}</strong>
        <span className={styles.noteImageFallbackText}>
          {fallbackDetail}
        </span>
      </span>
    );
  }

  return (
    <img
      className={imageClassName}
      src={resolution.assetUrl}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={(event) => {
        console.error("[resources] 封面图片加载失败", {
          resourcePath,
          src: event.currentTarget.currentSrc || event.currentTarget.src,
        });
        setDidImageFail(true);
      }}
    />
  );
}

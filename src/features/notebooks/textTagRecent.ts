const RECENT_TEXT_TAGS_STORAGE_KEY = "notebooks.text-tags.recent";
const RECENT_TEXT_TAG_LIMIT = 6;

function canUseLocalStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function readRecentTextTagIds() {
  if (!canUseLocalStorage()) {
    return [] as number[];
  }

  try {
    const rawValue = window.localStorage.getItem(RECENT_TEXT_TAGS_STORAGE_KEY);

    if (!rawValue) {
      return [] as number[];
    }

    const parsed = JSON.parse(rawValue);

    if (!Array.isArray(parsed)) {
      return [] as number[];
    }

    return parsed
      .map((value) =>
        typeof value === "number"
          ? value
          : Number.parseInt(typeof value === "string" ? value : "", 10),
      )
      .filter((value): value is number => Number.isInteger(value) && value > 0)
      .slice(0, RECENT_TEXT_TAG_LIMIT);
  } catch {
    return [] as number[];
  }
}

export function rememberRecentTextTagId(tagId: number) {
  if (!canUseLocalStorage() || !Number.isInteger(tagId) || tagId <= 0) {
    return;
  }

  const nextIds = [tagId, ...readRecentTextTagIds().filter((value) => value !== tagId)].slice(
    0,
    RECENT_TEXT_TAG_LIMIT,
  );

  try {
    window.localStorage.setItem(
      RECENT_TEXT_TAGS_STORAGE_KEY,
      JSON.stringify(nextIds),
    );
  } catch {
    // 本地缓存写失败时直接静默降级，不影响正文标签主流程。
  }
}

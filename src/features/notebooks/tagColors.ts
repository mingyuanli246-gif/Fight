export const DEFAULT_TAG_COLOR = "#FF3B30";

export const TAG_COLOR_PALETTE = [
  "#FF3B30",
  "#FF9500",
  "#FFCC00",
  "#34C759",
  "#00C7BE",
  "#5AC8FA",
  "#007AFF",
  "#5856D6",
  "#AF52DE",
  "#FF2D55",
  "#A2845E",
  "#8E8E93",
] as const;

const TAG_COLOR_SET = new Set<string>(TAG_COLOR_PALETTE);
const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/;

export function normalizeTagColor(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toUpperCase();

  if (!HEX_COLOR_PATTERN.test(normalized)) {
    return DEFAULT_TAG_COLOR;
  }

  if (!TAG_COLOR_SET.has(normalized)) {
    return DEFAULT_TAG_COLOR;
  }

  return normalized;
}

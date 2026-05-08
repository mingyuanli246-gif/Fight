export type NotebookCoverThemeKey =
  | "green-study"
  | "blue-mountain"
  | "purple-planet"
  | "pink-biology"
  | "yellow-math";

export interface NotebookCoverTheme {
  key: NotebookCoverThemeKey;
  accent: string;
}

const NOTEBOOK_COVER_THEMES: NotebookCoverTheme[] = [
  { key: "green-study", accent: "#a5d062" },
  { key: "blue-mountain", accent: "#6f9dff" },
  { key: "purple-planet", accent: "#8e7cf8" },
  { key: "pink-biology", accent: "#f3a6c5" },
  { key: "yellow-math", accent: "#f2ca58" },
];

const NOTEBOOK_COVER_THEME_KEYS = new Set<NotebookCoverThemeKey>(
  NOTEBOOK_COVER_THEMES.map((theme) => theme.key),
);

const NOTEBOOK_COVER_THEME_BY_KEY = NOTEBOOK_COVER_THEMES.reduce<
  Record<NotebookCoverThemeKey, NotebookCoverTheme>
>((themeMap, theme) => {
  themeMap[theme.key] = theme;
  return themeMap;
}, {} as Record<NotebookCoverThemeKey, NotebookCoverTheme>);

function parseTimestamp(value: string) {
  return new Date(value.replace(" ", "T"));
}

function padTimePart(value: number) {
  return String(value).padStart(2, "0");
}

export function stableHash(identity: string | number) {
  const bytes = new TextEncoder().encode(String(identity));
  let hash = 2166136261;

  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function isValidNotebookCoverThemeKey(
  value: unknown,
): value is NotebookCoverThemeKey {
  return typeof value === "string" && NOTEBOOK_COVER_THEME_KEYS.has(value as NotebookCoverThemeKey);
}

export function getNotebookCoverThemeByIdentity(identity: string | number) {
  const themeIndex = stableHash(identity) % NOTEBOOK_COVER_THEMES.length;
  return NOTEBOOK_COVER_THEMES[themeIndex] ?? NOTEBOOK_COVER_THEMES[0];
}

export function resolveNotebookCoverThemeKey({
  id,
  coverThemeKey,
}: {
  id: string | number;
  coverThemeKey: string | null;
}) {
  if (isValidNotebookCoverThemeKey(coverThemeKey)) {
    return coverThemeKey;
  }

  return getNotebookCoverThemeByIdentity(id).key;
}

export function resolveNotebookCoverTheme({
  id,
  coverThemeKey,
}: {
  id: string | number;
  coverThemeKey: string | null;
}) {
  const resolvedKey = resolveNotebookCoverThemeKey({ id, coverThemeKey });
  return NOTEBOOK_COVER_THEME_BY_KEY[resolvedKey];
}

export function formatNotebookUpdatedLabel(
  updatedAt: string,
  now = new Date(),
) {
  const updatedDate = parseTimestamp(updatedAt);

  if (Number.isNaN(updatedDate.getTime())) {
    return "更新时间未知";
  }

  const isSameDay =
    updatedDate.getFullYear() === now.getFullYear() &&
    updatedDate.getMonth() === now.getMonth() &&
    updatedDate.getDate() === now.getDate();

  if (isSameDay) {
    return `今天 ${padTimePart(updatedDate.getHours())}:${padTimePart(updatedDate.getMinutes())} 更新`;
  }

  return [
    updatedDate.getFullYear(),
    padTimePart(updatedDate.getMonth() + 1),
    padTimePart(updatedDate.getDate()),
  ].join("-") + " 更新";
}

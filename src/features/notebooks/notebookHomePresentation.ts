export type NotebookCoverThemeKey =
  | "blue"
  | "purple"
  | "pink"
  | "yellow"
  | "green";

export interface NotebookCoverTheme {
  key: NotebookCoverThemeKey;
  accent: string;
}

const NOTEBOOK_COVER_THEMES: NotebookCoverTheme[] = [
  { key: "blue", accent: "#6f9dff" },
  { key: "purple", accent: "#8e7cf8" },
  { key: "pink", accent: "#f3a6c5" },
  { key: "yellow", accent: "#f2ca58" },
  { key: "green", accent: "#a5d062" },
];

function normalizeThemeIndex(index: number) {
  if (!Number.isFinite(index)) {
    return 0;
  }

  const roundedIndex = Math.trunc(index);
  const normalized = roundedIndex % NOTEBOOK_COVER_THEMES.length;
  return normalized >= 0
    ? normalized
    : normalized + NOTEBOOK_COVER_THEMES.length;
}

function parseTimestamp(value: string) {
  return new Date(value.replace(" ", "T"));
}

function padTimePart(value: number) {
  return String(value).padStart(2, "0");
}

export function getNotebookCoverTheme(index: number) {
  return NOTEBOOK_COVER_THEMES[normalizeThemeIndex(index)] ?? NOTEBOOK_COVER_THEMES[0];
}

export function groupNotebookNoteCounts(
  notes: Array<{ notebookId: number }>,
) {
  return notes.reduce<Record<number, number>>((counts, note) => {
    counts[note.notebookId] = (counts[note.notebookId] ?? 0) + 1;
    return counts;
  }, {});
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

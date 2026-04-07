export const DATABASE_PATH = "sqlite:fight-notes.db";

export const NOTEBOOK_ORDER = "ORDER BY created_at ASC, id ASC";
export const FOLDER_ORDER = "ORDER BY sort_order ASC, created_at ASC, id ASC";
export const NOTE_ORDER = "ORDER BY created_at ASC, id ASC";
export const TAG_ORDER = "ORDER BY tags.updated_at DESC, tags.id DESC";
export const NOTE_TAG_ORDER = "ORDER BY tags.name COLLATE NOCASE ASC, tags.id ASC";
export const TAGGED_NOTE_ORDER = "ORDER BY notes.updated_at DESC, notes.id DESC";

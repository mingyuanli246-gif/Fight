export const DATABASE_PATH = "sqlite:fight-notes.db";

export const NOTEBOOK_ORDER = "ORDER BY created_at ASC, id ASC";
export const FOLDER_ORDER = "ORDER BY sort_order ASC, created_at ASC, id ASC";
export const NOTE_ORDER = "ORDER BY created_at ASC, id ASC";
export const TAG_ORDER = "ORDER BY tags.updated_at DESC, tags.id DESC";
export const NOTE_TAG_ORDER = "ORDER BY tags.name COLLATE NOCASE ASC, tags.id ASC";
export const TAGGED_NOTE_ORDER = "ORDER BY notes.updated_at DESC, notes.id DESC";

export const NOTE_SEARCH_META_VERSION = "1";
export const APP_META_KEY_NOTE_SEARCH_META_VERSION = "note_search_meta_version";
export const APP_META_KEY_NOTE_SEARCH_INITIALIZED = "note_search_initialized";
export const APP_META_KEY_NOTE_SEARCH_LAST_REBUILD_AT =
  "note_search_last_rebuild_at";

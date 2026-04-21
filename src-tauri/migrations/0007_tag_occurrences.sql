UPDATE tags
SET color = '#FF3B30'
WHERE color IS NULL OR TRIM(color) = '';

CREATE TABLE IF NOT EXISTS note_tag_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= 0),
  node_type TEXT NOT NULL,
  snippet_text TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_tag_occurrences_note_sort
ON note_tag_occurrences(note_id, sort_order, id);

CREATE INDEX IF NOT EXISTS idx_note_tag_occurrences_tag_note
ON note_tag_occurrences(tag_id, note_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_note_tag_occurrences_note_tag
ON note_tag_occurrences(note_id, tag_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_note_tag_occurrences_anchor
ON note_tag_occurrences(note_id, block_id, start_offset, end_offset);

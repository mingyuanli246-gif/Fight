ALTER TABLE notebooks
ADD COLUMN deleted_at TEXT;

ALTER TABLE notebooks
ADD COLUMN is_trash_root INTEGER NOT NULL DEFAULT 0;

ALTER TABLE notebooks
ADD COLUMN deleted_by_root_type TEXT;

ALTER TABLE notebooks
ADD COLUMN deleted_by_root_id INTEGER;

ALTER TABLE notebooks
ADD COLUMN trash_origin_path TEXT;

ALTER TABLE notebooks
ADD COLUMN is_recovery_notebook INTEGER NOT NULL DEFAULT 0;

ALTER TABLE folders
ADD COLUMN deleted_at TEXT;

ALTER TABLE folders
ADD COLUMN is_trash_root INTEGER NOT NULL DEFAULT 0;

ALTER TABLE folders
ADD COLUMN deleted_by_root_type TEXT;

ALTER TABLE folders
ADD COLUMN deleted_by_root_id INTEGER;

ALTER TABLE folders
ADD COLUMN original_notebook_id INTEGER;

ALTER TABLE folders
ADD COLUMN original_parent_folder_id INTEGER;

ALTER TABLE folders
ADD COLUMN trash_origin_path TEXT;

ALTER TABLE notes
ADD COLUMN deleted_at TEXT;

ALTER TABLE notes
ADD COLUMN is_trash_root INTEGER NOT NULL DEFAULT 0;

ALTER TABLE notes
ADD COLUMN deleted_by_root_type TEXT;

ALTER TABLE notes
ADD COLUMN deleted_by_root_id INTEGER;

ALTER TABLE notes
ADD COLUMN original_notebook_id INTEGER;

ALTER TABLE notes
ADD COLUMN original_folder_id INTEGER;

ALTER TABLE notes
ADD COLUMN trash_origin_path TEXT;

CREATE INDEX IF NOT EXISTS idx_notebooks_deleted_at
ON notebooks(deleted_at);

CREATE INDEX IF NOT EXISTS idx_notebooks_trash_root_deleted_at
ON notebooks(is_trash_root, deleted_at);

CREATE INDEX IF NOT EXISTS idx_notebooks_recovery_live
ON notebooks(is_recovery_notebook, deleted_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notebooks_single_live_recovery
ON notebooks(is_recovery_notebook)
WHERE is_recovery_notebook = 1 AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_folders_deleted_at
ON folders(deleted_at);

CREATE INDEX IF NOT EXISTS idx_folders_trash_root_deleted_at
ON folders(is_trash_root, deleted_at);

CREATE INDEX IF NOT EXISTS idx_folders_deleted_by_root
ON folders(deleted_by_root_type, deleted_by_root_id);

CREATE INDEX IF NOT EXISTS idx_notes_deleted_at
ON notes(deleted_at);

CREATE INDEX IF NOT EXISTS idx_notes_trash_root_deleted_at
ON notes(is_trash_root, deleted_at);

CREATE INDEX IF NOT EXISTS idx_notes_deleted_by_root
ON notes(deleted_by_root_type, deleted_by_root_id);

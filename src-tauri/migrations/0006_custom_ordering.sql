ALTER TABLE notebooks
ADD COLUMN custom_sort_order INTEGER NOT NULL DEFAULT 0;

WITH ordered_notebooks AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) - 1 AS next_sort_order
  FROM notebooks
)
UPDATE notebooks
SET custom_sort_order = (
  SELECT next_sort_order
  FROM ordered_notebooks
  WHERE ordered_notebooks.id = notebooks.id
);

ALTER TABLE notes
ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

WITH ordered_notes AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY folder_id
      ORDER BY created_at ASC, id ASC
    ) - 1 AS next_sort_order
  FROM notes
)
UPDATE notes
SET sort_order = (
  SELECT next_sort_order
  FROM ordered_notes
  WHERE ordered_notes.id = notes.id
);

CREATE INDEX IF NOT EXISTS idx_notebooks_custom_order
ON notebooks(custom_sort_order, created_at, id);

CREATE INDEX IF NOT EXISTS idx_notes_folder_sort_order
ON notes(folder_id, sort_order, created_at, id);

CREATE TABLE IF NOT EXISTS review_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS review_plan_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  offset_days INTEGER NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES review_plans(id) ON DELETE CASCADE,
  UNIQUE (plan_id, step_index),
  UNIQUE (plan_id, offset_days),
  CHECK (step_index >= 1 AND step_index <= 5),
  CHECK (offset_days >= 0)
);

CREATE TABLE IF NOT EXISTS note_review_bindings (
  note_id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES review_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  is_completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES review_plans(id) ON DELETE CASCADE,
  UNIQUE (note_id, plan_id, step_index, due_date),
  CHECK (is_completed IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_review_tasks_due_date
ON review_tasks(due_date, plan_id, is_completed, note_id);

CREATE INDEX IF NOT EXISTS idx_note_review_bindings_plan
ON note_review_bindings(plan_id, start_date);

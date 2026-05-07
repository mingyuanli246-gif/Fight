CREATE TABLE IF NOT EXISTS managed_resources (
  resource_path TEXT PRIMARY KEY,
  resource_kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  ref_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  pending_delete_at TEXT,
  deleted_at TEXT,
  last_cleanup_error TEXT
);

CREATE TABLE IF NOT EXISTS resource_links (
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  resource_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_type, owner_id, resource_path),
  FOREIGN KEY (resource_path) REFERENCES managed_resources(resource_path)
);

CREATE INDEX IF NOT EXISTS idx_resource_links_owner
ON resource_links(owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_managed_resources_ref_count
ON managed_resources(ref_count);

CREATE INDEX IF NOT EXISTS idx_managed_resources_pending_delete
ON managed_resources(ref_count, pending_delete_at);

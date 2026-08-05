CREATE TABLE release_manifests (version_id TEXT PRIMARY KEY, manifest TEXT NOT NULL CHECK (json_valid(manifest)), created_at TEXT NOT NULL);

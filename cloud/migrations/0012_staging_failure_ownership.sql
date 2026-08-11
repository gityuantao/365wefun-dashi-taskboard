ALTER TABLE staging_deployments ADD COLUMN failure_owner TEXT CHECK (failure_owner IS NULL OR failure_owner = 'product_rework' OR failure_owner = 'staging_infrastructure');
ALTER TABLE staging_deployments ADD COLUMN failure_classification TEXT;
ALTER TABLE staging_deployments ADD COLUMN failure_fingerprint TEXT;
CREATE INDEX idx_staging_failure_fingerprint ON staging_deployments (task_id, candidate_commit, failure_fingerprint, attempt DESC) WHERE status = 'failed' AND failure_fingerprint IS NOT NULL;

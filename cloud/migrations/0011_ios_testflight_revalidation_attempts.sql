ALTER TABLE ios_testflight_deployments ADD COLUMN failure_classification TEXT CHECK (failure_classification IN ('observation_error', 'authoritative_stale'));

-- Manual-confirm rollback for 003. Removing this column discards release
-- evidence and must not be part of an automated rollback.
BEGIN;

ALTER TABLE x402_settlement_attempts
  DROP COLUMN IF EXISTS release_evidence_json;

DELETE FROM schema_migrations WHERE filename = '003_x402_release_evidence.sql';

COMMIT;

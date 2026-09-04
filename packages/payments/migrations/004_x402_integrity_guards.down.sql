-- Manual-confirm rollback for 004. Removing these guards reopens direct role
-- state-machine and audit bypasses.
BEGIN;

DROP TRIGGER IF EXISTS x402_role_history_recorder ON x402_settlement_attempts;
DROP TRIGGER IF EXISTS x402_role_state_guard ON x402_settlement_attempts;
DROP FUNCTION IF EXISTS x402_record_role_history();
DROP FUNCTION IF EXISTS x402_enforce_role_state();
ALTER TABLE x402_settlement_attempts
  DROP CONSTRAINT IF EXISTS x402_released_has_evidence,
  DROP CONSTRAINT IF EXISTS x402_settled_has_evidence,
  DROP CONSTRAINT IF EXISTS x402_requirements_object,
  DROP CONSTRAINT IF EXISTS x402_payment_id_nonempty,
  DROP CONSTRAINT IF EXISTS x402_auth_revision_nonempty,
  DROP CONSTRAINT IF EXISTS x402_resource_nonempty,
  DROP CONSTRAINT IF EXISTS x402_request_digest_sha256,
  DROP CONSTRAINT IF EXISTS x402_intent_version_nonnegative,
  DROP CONSTRAINT IF EXISTS x402_logical_order_id_nonempty,
  DROP CONSTRAINT IF EXISTS x402_operation_id_nonempty;

DELETE FROM schema_migrations WHERE filename = '004_x402_integrity_guards.sql';

COMMIT;

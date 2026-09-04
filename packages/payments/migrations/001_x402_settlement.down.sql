-- Rollback for 001. Manual-confirm only. Never run automatically: dropping
-- these tables destroys settlement evidence. Prefer the kill-switch +
-- drain-then-redeploy procedure (x402 disabled, never memory fallback).
BEGIN;

DROP TRIGGER IF EXISTS x402_role_history_recorder ON x402_settlement_attempts;
DROP TRIGGER IF EXISTS x402_role_state_guard ON x402_settlement_attempts;
DROP FUNCTION IF EXISTS x402_record_role_history();
DROP FUNCTION IF EXISTS x402_enforce_role_state();
DROP TRIGGER IF EXISTS x402_no_app_release ON x402_settlement_attempts;
DROP FUNCTION IF EXISTS x402_reject_app_release();
DROP INDEX IF EXISTS ix_attempts_order;
DROP INDEX IF EXISTS ix_attempts_sweep;
DROP INDEX IF EXISTS ix_recon_op;
DROP INDEX IF EXISTS ux_pid_active;
DROP INDEX IF EXISTS ux_active_order_intent;
DROP INDEX IF EXISTS ux_attempt_digest_payment;
DROP TABLE IF EXISTS x402_reconciliation_history;
DROP TABLE IF EXISTS x402_settlement_attempts;
DROP TYPE IF EXISTS x402_attempt_status;

DELETE FROM schema_migrations
 WHERE filename IN (
    '006_x402_history_marker.sql',
    '005_x402_lease_takeover_guard.sql',
   '004_x402_integrity_guards.sql',
   '003_x402_release_evidence.sql',
   '002_x402_integrity.sql',
   '001_x402_settlement.sql'
 );

COMMIT;

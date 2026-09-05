-- Manual-confirm rollback for 002. Do not remove these guards while x402 is
-- enabled; doing so reopens duplicate-spend and payment-ID-reuse paths.
BEGIN;

DROP INDEX IF EXISTS ux_settled_request_once;
DROP INDEX IF EXISTS ux_payment_id_once;
ALTER TABLE x402_settlement_attempts
  ALTER COLUMN caller_payment_id DROP NOT NULL;

DELETE FROM schema_migrations WHERE filename = '002_x402_integrity.sql';

COMMIT;

-- Manual-confirm rollback for 005. The prior function body is intentionally
-- not restored automatically; removing this guard requires an incident review.
BEGIN;

DELETE FROM schema_migrations WHERE filename = '005_x402_lease_takeover_guard.sql';

COMMIT;

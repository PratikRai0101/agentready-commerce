-- x402 durable settlement state (managed PostgreSQL, serverless-safe).
--
-- Design notes (see architecture review):
-- * One row per stable operation_id (server-derived, never caller identity).
-- * Replacement payment IDs are blocked by ux_active_order_intent while any
--   attempt for (order, intent) is unresolved. `manual` STAYS blocking; only
--   `released` (operator-only) frees the slot.
-- * Leases + fence tokens: every state-changing CAS verifies lease_owner AND
--   fence_token. A paused worker that lost its lease can no longer write.
-- * RBAC is applied out-of-band at deploy (see deploy checklist, not here):
--   release is operator-CLI-only. Recommended least-privilege GRANTs:
--     CREATE ROLE x402_app WITH LOGIN;
--     CREATE ROLE x402_operator WITH LOGIN;
--     GRANT SELECT, INSERT, UPDATE ON x402_settlement_attempts TO x402_app;
--     GRANT SELECT, INSERT ON x402_reconciliation_history TO x402_app;
--     GRANT SELECT, UPDATE ON x402_settlement_attempts TO x402_operator;
--     GRANT SELECT, INSERT ON x402_reconciliation_history TO x402_operator;

CREATE TYPE x402_attempt_status AS ENUM (
  'pending',
  'rejected',
  'settling',
  'awaiting_evidence',
  'settled',
  'mismatch',
  'manual',
  'released'
);

CREATE TABLE x402_settlement_attempts (
  operation_id        TEXT PRIMARY KEY,
  logical_order_id    TEXT NOT NULL,
  intent_version      INTEGER NOT NULL,
  request_digest      TEXT NOT NULL,
  resource            TEXT NOT NULL,
  auth_revision       TEXT NOT NULL,
  caller_payment_id   TEXT,
  signed_payload_enc  TEXT,
  payload_digest      TEXT,
  payer               TEXT,
  blockhash           TEXT,
  requirements_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              x402_attempt_status NOT NULL DEFAULT 'pending',
  tx_hash             TEXT,
  evidence_json       JSONB,
  lease_owner         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  fence_token         TEXT,
  released_to_approval TEXT,
  released_by         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_attempt_digest_payment
  ON x402_settlement_attempts (request_digest, caller_payment_id);

-- Blocks replacement payment IDs while unresolved. `manual` is intentionally
-- NOT excluded: only terminal-resolved or operator-released rows free the slot.
-- Blocks replacement payment IDs while unresolved. `manual` is intentionally
-- NOT excluded: only terminal-resolved rows or operator-released rows free
-- the slot.
CREATE UNIQUE INDEX ux_active_order_intent
  ON x402_settlement_attempts (logical_order_id, intent_version)
  WHERE status NOT IN ('settled', 'rejected', 'mismatch', 'released');

-- A second live row under the same payment ID is rejected even across
-- different digests (backstop for the resolve-or-create read checks).
CREATE UNIQUE INDEX ux_pid_active
  ON x402_settlement_attempts (caller_payment_id)
  WHERE status NOT IN ('settled', 'rejected', 'mismatch', 'released')
  AND caller_payment_id IS NOT NULL;

CREATE TABLE x402_reconciliation_history (
  id              BIGSERIAL PRIMARY KEY,
  operation_id    TEXT NOT NULL REFERENCES x402_settlement_attempts(operation_id),
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_status     x402_attempt_status NOT NULL,
  to_status       x402_attempt_status NOT NULL,
  trigger         TEXT NOT NULL,
  note            TEXT NOT NULL,
  lease_owner     TEXT
);
CREATE INDEX ix_recon_op ON x402_reconciliation_history (operation_id, id);
CREATE INDEX ix_attempts_sweep ON x402_settlement_attempts (status, lease_expires_at)
  WHERE status IN ('settling', 'awaiting_evidence');
CREATE INDEX ix_attempts_order ON x402_settlement_attempts (logical_order_id);

-- Role separation, enforced technically (not by documentation alone).
-- The application role can never write a `released` row: the trigger below
-- rejects entry into `released` for every current_user except x402_operator,
-- and triggers fire for superusers as well. Operator access is granted
-- out-of-band (deployment IAM / operator credentials); roles are created
-- NOLOGIN here so nothing can authenticate as them until deployment binds
-- auth. The operator CLI must connect as x402_operator.
DO $$ BEGIN
  CREATE ROLE x402_app WITH NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE ROLE x402_operator WITH NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE ON x402_settlement_attempts TO x402_app, x402_operator;
GRANT SELECT, INSERT ON x402_reconciliation_history TO x402_app, x402_operator;
GRANT USAGE, SELECT ON SEQUENCE x402_reconciliation_history_id_seq TO x402_app, x402_operator;
-- No DELETE grant anywhere: rows are append-terminal. Destructive rollback is a
-- manual-confirm .down.sql procedure, never application behavior.

CREATE OR REPLACE FUNCTION x402_reject_app_release() RETURNS trigger
  LANGUAGE plpgsql AS $func$
BEGIN
  -- Direct INSERTs in released state are never legitimate (release is an
  -- UPDATE manual→released transition only).
  IF TG_OP = 'INSERT' AND NEW.status = 'released' THEN
    RAISE EXCEPTION 'x402: direct insert in released state is forbidden'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'released' AND (OLD.status IS DISTINCT FROM 'released')
     AND current_user <> 'x402_operator' THEN
    RAISE EXCEPTION 'x402: transition to released requires the x402_operator role (current_user=%)', current_user
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$func$;

CREATE TRIGGER x402_no_app_release
  BEFORE INSERT OR UPDATE ON x402_settlement_attempts
  FOR EACH ROW EXECUTE FUNCTION x402_reject_app_release();

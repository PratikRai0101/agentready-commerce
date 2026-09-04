-- Integrity additions for databases that already applied migration 001.
-- Fail closed if existing rows cannot satisfy the new single-use invariant;
-- operators must resolve those rows before retrying the migration.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM x402_settlement_attempts WHERE caller_payment_id IS NULL
  ) THEN
    RAISE EXCEPTION 'x402: cannot enforce non-null payment identifiers while null rows exist';
  END IF;
END $$;

ALTER TABLE x402_settlement_attempts
  ALTER COLUMN caller_payment_id SET NOT NULL;

-- A payment identifier is single-use across terminal states too. Reusing an
-- identifier after rejection or settlement must never open a new attempt.
CREATE UNIQUE INDEX ux_payment_id_once
  ON x402_settlement_attempts (caller_payment_id);

-- A settled resource spend is single-use for the exact logical request. A new
-- intent version or digest is a new authorization; a new payment ID for the
-- same request is only a replay of the cached result.
CREATE UNIQUE INDEX ux_settled_request_once
  ON x402_settlement_attempts (logical_order_id, intent_version, request_digest, resource)
  WHERE status = 'settled';

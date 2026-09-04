-- Allow the intended recovery operation: an app/operator role may replace an
-- expired lease with a fresh fence while retaining settling/awaiting_evidence
-- status. All other role transitions remain governed by migration 004.
CREATE OR REPLACE FUNCTION x402_enforce_role_state() RETURNS trigger
  LANGUAGE plpgsql AS $func$
DECLARE
  role_guarded BOOLEAN := current_user IN ('x402_app', 'x402_operator');
BEGIN
  IF NOT role_guarded THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.tx_hash IS NOT NULL OR NEW.evidence_json IS NOT NULL
       OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.fence_token IS NOT NULL
       OR NEW.released_to_approval IS NOT NULL OR NEW.released_by IS NOT NULL
       OR NEW.release_evidence_json IS NOT NULL THEN
      RAISE EXCEPTION 'x402: role may only insert a clean pending attempt'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.logical_order_id IS DISTINCT FROM OLD.logical_order_id
     OR NEW.intent_version IS DISTINCT FROM OLD.intent_version
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.resource IS DISTINCT FROM OLD.resource
     OR NEW.auth_revision IS DISTINCT FROM OLD.auth_revision
     OR NEW.caller_payment_id IS DISTINCT FROM OLD.caller_payment_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'x402: attempt identity is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'released' THEN
    IF current_user <> 'x402_operator' OR OLD.status <> 'manual'
       OR NEW.released_to_approval IS NULL OR NEW.released_by IS NULL
       OR NEW.release_evidence_json IS NULL THEN
      RAISE EXCEPTION 'x402: released requires x402_operator manual release evidence'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- claimRowForTakeover/claimForReconcile deliberately replace an expired
  -- lease in place and rotate the fence without changing the business state.
  IF NEW.status = OLD.status
     AND OLD.status IN ('settling', 'awaiting_evidence')
     AND (OLD.lease_expires_at IS NULL OR OLD.lease_expires_at <= now()) THEN
    IF NEW.lease_owner IS NULL OR NEW.fence_token IS NULL
       OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= now() THEN
      RAISE EXCEPTION 'x402: lease takeover requires a fresh live lease and fence'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status IN ('settled', 'rejected', 'mismatch', 'manual', 'released') THEN
      RAISE EXCEPTION 'x402: terminal attempt is immutable'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'pending' THEN
      IF NEW.tx_hash IS DISTINCT FROM OLD.tx_hash
         OR NEW.evidence_json IS DISTINCT FROM OLD.evidence_json
         OR NEW.payer IS DISTINCT FROM OLD.payer
         OR NEW.blockhash IS DISTINCT FROM OLD.blockhash
         OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
         OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
         OR NEW.fence_token IS DISTINCT FROM OLD.fence_token
         OR NEW.released_to_approval IS DISTINCT FROM OLD.released_to_approval
         OR NEW.released_by IS DISTINCT FROM OLD.released_by
         OR NEW.release_evidence_json IS DISTINCT FROM OLD.release_evidence_json THEN
        RAISE EXCEPTION 'x402: pending staging may not set settlement state'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.lease_owner IS NULL OR OLD.fence_token IS NULL OR OLD.lease_expires_at IS NULL
       OR OLD.lease_expires_at <= now()
       OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
       OR NEW.fence_token IS DISTINCT FROM OLD.fence_token THEN
      RAISE EXCEPTION 'x402: state update requires a live lease and unchanged fence'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'settling' THEN
    IF NEW.lease_owner IS NULL OR NEW.fence_token IS NULL
       OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= now() THEN
      RAISE EXCEPTION 'x402: settling claim requires a live lease and fence'
        USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.status IN ('settling', 'awaiting_evidence')
        AND NEW.status IN ('settling', 'awaiting_evidence', 'settled', 'mismatch', 'manual') THEN
    IF OLD.lease_owner IS NULL OR OLD.fence_token IS NULL OR OLD.lease_expires_at IS NULL
       OR OLD.lease_expires_at <= now()
       OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
       OR NEW.fence_token IS DISTINCT FROM OLD.fence_token THEN
      RAISE EXCEPTION 'x402: transition requires the current live lease and fence'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'x402: illegal role transition %->%', OLD.status, NEW.status
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'settled'
     AND (NEW.tx_hash IS NULL OR jsonb_typeof(NEW.evidence_json) <> 'object') THEN
    RAISE EXCEPTION 'x402: settled requires transaction and evidence'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'awaiting_evidence' AND NEW.tx_hash IS NULL THEN
    RAISE EXCEPTION 'x402: awaiting_evidence requires a transaction signature'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$func$;

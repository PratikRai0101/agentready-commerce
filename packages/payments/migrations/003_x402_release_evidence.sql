-- Keep operator release evidence with the attempt, not only in a free-form
-- history note. This is additive so databases that applied 001/002 retain
-- their existing settlement rows.
ALTER TABLE x402_settlement_attempts
  ADD COLUMN release_evidence_json JSONB;

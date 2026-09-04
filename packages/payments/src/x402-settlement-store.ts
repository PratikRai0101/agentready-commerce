import { createCipheriv, createDecipheriv, createHash, randomFillSync, randomUUID } from "node:crypto";
import { Pool } from "pg";

/**
 * Durable x402 settlement state (managed PostgreSQL, serverless-safe).
 *
 * Replaces the process-local pending/indeterminate/processed Maps. Correctness
 * rules enforced here, not by callers:
 * - Stable operation identity includes a server-side authorization revision,
 *   so a fresh approval of identical terms yields a NEW operation_id and the
 *   primary key can never block a legitimately re-authorized attempt.
 * - `manual` stays blocking: only terminal-resolved rows or operator
 *   `released` rows free the (order, intent) slot (partial unique index).
 * - Every state-changing CAS verifies lease_owner AND fence_token. A paused
 *   worker that lost its lease is rejected at the next CAS, which substantially
 *   reduces duplicate-submission risk — but a worker paused mid-HTTP-call after
 *   a successful revalidation can still have one unknown-odds submission in
 *   flight. Read this as risk reduction, never as a guarantee: the database
 *   cannot fence the external facilitator.
 * - Signed payloads are AES-256-GCM encrypted at rest; logs/audit carry
 *   digests and ids only, never payloads or keys.
 */

export type AttemptStatus =
  | "pending"
  | "rejected"
  | "settling"
  | "awaiting_evidence"
  | "settled"
  | "mismatch"
  | "manual"
  | "released";

export const TERMINAL_RESOLVED: readonly AttemptStatus[] = ["settled", "rejected", "mismatch", "released"];

export type DbExecutor = {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
};

/**
 * Executor with explicit transactions. State change + history row are always
 * committed atomically: a crash can never leave a transition unaudited.
 */
export type TransactableExecutor = DbExecutor & {
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
};

export type StoredAttempt = {
  operationId: string;
  logicalOrderId: string;
  intentVersion: number;
  requestDigest: string;
  resource: string;
  authRevision: string;
  callerPaymentId: string | null;
  signedPayloadEnc: string | null;
  payloadDigest: string | null;
  payer: string | null;
  /** Recent blockhash extracted from the staged signed transaction (null when unparseable). */
  blockhash: string | null;
  requirementsJson: unknown;
  status: AttemptStatus;
  txHash: string | null;
  evidenceJson: unknown;
  releaseEvidenceJson: unknown;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fenceToken: string | null;
  releasedToApproval: string | null;
  releasedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResolveInput = {
  logicalOrderId: string;
  intentVersion: number;
  requestDigest: string;
  resource: string;
  /** Current server-side approval id, or undefined pre-approval. */
  approvalEventId?: string;
  callerPaymentId: string;
  /** Server-derived canonical payment terms, persisted for reconciliation. */
  requirementsJson?: unknown;
};

export type ResolveResult =
  | { kind: "created"; row: StoredAttempt }
  | { kind: "existing"; row: StoredAttempt }
  | { kind: "approval_mismatch"; row: StoredAttempt; detail: string }
  | { kind: "release_required"; row: StoredAttempt; detail: string };

/**
 * Approval binding on reuse. Pre-approval spends (sauth_* revisions) bind
 * nothing and accept any/no presented approval. Spends bound to an approval
 * (appr_* revisions, i.e. post-release attempts) require that exact id —
 * anything else is a 409, never a silent join under stale authorization.
 */
export function approvalMismatch(rowAuthRevision: string, presentedApprovalEventId?: string): boolean {
  if (!rowAuthRevision.startsWith("appr_")) return false;
  if (!presentedApprovalEventId) return true;
  return presentedApprovalEventId !== rowAuthRevision;
}

const APPROVAL_MISMATCH_DETAIL =
  "Presented approval does not match this attempt's bound authorization revision.";

export type ReleaseEvidence = {
  operatorId: string;
  newApprovalEventId: string;
  note: string;
  /** Recent blockhash of the attempt's signed transaction (verified RPC verdict). */
  blockhash: string;
  /** Canonical isBlockhashValid verdict: must be false (provably expired). */
  blockhashValid: boolean;
  /** Chain slot at which validity was checked (audit context; always present). */
  checkedSlot: number;
  transferVerification: "verified" | "mismatch" | "unavailable";
};

function rowFromDb(row: Record<string, unknown>): StoredAttempt {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    operationId: String(row.operation_id),
    logicalOrderId: String(row.logical_order_id),
    intentVersion: num(row.intent_version),
    requestDigest: String(row.request_digest),
    resource: String(row.resource),
    authRevision: String(row.auth_revision),
    callerPaymentId: str(row.caller_payment_id),
    payer: str(row.payer),
    blockhash: str(row.blockhash),
    signedPayloadEnc: str(row.signed_payload_enc),
    payloadDigest: str(row.payload_digest),
    requirementsJson: row.requirements_json ?? {},
    status: row.status as AttemptStatus,
    txHash: str(row.tx_hash),
    evidenceJson: row.evidence_json ?? null,
    releaseEvidenceJson: row.release_evidence_json ?? null,
    leaseOwner: str(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    fenceToken: str(row.fence_token),
    releasedToApproval: str(row.released_to_approval),
    releasedBy: str(row.released_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Server-derived stable identity. Caller payment IDs are correlated fields, never identity. */
export function buildOperationId(input: {
  logicalOrderId: string;
  intentVersion: number;
  requestDigest: string;
  resource: string;
  authRevision: string;
}): string {
  return createHash("sha256")
    .update(
      [input.logicalOrderId, String(input.intentVersion), input.requestDigest, input.resource, input.authRevision].join("|"),
      "utf8",
    )
    .digest("hex");
}

export function mintSpendAuthRevision(): string {
  return `sauth_${randomUUID().replace(/-/g, "")}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>).code === "23505"
  );
}

/**
 * Release evidence gate (pure). Release additionally requires an unresolved
 * row in `manual` status whose stored blockhash equals the evidence blockhash
 * (both checked in SQL). A crash-after-settle-before-tx-hash row carries NO tx
 * hash but DOES carry the staged blockhash, so expiry is still provable — yet
 * such rows are never presented as automatically reconcilable.
 */
export function validateReleaseEvidence(evidence: ReleaseEvidence): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!evidence.operatorId || evidence.operatorId.length === 0) reasons.push("operator identity is required");
  if (!evidence.newApprovalEventId || !evidence.newApprovalEventId.startsWith("appr_")) {
    reasons.push("release must cite the new server-generated approval event id");
  }
  if (!evidence.blockhash || evidence.blockhash.length === 0) {
    reasons.push("blockhash of the attempt's signed transaction is required");
  }
  if (evidence.blockhashValid !== false) {
    reasons.push("canonical isBlockhashValid verdict must report expired (false); unproven expiry never releases");
  }
  if (!Number.isInteger(evidence.checkedSlot) || evidence.checkedSlot < 0) {
    reasons.push("checkedSlot must be the integer chain slot of the validity check");
  }
  if (evidence.transferVerification !== "mismatch" && evidence.transferVerification !== "unavailable") {
    reasons.push("chain shows a verified settlement for this attempt; release is wrong, reconcile instead");
  }
  if (!evidence.note || evidence.note.length === 0) reasons.push("operator note is required");
  return { ok: reasons.length === 0, reasons };
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw.trim())) {
    throw new Error("X402_STORE_ENC_KEY must be 32 bytes hex. Refusing to boot settlement storage.");
  }
  return Buffer.from(raw.trim(), "hex");
}

function encryptPayload(key: Buffer, plaintext: string): string {
  const iv = Buffer.alloc(IV_LENGTH);
  randomFillSync(iv);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptPayload(key: Buffer, ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export class UniqueViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniqueViolationError";
  }
}

export type SettlementStore = {
  resolveOrCreate(input: ResolveInput): Promise<ResolveResult>;
  getByOperationId(operationId: string): Promise<StoredAttempt | null>;
  findByDigestPayment(requestDigest: string, callerPaymentId: string): Promise<StoredAttempt | null>;
  findByPaymentId(callerPaymentId: string): Promise<StoredAttempt[]>;
  /** Settled replay for the exact logical request; null when no result exists. */
  findSettledAttempt(
    logicalOrderId: string,
    intentVersion: number,
    requestDigest: string,
    resource: string,
  ): Promise<StoredAttempt | null>;
  /** Newest-or-oldest active row for (order, intent); null when none unresolved. */
  findActiveAttempt(logicalOrderId: string, intentVersion: number): Promise<StoredAttempt | null>;
  /** Liveness probe (SELECT 1). Used at boot and by restart sweeps. */
  ping(): Promise<void>;
  /** Atomic pending→settling + lease+fence acquisition. Single winner. */
  claimForSettle(
    operationId: string,
    owner: string,
    leaseTtlMs: number,
    sealedPayload?: string,
    payloadDigest?: string,
  ): Promise<StoredAttempt | null>;
  /** Revalidate ownership immediately before the settle HTTP call; refreshes lease. */
  revalidateForSettle(operationId: string, owner: string, fenceToken: string, leaseTtlMs: number): Promise<StoredAttempt | null>;
  /** Owner+fence-checked terminal/pending transition + history row, one tx. */
  transition(
    operationId: string,
    from: AttemptStatus[],
    to: AttemptStatus,
    update: Partial<Pick<StoredAttempt, "txHash" | "evidenceJson" | "signedPayloadEnc" | "payloadDigest" | "callerPaymentId" | "payer" | "blockhash" | "requirementsJson">>,
    owner: string | null,
    fenceToken: string | null,
    trigger: string,
    note: string,
  ): Promise<StoredAttempt | null>;
  /** Sweeper claim over expired leases. */
  claimForReconcile(owner: string, leaseTtlMs: number, limit?: number): Promise<StoredAttempt[]>;
  /**
   * Single-row takeover claim: atomically takes `settling` or
   * `awaiting_evidence` rows whose lease has expired, with a fresh fence.
   * Used when re-driving a lapsed attempt; never touches other rows.
   */
  claimRowForTakeover(operationId: string, owner: string, leaseTtlMs: number): Promise<StoredAttempt | null>;
  releaseAttempt(operationId: string, evidence: ReleaseEvidence): Promise<{ ok: boolean; row?: StoredAttempt; reasons?: string[] }>;
  sweepCandidates(limit?: number): Promise<StoredAttempt[]>;
  decryptSignedPayload(ciphertext: string): string;
  /** Encrypts for storage (Postgres) or passes through labeled plaintext (test double). */
  sealSignedPayload(plaintext: string): string;
  clearForTests(): Promise<void>;
};

export class PostgresSettlementStore implements SettlementStore {
  private readonly exec: TransactableExecutor;
  private readonly encKey: Buffer;

  constructor(exec: TransactableExecutor, encKey: Buffer) {
    this.exec = exec;
    this.encKey = encKey;
  }

  decryptSignedPayload(ciphertext: string): string {
    return decryptPayload(this.encKey, ciphertext);
  }

  sealSignedPayload(plaintext: string): string {
    return this.encryptSignedPayload(plaintext);
  }

  async findByDigestPayment(requestDigest: string, callerPaymentId: string): Promise<StoredAttempt | null> {
    const result = await this.exec.query(
      `SELECT * FROM x402_settlement_attempts WHERE request_digest = $1 AND caller_payment_id = $2 ORDER BY created_at ASC LIMIT 1`,
      [requestDigest, callerPaymentId],
    );
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  async findByPaymentId(callerPaymentId: string): Promise<StoredAttempt[]> {
    const result = await this.exec.query(
      `SELECT * FROM x402_settlement_attempts WHERE caller_payment_id = $1 ORDER BY created_at ASC`,
      [callerPaymentId],
    );
    return result.rows.map(rowFromDb);
  }

  async findSettledAttempt(
    logicalOrderId: string,
    intentVersion: number,
    requestDigest: string,
    resource: string,
  ): Promise<StoredAttempt | null> {
    const result = await this.exec.query(
      `SELECT * FROM x402_settlement_attempts
       WHERE logical_order_id = $1 AND intent_version = $2
         AND request_digest = $3 AND resource = $4 AND status = 'settled'
       ORDER BY updated_at DESC LIMIT 1`,
      [logicalOrderId, intentVersion, requestDigest, resource],
    );
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  async findActiveAttempt(logicalOrderId: string, intentVersion: number): Promise<StoredAttempt | null> {
    const result = await this.exec.query(
      `SELECT * FROM x402_settlement_attempts
       WHERE logical_order_id = $1 AND intent_version = $2
         AND status NOT IN ('settled','rejected','mismatch','released')
       ORDER BY created_at ASC LIMIT 1`,
      [logicalOrderId, intentVersion],
    );
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  async ping(): Promise<void> {
    await this.exec.query("SELECT 1", []);
  }

  encryptSignedPayload(plaintext: string): string {
    return encryptPayload(this.encKey, plaintext);
  }

  async getByOperationId(operationId: string): Promise<StoredAttempt | null> {
    const result = await this.exec.query("SELECT * FROM x402_settlement_attempts WHERE operation_id = $1", [operationId]);
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  async findActive(logicalOrderId: string, intentVersion: number): Promise<StoredAttempt | null> {
    const result = await this.exec.query(
      `SELECT * FROM x402_settlement_attempts
       WHERE logical_order_id = $1 AND intent_version = $2
         AND status NOT IN ('settled','rejected','mismatch','released')
       ORDER BY created_at ASC LIMIT 1`,
      [logicalOrderId, intentVersion],
    );
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  async findLatestReleased(logicalOrderId: string, intentVersion: number): Promise<StoredAttempt | null> {
    const result = await this.exec.query(
      `SELECT * FROM x402_settlement_attempts
       WHERE logical_order_id = $1 AND intent_version = $2 AND status = 'released'
       ORDER BY updated_at DESC LIMIT 1`,
      [logicalOrderId, intentVersion],
    );
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  async resolveOrCreate(input: ResolveInput): Promise<ResolveResult> {
    // Exact-key replay first: the same (digest, payment id) pair always
    // resolves to its existing row in ANY status (settled replay, reconcile
    // join, ownership check). This must precede the active-slot check so a
    // settled attempt replays instead of opening a duplicate row.
    const replay = await this.exec.query(
      `SELECT * FROM x402_settlement_attempts WHERE request_digest = $1 AND caller_payment_id = $2 ORDER BY created_at ASC LIMIT 1`,
      [input.requestDigest, input.callerPaymentId],
    );
    const replayRow = replay.rows[0];
    if (replayRow) {
      const existing = rowFromDb(replayRow);
      if (approvalMismatch(existing.authRevision, input.approvalEventId)) {
        return { kind: "approval_mismatch", row: existing, detail: APPROVAL_MISMATCH_DETAIL };
      }
      return { kind: "existing", row: existing };
    }

    // Same payment id on any other live row: surface it so the caller gets a
    // deterministic 409 instead of racing a second insert (the partial unique
    // index is the backstop; this read is the fast path).
    const pidRows = await this.exec.query(
      `SELECT * FROM x402_settlement_attempts WHERE caller_payment_id = $1 AND status NOT IN ('settled','rejected','mismatch','released') ORDER BY created_at ASC LIMIT 1`,
      [input.callerPaymentId],
    );
    const pidRow = pidRows.rows[0];
    if (pidRow) {
      const existing = rowFromDb(pidRow);
      if (approvalMismatch(existing.authRevision, input.approvalEventId)) {
        return { kind: "approval_mismatch", row: existing, detail: APPROVAL_MISMATCH_DETAIL };
      }
      return { kind: "existing", row: existing };
    }

    const active = await this.findActiveAttempt(input.logicalOrderId, input.intentVersion);
    if (active) {
      if (approvalMismatch(active.authRevision, input.approvalEventId)) {
        return { kind: "approval_mismatch", row: active, detail: APPROVAL_MISMATCH_DETAIL };
      }
      return { kind: "existing", row: active };
    }

    const settled = await this.findSettledAttempt(
      input.logicalOrderId,
      input.intentVersion,
      input.requestDigest,
      input.resource,
    );
    if (settled) {
      if (approvalMismatch(settled.authRevision, input.approvalEventId)) {
        return { kind: "approval_mismatch", row: settled, detail: APPROVAL_MISMATCH_DETAIL };
      }
      return { kind: "existing", row: settled };
    }

    const released = await this.findLatestReleased(input.logicalOrderId, input.intentVersion);
    let authRevision: string;
    if (released) {
      if (!input.approvalEventId || input.approvalEventId !== released.releasedToApproval) {
        return {
          kind: "release_required",
          row: released,
          detail: "A prior attempt was operator-released. Present the cited new approval event id to open a fresh attempt.",
        };
      }
      authRevision = input.approvalEventId;
    } else {
      authRevision = input.approvalEventId ?? mintSpendAuthRevision();
    }

    const operationId = buildOperationId({
      logicalOrderId: input.logicalOrderId,
      intentVersion: input.intentVersion,
      requestDigest: input.requestDigest,
      resource: input.resource,
      authRevision,
    });
    try {
      const result = await this.exec.transaction(async (tx) => {
        await tx.query("SELECT set_config('x402_store_history_recorded', 'true', true)");
        const inserted = await tx.query(
          `INSERT INTO x402_settlement_attempts
             (operation_id, logical_order_id, intent_version, request_digest, resource, auth_revision, caller_payment_id, requirements_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
          [
            operationId,
            input.logicalOrderId,
            input.intentVersion,
            input.requestDigest,
            input.resource,
            authRevision,
            input.callerPaymentId,
            JSON.stringify(input.requirementsJson ?? {}),
          ],
        );
        const row = rowFromDb(inserted.rows[0] as Record<string, unknown>);
        await this.appendHistoryOn(
          tx, row.operationId, "—", "pending", "accept-intake", `id=${operationId.slice(0, 12)}… rev=${authRevision.slice(0, 12)}…`, null,
        );
        return row;
      });
      return { kind: "created", row: result };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Concurrent mint race or active-slot/pid race: re-read the winner in a
      // fixed order (exact key, same payment id, active slot). Never duplicate.
      // Every re-read classifies approval binding like the fast paths.
      const candidates = [
        await this.getByOperationId(operationId),
        await this.findByDigestPayment(input.requestDigest, input.callerPaymentId),
        ...await this.findByPaymentId(input.callerPaymentId),
        await this.findActiveAttempt(input.logicalOrderId, input.intentVersion),
        await this.findSettledAttempt(input.logicalOrderId, input.intentVersion, input.requestDigest, input.resource),
      ];
      const winner = candidates.find((r) => r !== null) ?? null;
      if (!winner) throw new UniqueViolationError("Unique conflict without a readable winner; retry the accept.");
      if (approvalMismatch(winner.authRevision, input.approvalEventId)) {
        return { kind: "approval_mismatch", row: winner, detail: APPROVAL_MISMATCH_DETAIL };
      }
      return { kind: "existing", row: winner };
    }
  }

  async claimForSettle(
    operationId: string,
    owner: string,
    leaseTtlMs: number,
    sealedPayload?: string,
    payloadDigest?: string,
  ): Promise<StoredAttempt | null> {
    const fence = randomUUID();
    // Expiry is computed caller-side; all expiry *comparisons* use DB now().
    // First claimer stamps the signed payload atomically with the claim.
    const result = await this.exec.query(
      `UPDATE x402_settlement_attempts
       SET status = 'settling', lease_owner = $2,
           lease_expires_at = now() + ($3::double precision * interval '1 millisecond'), fence_token = $4,
           signed_payload_enc = COALESCE(signed_payload_enc, $5), payload_digest = COALESCE(payload_digest, $6),
           updated_at = now()
       WHERE operation_id = $1 AND status = 'pending' RETURNING *`,
      [operationId, owner, leaseTtlMs, fence, sealedPayload ?? null, payloadDigest ?? null],
    );
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  async revalidateForSettle(
    operationId: string,
    owner: string,
    fenceToken: string,
    leaseTtlMs: number,
  ): Promise<StoredAttempt | null> {
    const result = await this.exec.query(
      `UPDATE x402_settlement_attempts
       SET lease_expires_at = now() + ($4::double precision * interval '1 millisecond'), updated_at = now()
       WHERE operation_id = $1 AND status = 'settling' AND lease_owner = $2 AND fence_token = $3
          AND lease_expires_at > now() RETURNING *`,
      [operationId, owner, fenceToken, leaseTtlMs],
    );
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  async transition(
    operationId: string,
    from: AttemptStatus[],
    to: AttemptStatus,
    update: Partial<Pick<StoredAttempt, "txHash" | "evidenceJson" | "signedPayloadEnc" | "payloadDigest" | "callerPaymentId" | "payer" | "blockhash" | "requirementsJson">>,
    owner: string | null,
    fenceToken: string | null,
    trigger: string,
    note: string,
  ): Promise<StoredAttempt | null> {
    const leaseBound = owner !== null || fenceToken !== null;
    const pendingStage = from.length === 1 && from[0] === "pending" && to === "pending";
    if (!pendingStage && !leaseBound) return null;
    if (leaseBound && (owner === null || fenceToken === null)) return null;
    const sets: string[] = ["status = $2", "updated_at = now()"];
    const params: unknown[] = [operationId, to];
    let idx = 3;
    const col = (name: string, value: unknown) => {
      sets.push(`${name} = $${idx}`);
      params.push(value);
      idx += 1;
    };
    if (update.txHash !== undefined) col("tx_hash", update.txHash);
    if (update.evidenceJson !== undefined) col("evidence_json", JSON.stringify(update.evidenceJson));
    if (update.signedPayloadEnc !== undefined) col("signed_payload_enc", update.signedPayloadEnc);
    if (update.payloadDigest !== undefined) col("payload_digest", update.payloadDigest);
    if (update.callerPaymentId !== undefined) col("caller_payment_id", update.callerPaymentId);
    if (update.blockhash !== undefined) col("blockhash", update.blockhash);
    if (update.payer !== undefined) col("payer", update.payer);
    if (update.requirementsJson !== undefined) col("requirements_json", JSON.stringify(update.requirementsJson));
    let where = `operation_id = $1 AND status = ANY($${idx}::x402_attempt_status[])`;
    params.push(from);
    idx += 1;
    if (owner !== null) {
      where += ` AND lease_owner = $${idx}`;
      params.push(owner);
      idx += 1;
      where += ` AND fence_token = $${idx}`;
      params.push(fenceToken);
      idx += 1;
      where += " AND lease_expires_at > now()";
    }
    const result = await this.exec.transaction(async (tx) => {
      await tx.query("SELECT set_config('x402_store_history_recorded', 'true', true)");
      // Observe the single current status under lock first: the history row
      // carries one enum value, never the multi-status `from` candidate list
      // (writing from.join(",") violates the enum and rolls the transition
      // back — the production cause of a settled-but-unpersisted attempt).
      const current = await tx.query(
        `SELECT status FROM x402_settlement_attempts WHERE operation_id = $1 FOR UPDATE`,
        [operationId],
      );
      const currentStatus = current.rows[0]?.status as string | undefined;
      if (!currentStatus || !(from as string[]).includes(currentStatus)) return null;
      const updated = await tx.query(
        `UPDATE x402_settlement_attempts SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
        params,
      );
      const row = updated.rows[0];
      if (!row) return null;
      await this.appendHistoryOn(tx, operationId, currentStatus, to, trigger, note, owner);
      return rowFromDb(row);
    });
    return result;
  }

  async claimRowForTakeover(operationId: string, owner: string, leaseTtlMs: number): Promise<StoredAttempt | null> {
    const fence = randomUUID();
    const result = await this.exec.query(
      `UPDATE x402_settlement_attempts
       SET lease_owner = $2,
           lease_expires_at = now() + ($3::double precision * interval '1 millisecond'), fence_token = $4, updated_at = now()
       WHERE operation_id = $1 AND status IN ('settling','awaiting_evidence')
         AND (lease_expires_at IS NULL OR lease_expires_at <= now()) RETURNING *`,
      [operationId, owner, leaseTtlMs, fence],
    );
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  async claimForReconcile(owner: string, leaseTtlMs: number, limit = 10): Promise<StoredAttempt[]> {
    const fence = randomUUID();
    const result = await this.exec.query(
      `UPDATE x402_settlement_attempts
       SET lease_owner = $1,
           lease_expires_at = now() + ($2::double precision * interval '1 millisecond'), fence_token = $3, updated_at = now()
       WHERE operation_id IN (
          SELECT operation_id FROM x402_settlement_attempts
          WHERE status IN ('settling','awaiting_evidence')
            AND (lease_expires_at IS NULL OR lease_expires_at <= now())
          ORDER BY updated_at ASC LIMIT $4
          FOR UPDATE SKIP LOCKED
        )
         AND status IN ('settling','awaiting_evidence')
         AND (lease_expires_at IS NULL OR lease_expires_at <= now())
       RETURNING *`,
      [owner, leaseTtlMs, fence, limit],
    );
    return result.rows.map(rowFromDb);
  }

  async releaseAttempt(operationId: string, evidence: ReleaseEvidence): Promise<{ ok: boolean; row?: StoredAttempt; reasons?: string[] }> {
    const gate = validateReleaseEvidence(evidence);
    if (!gate.ok) return { ok: false, reasons: gate.reasons };
    const released = await this.exec.transaction(async (tx) => {
      await tx.query("SELECT set_config('x402_store_history_recorded', 'true', true)");
      const result = await tx.query(
        `UPDATE x402_settlement_attempts
         SET status = 'released', released_to_approval = $2, released_by = $3,
             release_evidence_json = $5::jsonb, updated_at = now()
         WHERE operation_id = $1 AND status = 'manual' AND blockhash IS NOT NULL AND blockhash = $4 RETURNING *`,
        [
          operationId,
          evidence.newApprovalEventId,
          evidence.operatorId,
          evidence.blockhash,
          JSON.stringify(evidence),
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      const parsed = rowFromDb(row);
      await this.appendHistoryOn(
        tx,
        operationId,
        "manual",
        "released",
        "operator-release",
        `${evidence.operatorId}: ${evidence.note} (blockhash=${evidence.blockhash.slice(0, 8)}..., slot=${evidence.checkedSlot}, transfer=${evidence.transferVerification})`,
        evidence.operatorId,
      );
      return parsed;
    });
    if (!released) {
      const current = await this.getByOperationId(operationId);
      if (!current) return { ok: false, reasons: ["unknown operation"] };
      if (current.status !== "manual") {
        return { ok: false, reasons: [`release requires status=manual (current: ${current.status})`] };
      }
      if (!current.blockhash) {
        return { ok: false, reasons: ["no bound blockhash on this attempt; resolve via incident track, release is refused"] };
      }
      return { ok: false, reasons: ["evidence blockhash does not match the attempt's staged blockhash"] };
    }
    return { ok: true, row: released };
  }

  async sweepCandidates(limit = 10): Promise<StoredAttempt[]> {
    const result = await this.exec.query(
      `SELECT * FROM x402_settlement_attempts
       WHERE status IN ('settling','awaiting_evidence')
       ORDER BY updated_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(rowFromDb);
  }

  async appendHistory(
    operationId: string,
    fromStatus: string,
    toStatus: string,
    trigger: string,
    note: string,
    leaseOwner: string | null,
  ): Promise<void> {
    return this.appendHistoryOn(this.exec, operationId, fromStatus, toStatus, trigger, note, leaseOwner);
  }

  private async appendHistoryOn(
    exec: DbExecutor,
    operationId: string,
    fromStatus: string,
    toStatus: string,
    trigger: string,
    note: string,
    leaseOwner: string | null,
  ): Promise<void> {
    await exec.query(
      `INSERT INTO x402_reconciliation_history (operation_id, from_status, to_status, trigger, note, lease_owner)
       VALUES ($1,$2::x402_attempt_status,$3::x402_attempt_status,$4,$5,$6)`,
      [operationId, fromStatus === "—" ? "pending" : fromStatus, toStatus, trigger, note, leaseOwner],
    );
  }

  async clearForTests(): Promise<void> {
    await this.exec.query("DELETE FROM x402_reconciliation_history", []);
    await this.exec.query("DELETE FROM x402_settlement_attempts", []);
  }
}

/**
 * Test/mock-only in-memory implementation of the same interface. Labeled
 * accordingly: never valid for devnet/production (see boot validation below).
 */
export class InMemorySettlementStore implements SettlementStore {
  private readonly attempts = new Map<string, StoredAttempt>();
  private readonly history: Array<{ operationId: string; from: string; to: string; trigger: string; note: string }> = [];
  readonly isTestDouble = true;

  historyForTests(): Array<{ operationId: string; from: string; to: string; trigger: string; note: string }> {
    return this.history.map((h) => ({ ...h }));
  }

  async findByDigestPayment(requestDigest: string, callerPaymentId: string): Promise<StoredAttempt | null> {
    const row = [...this.attempts.values()]
      .filter((r) => r.requestDigest === requestDigest && r.callerPaymentId === callerPaymentId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    return row ? this.clone(row) : null;
  }

  async findByPaymentId(callerPaymentId: string): Promise<StoredAttempt[]> {
    return [...this.attempts.values()]
      .filter((r) => r.callerPaymentId === callerPaymentId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((r) => this.clone(r));
  }

  async findSettledAttempt(
    logicalOrderId: string,
    intentVersion: number,
    requestDigest: string,
    resource: string,
  ): Promise<StoredAttempt | null> {
    const row = [...this.attempts.values()]
      .filter((r) => r.logicalOrderId === logicalOrderId)
      .filter((r) => r.intentVersion === intentVersion)
      .filter((r) => r.requestDigest === requestDigest && r.resource === resource)
      .find((r) => r.status === "settled");
    return row ? this.clone(row) : null;
  }

  async findActiveAttempt(logicalOrderId: string, intentVersion: number): Promise<StoredAttempt | null> {
    const row = [...this.attempts.values()]
      .filter((r) => r.logicalOrderId === logicalOrderId && r.intentVersion === intentVersion)
      .filter((r) => !["settled", "rejected", "mismatch", "released"].includes(r.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    return row ? this.clone(row) : null;
  }

  async ping(): Promise<void> {
    // In-memory double is trivially live.
  }

  decryptSignedPayload(ciphertext: string): string {
    // Test double only: holds plaintext, never used outside offline tests.
    return ciphertext;
  }

  sealSignedPayload(plaintext: string): string {
    // Test double only: no encryption; production rows are always sealed.
    return plaintext;
  }

  private clone(row: StoredAttempt): StoredAttempt {
    return JSON.parse(JSON.stringify(row)) as StoredAttempt;
  }

  async getByOperationId(operationId: string): Promise<StoredAttempt | null> {
    const row = this.attempts.get(operationId);
    return row ? this.clone(row) : null;
  }

  async resolveOrCreate(input: ResolveInput): Promise<ResolveResult> {
    // Exact-key replay first (see Postgres implementation): same
    // (digest, payment id) pair always resolves to its existing row.
    for (const row of this.attempts.values()) {
      if (row.requestDigest === input.requestDigest && row.callerPaymentId === input.callerPaymentId) {
        if (approvalMismatch(row.authRevision, input.approvalEventId)) {
          return { kind: "approval_mismatch", row: this.clone(row), detail: APPROVAL_MISMATCH_DETAIL };
        }
        return { kind: "existing", row: this.clone(row) };
      }
    }
    // A payment identifier is globally single-use, including after a terminal
    // result. The caller turns a different request digest into a 409.
    const pidRow = [...this.attempts.values()]
      .filter((r) => r.callerPaymentId === input.callerPaymentId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    if (pidRow) {
      if (approvalMismatch(pidRow.authRevision, input.approvalEventId)) {
        return { kind: "approval_mismatch", row: this.clone(pidRow), detail: APPROVAL_MISMATCH_DETAIL };
      }
      return { kind: "existing", row: this.clone(pidRow) };
    }
    const now = new Date().toISOString();
    const activeList = [...this.attempts.values()]
      .filter((r) => r.logicalOrderId === input.logicalOrderId && r.intentVersion === input.intentVersion)
      .filter((r) => !["settled", "rejected", "mismatch", "released"].includes(r.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    if (activeList) {
      if (approvalMismatch(activeList.authRevision, input.approvalEventId)) {
        return { kind: "approval_mismatch", row: this.clone(activeList), detail: APPROVAL_MISMATCH_DETAIL };
      }
      return { kind: "existing", row: this.clone(activeList) };
    }

    // Keep the in-memory scan synchronous: resolveOrCreate is intentionally
    // atomic within one event loop turn for the test double.
    const settledRow = [...this.attempts.values()]
      .filter((r) => r.logicalOrderId === input.logicalOrderId)
      .filter((r) => r.intentVersion === input.intentVersion)
      .filter((r) => r.requestDigest === input.requestDigest && r.resource === input.resource)
      .find((r) => r.status === "settled");
    const settled = settledRow ? this.clone(settledRow) : null;
    if (settled) {
      if (approvalMismatch(settled.authRevision, input.approvalEventId)) {
        return { kind: "approval_mismatch", row: settled, detail: APPROVAL_MISMATCH_DETAIL };
      }
      return { kind: "existing", row: settled };
    }

    const released = [...this.attempts.values()]
      .filter((r) => r.logicalOrderId === input.logicalOrderId && r.intentVersion === input.intentVersion && r.status === "released")
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    let authRevision: string;
    if (released) {
      if (!input.approvalEventId || input.approvalEventId !== released.releasedToApproval) {
        return {
          kind: "release_required",
          row: this.clone(released),
          detail: "A prior attempt was operator-released. Present the cited new approval event id to open a fresh attempt.",
        };
      }
      authRevision = input.approvalEventId;
    } else {
      authRevision = input.approvalEventId ?? mintSpendAuthRevision();
    }

    const operationId = buildOperationId({
      logicalOrderId: input.logicalOrderId,
      intentVersion: input.intentVersion,
      requestDigest: input.requestDigest,
      resource: input.resource,
      authRevision,
    });
    const existing = this.attempts.get(operationId);
    if (existing) return { kind: "existing", row: this.clone(existing) };
    const row: StoredAttempt = {
      operationId,
      logicalOrderId: input.logicalOrderId,
      intentVersion: input.intentVersion,
      requestDigest: input.requestDigest,
      resource: input.resource,
      authRevision,
      callerPaymentId: input.callerPaymentId,
      blockhash: null,
      signedPayloadEnc: null,
      payloadDigest: null,
      payer: null,
      requirementsJson: input.requirementsJson ?? {},
      status: "pending",
      txHash: null,
      evidenceJson: null,
      releaseEvidenceJson: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: null,
      releasedToApproval: null,
      releasedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    this.attempts.set(operationId, row);
    this.history.push({ operationId, from: "—", to: "pending", trigger: "accept-intake", note: `rev=${authRevision.slice(0, 12)}` });
    return { kind: "created", row: this.clone(row) };
  }

  async claimForSettle(
    operationId: string,
    owner: string,
    leaseTtlMs: number,
    sealedPayload?: string,
    payloadDigest?: string,
  ): Promise<StoredAttempt | null> {
    const row = this.attempts.get(operationId);
    if (!row || row.status !== "pending") return null;
    row.status = "settling";
    row.leaseOwner = owner;
    row.leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    row.fenceToken = randomUUID();
    if (row.signedPayloadEnc === null && sealedPayload !== undefined) row.signedPayloadEnc = sealedPayload;
    if (row.payloadDigest === null && payloadDigest !== undefined) row.payloadDigest = payloadDigest;
    row.updatedAt = new Date().toISOString();
    return this.clone(row);
  }

  async revalidateForSettle(
    operationId: string,
    owner: string,
    fenceToken: string,
    leaseTtlMs: number,
  ): Promise<StoredAttempt | null> {
    const row = this.attempts.get(operationId);
    if (!row || row.status !== "settling" || row.leaseOwner !== owner || row.fenceToken !== fenceToken) return null;
    if (row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) <= Date.now()) return null;
    row.leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    row.updatedAt = new Date().toISOString();
    return this.clone(row);
  }

  async transition(
    operationId: string,
    from: AttemptStatus[],
    to: AttemptStatus,
    update: Partial<Pick<StoredAttempt, "txHash" | "evidenceJson" | "signedPayloadEnc" | "payloadDigest" | "callerPaymentId" | "payer" | "blockhash" | "requirementsJson">>,
    owner: string | null,
    fenceToken: string | null,
    trigger: string,
    note: string,
  ): Promise<StoredAttempt | null> {
    const row = this.attempts.get(operationId);
    if (!row || !from.includes(row.status)) return null;
    if (owner !== null && row.leaseOwner !== owner) return null;
    if (fenceToken !== null && row.fenceToken !== fenceToken) return null;
    const fromStatus = row.status;
    Object.assign(row, {
      status: to,
      ...(update.txHash !== undefined ? { txHash: update.txHash } : {}),
      ...(update.evidenceJson !== undefined ? { evidenceJson: update.evidenceJson } : {}),
      ...(update.signedPayloadEnc !== undefined ? { signedPayloadEnc: update.signedPayloadEnc } : {}),
      ...(update.payloadDigest !== undefined ? { payloadDigest: update.payloadDigest } : {}),
      ...(update.callerPaymentId !== undefined ? { callerPaymentId: update.callerPaymentId } : {}),
      ...(update.blockhash !== undefined ? { blockhash: update.blockhash } : {}),
      ...(update.payer !== undefined ? { payer: update.payer } : {}),
      ...(update.requirementsJson !== undefined ? { requirementsJson: update.requirementsJson } : {}),
      updatedAt: new Date().toISOString(),
    });
    this.history.push({ operationId, from: fromStatus, to, trigger, note });
    return this.clone(row);
  }

  async claimRowForTakeover(operationId: string, owner: string, leaseTtlMs: number): Promise<StoredAttempt | null> {
    const row = this.attempts.get(operationId);
    if (!row || !["settling", "awaiting_evidence"].includes(row.status)) return null;
    if (row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) > Date.now()) return null;
    row.leaseOwner = owner;
    row.leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    row.fenceToken = randomUUID();
    row.updatedAt = new Date().toISOString();
    return this.clone(row);
  }

  async claimForReconcile(owner: string, leaseTtlMs: number, limit = 10): Promise<StoredAttempt[]> {
    const now = Date.now();
    const claimed: StoredAttempt[] = [];
    for (const row of [...this.attempts.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))) {
      if (claimed.length >= limit) break;
      if (!["settling", "awaiting_evidence"].includes(row.status)) continue;
      if (row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) > now) continue;
      row.leaseOwner = owner;
      row.leaseExpiresAt = new Date(now + leaseTtlMs).toISOString();
      row.fenceToken = randomUUID();
      row.updatedAt = new Date().toISOString();
      claimed.push(this.clone(row));
    }
    return claimed;
  }

  async releaseAttempt(operationId: string, evidence: ReleaseEvidence): Promise<{ ok: boolean; row?: StoredAttempt; reasons?: string[] }> {
    const gate = validateReleaseEvidence(evidence);
    if (!gate.ok) return { ok: false, reasons: gate.reasons };
    const row = this.attempts.get(operationId);
    if (!row || row.status !== "manual") {
      return { ok: false, reasons: [`release requires status=manual (current: ${row?.status ?? "unknown"})`] };
    }
    if (!row.blockhash) {
      return { ok: false, reasons: ["no bound blockhash on this attempt; resolve via incident track, release is refused"] };
    }
    if (row.blockhash !== evidence.blockhash) {
      return { ok: false, reasons: ["evidence blockhash does not match the attempt's staged blockhash"] };
    }
    row.status = "released";
    row.releasedToApproval = evidence.newApprovalEventId;
    row.releasedBy = evidence.operatorId;
    row.releaseEvidenceJson = { ...evidence };
    row.updatedAt = new Date().toISOString();
    this.history.push({ operationId, from: "manual", to: "released", trigger: "operator-release", note: `${evidence.operatorId}: ${evidence.note}` });
    return { ok: true, row: this.clone(row) };
  }

  async sweepCandidates(limit = 10): Promise<StoredAttempt[]> {
    return [...this.attempts.values()]
      .filter((r) => ["settling", "awaiting_evidence"].includes(r.status))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
      .slice(0, limit)
      .map((r) => this.clone(r));
  }

  async clearForTests(): Promise<void> {
    this.attempts.clear();
  }
}

export type SettlementStoreConfig = {
  databaseUrl?: string;
  encKeyHex?: string;
  poolMax?: number;
  statementTimeoutMs?: number;
  mode: "mock" | "devnet";
  nodeEnv?: string;
  settlementEnabled?: boolean;
};

export class SettlementBootError extends Error {}
export class SettlementDisabledError extends Error {}

/**
 * Boot validation. Memory backing is allowed ONLY for mock mode or tests;
 * devnet and production fail closed without PostgreSQL + encryption key.
 * There is no memory fallback for devnet: rollback disables settlement
 * (X402_SETTLEMENT_ENABLED=false → 503), never returns to memory.
 */
export function assertSettlementStoreAllowed(config: SettlementStoreConfig): "postgres" | "memory" {
  if (config.settlementEnabled === false) {
    throw new SettlementDisabledError("x402 settlement is disabled by operator kill-switch.");
  }
  const production = (config.nodeEnv ?? process.env.NODE_ENV) === "production";
  if (config.mode === "devnet" || production) {
    if (!config.databaseUrl) {
      throw new SettlementBootError("PostgreSQL DATABASE_URL is required for x402 devnet/production settlement.");
    }
    parseEncryptionKey(config.encKeyHex);
    return "postgres";
  }
  return "memory";
}

/**
 * Wrap a pg Pool as a TransactableExecutor. Interactive transactions use a
 * dedicated client with BEGIN/COMMIT/ROLLBACK; the pool itself stays the
 * autocommit path for single-statement reads.
 */
export function pgTransactable(pool: Pool): TransactableExecutor {
  return {
    query: (text, params) => pool.query(text, params as Array<string | number | boolean | null | undefined>).then((r) => ({
      rows: r.rows as Array<Record<string, unknown>>,
      rowCount: r.rowCount,
    })),
    transaction: async <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: (text, params) => client.query(text, params as Array<string | number | boolean | null | undefined>).then((r) => ({
            rows: r.rows as Array<Record<string, unknown>>,
            rowCount: r.rowCount,
          })),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch { /* already failed; surface the original error */ }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function isExplicitCiTestDatabase(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    return process.env.CI === "true"
      && process.env.X402_TEST_PG === "1"
      && process.env.TEST_PG_URL === databaseUrl
      && (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:")
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
      && (parsed.port === "" || parsed.port === "5432");
  } catch {
    return false;
  }
}

export function createSettlementPool(databaseUrl: string, opts?: { poolMax?: number; statementTimeoutMs?: number }): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: opts?.poolMax ?? 3,
    connectionTimeoutMillis: 10_000,
    statement_timeout: opts?.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: 15_000,
    // x402 app storage is never allowed over plaintext. The only exception is
    // the explicitly opted-in disposable localhost CI service.
    ssl: isExplicitCiTestDatabase(databaseUrl) ? undefined : { rejectUnauthorized: true },
  });
}

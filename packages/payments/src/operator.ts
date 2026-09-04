import type { ReleaseEvidence, SettlementStore, StoredAttempt } from "./x402-settlement-store";

/**
 * Operator CLI core (pure, offline-testable). No request handler may import
 * this module: release lives only in the operator path, authenticated by
 * deployment IAM / operator database credentials — never a static token.
 */

export type ReleaseArgs = {
  operationId: string;
  operatorId: string;
  newApprovalEventId: string;
  /** Optional override; defaults to the row's staged blockhash (must match). */
  blockhash?: string;
  transferVerification: ReleaseEvidence["transferVerification"];
  note: string;
};

export function parseReleaseArgs(argv: string[]): { ok: boolean; args?: ReleaseArgs; error?: string } {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const operationId = get("--operation") ?? "";
  const operatorId = get("--operator") ?? "";
  const newApprovalEventId = get("--new-approval") ?? "";
  const blockhash = get("--blockhash");
  const transferVerification = get("--transfer") ?? "";
  const note = get("--note") ?? "";
  if (!operationId) return { ok: false, error: "--operation <operation-id> is required" };
  if (!operatorId) return { ok: false, error: "--operator <operator-id> is required" };
  if (!newApprovalEventId) return { ok: false, error: "--new-approval <appr_...> is required" };
  if (!transferVerification) return { ok: false, error: "--transfer <verification-state> is required" };
  if (transferVerification !== "mismatch" && transferVerification !== "unavailable") {
    return { ok: false, error: "--transfer must be mismatch or unavailable; verified transfers must be reconciled" };
  }
  if (!note) return { ok: false, error: "--note <text> is required" };
  return { ok: true, args: { operationId, operatorId, newApprovalEventId, blockhash, transferVerification, note } };
}

/**
 * Resolve which blockhash the release evidence must cite: an explicit flag
 * must equal the row's staged blockhash (operator typo guard); otherwise the
 * row's own bound blockhash is used. No row blockhash means expiry is
 * unprovable and release is refused downstream.
 */
export function resolveReleaseBlockhash(
  rowBlockhash: string | null,
  flagValue: string | undefined,
): { ok: boolean; blockhash?: string; error?: string } {
  if (flagValue !== undefined && flagValue.length > 0) {
    if (!rowBlockhash) {
      return { ok: false, error: "attempt has no staged blockhash; resolve via incident track, release is refused" };
    }
    if (flagValue !== rowBlockhash) {
      return { ok: false, error: "flagged blockhash does not match the attempt's staged blockhash" };
    }
    return { ok: true, blockhash: flagValue };
  }
  if (!rowBlockhash) {
    return { ok: false, error: "attempt has no staged blockhash; resolve via incident track, release is refused" };
  }
  return { ok: true, blockhash: rowBlockhash };
}

export type ReconcileSettledArgs = {
  operationId: string;
  operatorId: string;
  /** Finalized on-chain transaction signature to persist (read-only verified, never submitted here). */
  txHash: string;
  /** Chain slot of the read-only finality inspection (audit context). */
  checkedSlot: number;
  note: string;
};

export function parseReconcileSettledArgs(argv: string[]): { ok: boolean; args?: ReconcileSettledArgs; error?: string } {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const operationId = get("--operation") ?? "";
  const operatorId = get("--operator") ?? "";
  const txHash = get("--tx") ?? "";
  const slotRaw = get("--slot") ?? "";
  const note = get("--note") ?? "";
  if (!operationId) return { ok: false, error: "--operation <operation-id> is required" };
  if (!operatorId) return { ok: false, error: "--operator <operator-id> is required" };
  if (!txHash) return { ok: false, error: "--tx <finalized-transaction-signature> is required" };
  if (!slotRaw) return { ok: false, error: "--slot <checked-slot> is required" };
  const checkedSlot = Number(slotRaw);
  if (!Number.isInteger(checkedSlot) || checkedSlot < 0) {
    return { ok: false, error: "--slot must be the integer chain slot of the finality inspection" };
  }
  if (!note) return { ok: false, error: "--note <text> is required" };
  return { ok: true, args: { operationId, operatorId, txHash, checkedSlot, note } };
}

export type ReconcileSettledEvidence = {
  operatorId: string;
  txHash: string;
  checkedSlot: number;
  note: string;
};

/**
 * Gate for operator reconcile-settled (pure). Reconcile persists an
 * already-finalized signature — it never submits a payment. Only
 * `settling`/`awaiting_evidence` rows qualify; terminal rows are refused so
 * a settled attempt can never be rewritten.
 */
export function validateReconcileSettledEvidence(evidence: ReconcileSettledEvidence): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!evidence.operatorId || evidence.operatorId.length === 0) reasons.push("operator identity is required");
  if (!evidence.txHash || evidence.txHash.length < 32) reasons.push("a finalized transaction signature is required");
  if (!Number.isInteger(evidence.checkedSlot) || evidence.checkedSlot < 0) {
    reasons.push("checkedSlot must be the integer chain slot of the finality inspection");
  }
  if (!evidence.note || evidence.note.length === 0) reasons.push("operator note is required");
  return { ok: reasons.length === 0, reasons };
}

export type ReconcileSettledPersistenceInput = ReconcileSettledEvidence & {
  operationId: string;
  evidenceJson: Record<string, unknown>;
};

export type ReconcileSettledPersistenceResult =
  | { ok: true; row: StoredAttempt; alreadySettled: boolean }
  | { ok: false; reasons: string[] };

/**
 * Persist a read-only-verified finalized signature through the operator lease
 * and fenced transition. This function has no network or facilitator access;
 * the CLI must complete chain inspection before calling it.
 */
export async function persistReconciledSettlement(
  store: SettlementStore,
  input: ReconcileSettledPersistenceInput,
): Promise<ReconcileSettledPersistenceResult> {
  const gate = validateReconcileSettledEvidence(input);
  const reasons = [...gate.reasons];
  if (!input.operationId) reasons.push("operation identity is required");
  if (reasons.length > 0) return { ok: false, reasons };

  const row = await store.getByOperationId(input.operationId);
  if (!row) return { ok: false, reasons: ["unknown operation"] };
  if (row.status === "settled") {
    return row.txHash === input.txHash
      ? { ok: true, row, alreadySettled: true }
      : { ok: false, reasons: ["attempt is already settled with a different transaction signature"] };
  }
  if (row.status !== "settling" && row.status !== "awaiting_evidence") {
    return { ok: false, reasons: [`reconcile requires status settling/awaiting_evidence (current: ${row.status})`] };
  }
  if (row.txHash && row.txHash !== input.txHash) {
    return { ok: false, reasons: ["a different transaction signature is already bound to this attempt"] };
  }
  if (!row.payer) return { ok: false, reasons: ["attempt has no verified payer"] };

  const evidenceTransaction = input.evidenceJson.transactionHash;
  if (typeof evidenceTransaction === "string" && evidenceTransaction !== input.txHash) {
    return { ok: false, reasons: ["evidence transaction signature does not match the cited signature"] };
  }
  const evidenceDigest = input.evidenceJson.requestDigest;
  if (typeof evidenceDigest === "string" && evidenceDigest !== row.requestDigest) {
    return { ok: false, reasons: ["evidence request digest does not match the attempt"] };
  }
  const evidencePaymentId = input.evidenceJson.paymentIdentifier;
  if (typeof evidencePaymentId === "string" && evidencePaymentId !== row.callerPaymentId) {
    return { ok: false, reasons: ["evidence payment identifier does not match the attempt"] };
  }

  const owner = `operator-${input.operatorId}`;
  const leaseTtlMs = 60_000;
  const claimed = await store.claimRowForTakeover(row.operationId, owner, leaseTtlMs);
  if (!claimed) {
    return { ok: false, reasons: ["could not claim the attempt (lease still active or status changed)"] };
  }

  const settled = await store.transition(
    row.operationId,
    ["settling", "awaiting_evidence"],
    "settled",
    { txHash: input.txHash, evidenceJson: input.evidenceJson },
    claimed.leaseOwner,
    claimed.fenceToken,
    "operator-reconcile",
    `${input.operatorId}: ${input.note} (tx=${input.txHash.slice(0, 8)}..., slot=${input.checkedSlot})`,
  );
  if (settled) return { ok: true, row: settled, alreadySettled: false };

  const current = await store.getByOperationId(row.operationId);
  if (current?.status === "settled" && current.txHash === input.txHash) {
    return { ok: true, row: current, alreadySettled: true };
  }
  return { ok: false, reasons: ["reconcile transition refused (lease lost or status changed)"] };
}

export const OPERATOR_USAGE = [
  "x402 operator CLI — incident reconciliation ONLY. No settlement is submitted here.",
  "",
  "  node operator-cli.mjs reconcile-settled \\",
  "    --operation <operation-id> --operator <you> --tx <finalized-signature> \\",
  "    --slot <checked-slot> --note <incident finding> \\",
  "    [--rpc-url <solana rpc>] [--asset <mint>] [--amount <minor>] [--payee <pubkey>]",
  "",
  "  node operator-cli.mjs release \\",
  "    --operation <operation-id> --operator <you> --new-approval <appr_...> \\",
  "    --transfer <unavailable|mismatch> --note <fund-safety finding> \\",
  "    [--blockhash <override, must match staged>] [--rpc-url <solana rpc>]",
  "",
  "Preconditions (reconcile-settled, checked before writing): row is",
  "settling/awaiting_evidence; the cited transaction is finalized (meta.err",
  "null) with exactly the expected memo and one exact token transfer",
  "(mint, amount, payer, payee); lease is operator-claimed via takeover;",
  "transition settling/awaiting_evidence→settled persists the signature and",
  "evidence with a history row. Terminal rows are never rewritten.",
  "",
  "Preconditions (release): row is manual; the attempt's staged",
  "blockhash is provably expired via canonical RPC isBlockhashValid (false);",
  "no verified on-chain transfer for the attempt; new approval id cited.",
  "Connect as x402_operator (the database trigger rejects released writes",
  "from every other role, including superusers). Requires operator DB",
  "credentials via deployment IAM; DATABASE_URL and X402_STORE_ENC_KEY set.",
].join("\n");

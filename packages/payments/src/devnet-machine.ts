import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  x402ResourceServer,
  HTTPFacilitatorClient,
} from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractAndValidatePaymentIdentifier,
  paymentIdentifierResourceServerExtension,
} from "@x402/extensions/payment-identifier";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import {
  SOLANA_DEVNET_CAIP2,
  memoForEnvelope,
  type ToolSpendRequest,
  canonicalToolSpendRequestDigest,
  buildCanonicalRequirements,
  verifyCanonicalRequirements,
  adaptSettlement,
  type AdaptedSettlement,
  type CanonicalPaymentRequirements,
  type MemoVerificationState,
  memoVerificationLabel,
} from "./x402";
import type { X402DevnetConfig } from "./x402-config";
import {
  type SettlementStore,
  type StoredAttempt,
} from "./x402-settlement-store";
import { extractTransactionBlockhash } from "./x402";

function leaseTtlMsFromEnv(): number {
  const raw = Number(process.env.X402_LEASE_TTL_MS ?? 5 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
}

function facilitatorTimeoutMs(): number {
  const raw = Number(process.env.FACILITATOR_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function rpcTimeoutMs(): number {
  const raw = Number(process.env.RPC_TIMEOUT_MS ?? 15_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type DevnetFitScore = {
  productId: string;
  fitScore: number;
  note: string;
};

export type DevnetFitScoreResource = {
  resourceName: string;
  scoredAt: string;
  fit: string;
  scores: DevnetFitScore[];
};

export type DevnetSettlementEvidence = {
  paymentIdentifier: string;
  network: string;
  asset: string;
  amount: string;
  payer: string;
  payee: string;
  feePayer: string;
  transactionHash: string;
  facilitatorUrl: string;
  verificationResult: string;
  settlementResult: string;
  requestDigest: string;
  timestamp: string;
  explorerUrl: string;
  memoVerification: MemoVerificationState;
  transferVerification: TransferVerificationState;
  transfer?: DevnetTransferEvidence;
};

export type TransferVerificationState = "verified" | "mismatch" | "unavailable";

export type SettlementReconciliationState = "pending" | "manual_reconciliation_required";

export type DevnetTransferEvidence = {
  mint: string;
  amount: string;
  recipient: string;
  payer: string;
};

export type DevnetResourceResult = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

const RESOURCE_NAME = "RunVista Premium Fit-Scoring API";
const RESOURCE_URL = "/api/resources/premium-fit-score";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1sT3L4f5Y7W8X9Y",
]);

type TransactionInspection = {
  memoVerification: MemoVerificationState;
  transferVerification: TransferVerificationState;
  transfer?: DevnetTransferEvidence;
  reason?: string;
};

/**
 * Digest of the exact base64url header bytes that travel as PAYMENT-SIGNATURE.
 * The stored form IS the submittable form, so a stored attempt resubmits
 * byte-identically; anything else yields a different digest and conflicts.
 * Deterministic across processes: identical submissions, identical digest.
 */
function digestOfEncodedPayment(encodedPayment: string): string {
  return createHash("sha256").update(encodedPayment, "utf8").digest("hex");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function settlementAmount(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

function transactionHashFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return stringValue(record.transactionHash)
    ?? stringValue(record.transaction)
    ?? stringValue(record.signature);
}

export class DevnetMachineResource {
  readonly mock = false;
  private readonly facilitatorClient: HTTPFacilitatorClient;
  private readonly resourceServer: x402ResourceServer;
  private readonly config: X402DevnetConfig;
  private readonly store: SettlementStore;

  private initializationPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(config: X402DevnetConfig, store: SettlementStore) {
    this.config = config;
    this.store = store;
    this.facilitatorClient = new HTTPFacilitatorClient({
      url: config.facilitatorUrl,
    });

    const svmScheme = new ExactSvmScheme({
      rpcUrl: config.solanaRpcUrl,
    });

    this.resourceServer = new x402ResourceServer(this.facilitatorClient)
      .register(SOLANA_DEVNET_CAIP2, svmScheme)
      .registerExtension(paymentIdentifierResourceServerExtension);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = (async () => {
      try {
        await this.resourceServer.initialize();
        this.initialized = true;
      } catch (err) {
        this.initializationPromise = null;
        throw new Error(
          `x402 resource server initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    return this.initializationPromise;
  }

  async ensureInitialized(): Promise<void> {
    await this.initialize();
  }

  async hasProcessed(paymentIdentifier: string, requestDigest: string): Promise<boolean> {    const row = await this.store.findByDigestPayment(requestDigest, paymentIdentifier);
    return row?.status === "settled";
  }

  async lastSettlement(paymentIdentifier: string, requestDigest: string): Promise<AdaptedSettlement | undefined> {
    const row = await this.store.findByDigestPayment(requestDigest, paymentIdentifier);
    if (!row || row.status !== "settled") return undefined;
    const evidence = (row.evidenceJson ?? {}) as Record<string, unknown>;
    const str = (v: unknown, fallback: string) => (typeof v === "string" && v.length > 0 ? v : fallback);
    return {
      success: true,
      transactionHash: row.txHash ?? "",
      payer: str(evidence.payer, ""),
      payee: str(evidence.payee, this.config.payeePublicKey),
      network: str(evidence.network, SOLANA_DEVNET_CAIP2),
      asset: str(evidence.asset, this.config.devnetUsdcMint),
      amount: str(evidence.amount, ""),
      facilitatorUrl: str(evidence.facilitatorUrl, this.config.facilitatorUrl),
      paymentIdentifier: row.callerPaymentId ?? "",
    };
  }

  async reset(): Promise<void> {
    await this.store.clearForTests();
  }

  payerPublicKey(): string {
    return this.config.payerPublicKey;
  }

  buildRequestDigest(spendingRequest: ToolSpendRequest): string {
    return canonicalToolSpendRequestDigest(spendingRequest);
  }

  getCanonicalRequirements(requestDigest: string): CanonicalPaymentRequirements {
    return buildCanonicalRequirements(this.config, requestDigest);
  }

  /** Read-only lookup for app-layer policy gates (never mutates). */
  async findActiveAttempt(logicalOrderId: string, intentVersion: number): Promise<StoredAttempt | null> {
    return this.store.findActiveAttempt(logicalOrderId, intentVersion);
  }

  /** Read-only payment-ID lookup for conflict checks (never mutates). */
  async findAttemptsByPaymentId(paymentIdentifier: string): Promise<StoredAttempt[]> {
    return this.store.findByPaymentId(paymentIdentifier);
  }

  /** Decrypt a stored signed attempt (operator/forensic and cache-hydration use only). */
  async decryptStoredPayload(ciphertext: string): Promise<string> {
    return this.store.decryptSignedPayload(ciphertext);
  }

  /**
   * Persist a client-signed attempt BEFORE any external submission, so a
   * crash between signing and POST cannot lose it. Idempotent: same
   * (digest, paymentId) returns the stored row without duplicating.
   */
  async stagePreparedAttempt(input: {
    spendingRequest: ToolSpendRequest;
    paymentIdentifier: string;
    encodedPayment: string;
    approvalEventId?: string;
  }): Promise<{ operationId: string; requestDigest: string }> {
    const digest = this.buildRequestDigest(input.spendingRequest);
    const payloadDigest = digestOfEncodedPayment(input.encodedPayment);
    const resolution = await this.store.resolveOrCreate({
      logicalOrderId: input.spendingRequest.orderId,
      intentVersion: input.spendingRequest.intentVersion,
      requestDigest: digest,
      resource: RESOURCE_URL,
      approvalEventId: input.approvalEventId,
      callerPaymentId: input.paymentIdentifier,
    });
    if (resolution.kind === "release_required") {
      throw new Error(`Release required: ${resolution.detail}`);
    }
    if (resolution.kind === "approval_mismatch") {
      throw new Error(`Approval mismatch: ${resolution.detail}`);
    }
    const stagedRow = resolution.row;
    if (stagedRow.requestDigest !== digest) {
      throw new Error("Payment identifier is already reserved for a different spending request.");
    }
    const row = stagedRow;
    if (row.payloadDigest && row.payloadDigest !== payloadDigest) {
      throw new Error("Payment identifier is already bound to a different signed payment payload.");
    }
    if (!row.payloadDigest) {
      await this.store.transition(
        row.operationId, ["pending"], "pending",
        { signedPayloadEnc: this.store.sealSignedPayload(input.encodedPayment), payloadDigest, callerPaymentId: input.paymentIdentifier },
        null, null, "prepare-stage", `pid=${input.paymentIdentifier}`,
      );
    }
    return { operationId: row.operationId, requestDigest: digest };
  }

  private async completeSettlement(
    operationId: string,
    owner: string | null,
    fenceToken: string | null,
    adapted: AdaptedSettlement,
    settlementResult: "settled" | "reconciled",
    expected: { asset: string; amount: string; payee: string; payer: string },
    requestDigest: string,
    paymentIdentifier: string,
    feePayer: string,
    initialInspection?: TransactionInspection,
  ): Promise<DevnetResourceResult> {
    const failClosed = async (
      to: "awaiting_evidence" | "manual",
      error: string,
      detail: string,
      retryable: boolean,
    ): Promise<DevnetResourceResult> => {
      // Persistence itself may be down (the settled-but-unpersisted
      // incident): never let a history-write failure lose the signature.
      // The body always carries the transaction hash when one exists, so an
      // operator can reconcile without resubmission.
      try {
        await this.store.transition(operationId, ["settling", "awaiting_evidence"], to, { txHash: adapted.transactionHash }, owner, fenceToken, "complete-settlement", detail);
      } catch {
        /* persistence unavailable; the signature below is the recovery path */
      }
      return {
        status: to === "awaiting_evidence" ? 202 : 502,
        body: {
          error,
          detail,
          paymentIdentifier,
          requestDigest,
          reconciliationState: to === "awaiting_evidence" ? "pending" : "manual_reconciliation_required",
          retryable,
          ...(to === "awaiting_evidence" ? { transactionHash: adapted.transactionHash } : {}),
        },
        headers: {},
      };
    };

    const inspection = initialInspection ?? await this.inspectTransaction(
      adapted.transactionHash,
      memoForEnvelope(requestDigest),
      expected,
    );

    if (inspection.memoVerification === "unavailable" || inspection.transferVerification === "unavailable") {
      return failClosed(
        "awaiting_evidence",
        "settlement_ambiguous",
        "Settlement returned a transaction signature, but on-chain payment evidence is not yet available. Retry to reconcile the original attempt; no replacement payment will be submitted.",
        true,
      );
    }

    if (inspection.memoVerification === "missing" || inspection.transferVerification === "mismatch") {
      return failClosed(
        "manual",
        "settlement_transaction_mismatch",
        inspection.reason ?? "The confirmed transaction does not match the expected payment.",
        false,
      );
    }

    const resource = this.score(adapted.payer, adapted.transactionHash);
    const settlementEvidence: DevnetSettlementEvidence = {
      paymentIdentifier,
      network: adapted.network,
      asset: adapted.asset,
      amount: adapted.amount,
      payer: adapted.payer,
      payee: adapted.payee,
      feePayer,
      transactionHash: adapted.transactionHash,
      facilitatorUrl: adapted.facilitatorUrl,
      verificationResult: "verified",
      settlementResult,
      requestDigest,
      timestamp: new Date().toISOString(),
      explorerUrl: `https://explorer.solana.com/tx/${adapted.transactionHash}?cluster=devnet`,
      memoVerification: inspection.memoVerification,
      transferVerification: inspection.transferVerification,
      transfer: inspection.transfer,
    };

    let settled = null;
    try {
      settled = await this.store.transition(
        operationId, ["settling", "awaiting_evidence"], "settled",
        { txHash: adapted.transactionHash, evidenceJson: settlementEvidence as unknown as Record<string, unknown> },
        owner, fenceToken, "complete-settlement", `settlementResult=${settlementResult}`,
      );
    } catch {
      // Chain finalized but the settled write failed (persistence outage):
      // surface the signature for operator reconciliation instead of a 500
      // that loses it. No resubmission — retry reconciles the original.
      return {
        status: 202,
        body: {
          error: "settlement_ambiguous",
          detail: "Settlement completed on-chain but confirmation persistence failed; retry to reconcile the original attempt without submitting another payment.",
          paymentIdentifier,
          requestDigest,
          reconciliationState: "pending",
          retryable: true,
          transactionHash: adapted.transactionHash,
        },
        headers: {},
      };
    }
    if (!settled) {
      // Lost a race (lease stolen or already terminal): converge on the winner.
      const current = await this.store.getByOperationId(operationId);
      if (current?.status === "settled") {
        const evidence = (current.evidenceJson ?? {}) as Record<string, unknown>;
        const rescored = this.score(String(evidence.payer ?? ""), current.txHash ?? "");
        return {
          status: 200,
          body: { ...rescored, settlementEvidence: current.evidenceJson, note: "replay: cached result returned, no second charge" },
          headers: {},
        };
      }
      return failClosed("awaiting_evidence", "settlement_ambiguous", "Settlement raced another worker; retry to reconcile the original attempt.", true);
    }

    return {
      status: 200,
      body: { ...resource, settlementEvidence },
      headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(adapted)).toString("base64url") },
    };
  }

  async quote(requestDigest: string): Promise<string> {
    await this.ensureInitialized();
    const canonical = this.getCanonicalRequirements(requestDigest);

    const extra: Record<string, unknown> = { memo: canonical.extra.memo };

    const requirements = await this.resourceServer.buildPaymentRequirements({
      scheme: "exact",
      payTo: canonical.payTo,
      price: {
        asset: canonical.asset,
        amount: canonical.amount,
      },
      network: SOLANA_DEVNET_CAIP2,
      maxTimeoutSeconds: canonical.maxTimeoutSeconds,
      extra,
    });

    const paymentRequired = await this.resourceServer.createPaymentRequiredResponse(
      requirements,
      {
        url: RESOURCE_URL,
        description: RESOURCE_NAME,
        mimeType: "application/json",
      },
      undefined,
      { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
    );

    return Buffer.from(JSON.stringify(paymentRequired)).toString("base64url");
  }

  async accept(
    paymentSignatureHeader: string,
    requestDigest: string,
    spendingRequest: ToolSpendRequest,
    opts?: { approvalEventId?: string },
  ): Promise<DevnetResourceResult> {
    await this.ensureInitialized();

    // Kill-switch first: when disabled, refuse everything before any
    // validation, persistence, or external call.
    if (process.env.X402_SETTLEMENT_ENABLED === "false") {
      return {
        status: 503,
        body: { error: "settlement_unavailable", detail: "x402 settlement is disabled by operator kill-switch." },
        headers: {},
      };
    }

    if (!paymentSignatureHeader) {
      const requiredHeader = await this.quote(requestDigest);
      return {
        status: 402,
        body: { error: "payment_required", detail: "This resource requires payment. Retry with PAYMENT-SIGNATURE." },
        headers: { "PAYMENT-REQUIRED": requiredHeader },
      };
    }

    let signedPayload: PaymentPayload;
    try {
      signedPayload = JSON.parse(
        Buffer.from(paymentSignatureHeader, "base64url").toString("utf8"),
      ) as PaymentPayload;
    } catch {
      return { status: 400, body: { error: "malformed_payment_signature" }, headers: {} };
    }

    if (!signedPayload.accepted) {
      return { status: 400, body: { error: "missing_accepted_requirements" }, headers: {} };
    }

    const expectedRequestDigest = this.buildRequestDigest(spendingRequest);
    if (requestDigest !== expectedRequestDigest) {
      return {
        status: 400,
        body: { error: "request_digest_mismatch", detail: "The supplied requestDigest does not match spendingRequest." },
        headers: {},
      };
    }

    const canonical = this.getCanonicalRequirements(requestDigest);
    const supplied: PaymentRequirements = signedPayload.accepted;
    const suppliedMemo = typeof supplied.extra?.memo === "string" ? supplied.extra.memo : undefined;
    const feePayer = typeof supplied.extra?.feePayer === "string" ? supplied.extra.feePayer : "";
    const errors = verifyCanonicalRequirements({
      scheme: supplied.scheme,
      network: supplied.network,
      asset: supplied.asset,
      amount: supplied.amount,
      payTo: supplied.payTo,
      memo: suppliedMemo,
    }, canonical);

    const resourceServerWithSupport = this.resourceServer as unknown as {
      getSupportedKind?: (x402Version: number, network: string, scheme: string) => {
        extra?: Record<string, unknown>;
      } | undefined;
    };
    if (typeof resourceServerWithSupport.getSupportedKind === "function") {
      const supportedKind = resourceServerWithSupport.getSupportedKind(2, SOLANA_DEVNET_CAIP2, "exact");
      const expectedFeePayer = supportedKind?.extra?.feePayer;
      if (typeof expectedFeePayer !== "string" || supplied.extra?.feePayer !== expectedFeePayer) {
        errors.push("feePayer does not match facilitator-supported requirements");
      }
    }

    if (errors.length > 0) {
      return { status: 402, body: { error: "payment_rejected", detail: errors.join("; ") }, headers: {} };
    }

    const paymentIdentifier = extractAndValidatePaymentIdentifier(signedPayload).id;
    if (!paymentIdentifier) {
      return {
        status: 400,
        body: { error: "payment_identifier_required", detail: "A valid payment-identifier extension is required." },
        headers: {},
      };
    }
    const paymentId = paymentIdentifier;
    const payloadDigest = digestOfEncodedPayment(paymentSignatureHeader);

    const workerId = `worker-${randomUUID()}`;
    const leaseTtlMs = leaseTtlMsFromEnv();

    // Same payment ID bound to a different request is always a conflict,
    // regardless of that attempt's status (payment IDs are single-use).
    const samePidRows = await this.store.findByPaymentId(paymentId);
    if (samePidRows.some((r) => r.requestDigest !== requestDigest)) {
      return {
        status: 409,
        body: { error: "idempotency_conflict", detail: "Same payment identifier used with a different request digest." },
        headers: {},
      };
    }

    // Persist-first intake: stable identity binds (order, intent, digest,
    // resource, server authorization revision). Concurrent creators converge
    // on the winner via PK + active-slot constraints.
    const resolution = await this.store.resolveOrCreate({
      logicalOrderId: spendingRequest.orderId,
      intentVersion: spendingRequest.intentVersion,
      requestDigest,
      resource: RESOURCE_URL,
      approvalEventId: opts?.approvalEventId,
      callerPaymentId: paymentId,
    });
    if (resolution.kind === "release_required") {
      return { status: 409, body: { error: "release_required", detail: resolution.detail }, headers: {} };
    }
    if (resolution.kind === "approval_mismatch") {
      return { status: 409, body: { error: "approval_mismatch", detail: resolution.detail }, headers: {} };
    }
    let row = resolution.row;
    if (row.requestDigest !== requestDigest) {
      return {
        status: 409,
        body: { error: "idempotency_conflict", detail: "Same payment identifier used with a different request digest." },
        headers: {},
      };
    }
    if (row.payloadDigest && row.payloadDigest !== payloadDigest) {
      return {
        status: 409,
        body: { error: "payment_ownership_conflict", detail: "Payment identifier is already bound to a different signed payment payload." },
        headers: {},
      };
    }

    const joined = await this.joinStoredRow(row);
    if (joined) return joined;

    // Fresh pending row: single-winner claim that atomically stamps this
    // call's signed payload. The settled bytes always belong to the winner —
    // concurrent creators cannot interleave payload writes. Losers re-read
    // and join (ownership is rechecked against the stamped digest).
    const sealed = this.store.sealSignedPayload(paymentSignatureHeader);
    const claimed = await this.store.claimForSettle(row.operationId, workerId, leaseTtlMs, sealed, payloadDigest);
    if (!claimed) {
      const reread = await this.store.getByOperationId(row.operationId);
      if (!reread) {
        return { status: 500, body: { error: "internal_error", detail: "Settlement record vanished mid-accept." }, headers: {} };
      }
      const retryJoin = await this.joinStoredRow(reread);
      if (retryJoin) return retryJoin;
      return {
        status: 202,
        body: { error: "settlement_in_progress", detail: "Another worker claimed this attempt; retry to reconcile the original.", paymentIdentifier: paymentId, requestDigest, reconciliationState: "pending", retryable: true },
        headers: {},
      };
    }
    if (claimed.payloadDigest && claimed.payloadDigest !== payloadDigest) {
      // Lost a payload race that claim-stamping could not prevent (a prepared
      // payload was staged first): relinquish the lease and conflict out.
      // No external call has been made yet, so nothing was submitted.
      await this.store.transition(row.operationId, ["settling"], "pending", {}, workerId, claimed.fenceToken ?? "", "claim-digest-abandon", "Staged payload differs from presented payload.");
      return {
        status: 409,
        body: { error: "payment_ownership_conflict", detail: "Payment identifier is already bound to a different signed payment payload." },
        headers: {},
      };
    }
    // Record the signed transaction's blockhash while holding the lease, so a
    // later operator release can prove expiry canonically via isBlockhashValid.
    if (!claimed.blockhash) {
      const staged = await extractTransactionBlockhash(paymentSignatureHeader);
      if (staged) {
        await this.store.transition(row.operationId, ["settling"], "settling", { blockhash: staged },
          workerId, claimed.fenceToken ?? "", "claim-blockhash", `bh=${staged.slice(0, 8)}`);
      }
    }
    // Stale-worker guard: revalidate ownership immediately before settlement.
    // A paused worker that lost its lease aborts here instead of submitting.
    // Residual window (stated honestly): a worker paused after a successful
    // revalidation but mid-HTTP-call still has one unknown-odds submission in
    // flight. Fencing reduces duplicate-submission risk; it cannot fence the
    // external facilitator.
    const valid = await this.store.revalidateForSettle(row.operationId, workerId, claimed.fenceToken ?? "", leaseTtlMs);
    if (!valid) {
      const reread = await this.store.getByOperationId(row.operationId);
      if (reread) {
        const retryJoin = await this.joinStoredRow(reread);
        if (retryJoin) return retryJoin;
      }
      return {
        status: 202,
        body: { error: "settlement_in_progress", detail: "Lease lost before settlement; another worker owns this attempt.", paymentIdentifier: paymentId, requestDigest, reconciliationState: "pending", retryable: true },
        headers: {},
      };
    }

    const verifyResult: VerifyResponse = await withTimeout(
      this.resourceServer.verifyPayment(signedPayload, supplied),
      facilitatorTimeoutMs(),
      "facilitator verify",
    ).catch((err) => ({ isValid: false as const, invalidReason: err instanceof Error ? err.message : String(err) }));

    if (!verifyResult.isValid) {
      await this.store.transition(
        row.operationId, ["settling"], "rejected", {}, workerId, claimed.fenceToken ?? "",
        "verify-failed", verifyResult.invalidReason || verifyResult.invalidMessage || "unknown",
      );
      return {
        status: 402,
        body: { error: "payment_verification_failed", detail: verifyResult.invalidReason || verifyResult.invalidMessage || "unknown" },
        headers: {},
      };
    }

    const payerFromVerify = verifyResult.payer;
    // Persist the verified payer immediately: later join-reconcile inspection
    // matches the on-chain transfer against it, even if this worker dies.
    // The result is checked — a null means we lost the lease mid-verify and
    // must rejoin instead of settling.
    if (typeof payerFromVerify === "string" && payerFromVerify.length > 0) {
      const persisted = await this.store.transition(row.operationId, ["settling"], "settling", { payer: payerFromVerify },
        workerId, claimed.fenceToken ?? "", "verify-passed", `payer=${payerFromVerify.slice(0, 8)}`);
      if (!persisted) {
        const reread = await this.store.getByOperationId(row.operationId);
        if (reread) {
          const retryJoin = await this.joinStoredRow(reread);
          if (retryJoin) return retryJoin;
        }
        return {
          status: 202,
          body: { error: "settlement_in_progress", detail: "Lease lost during verification; another worker owns this attempt.", paymentIdentifier: paymentId, requestDigest, reconciliationState: "pending", retryable: true },
          headers: {},
        };
      }
    }
    // Second ownership revalidation immediately before the settle call: verify
    // itself is a network round trip during which the lease may have lapsed.
    const stillValid = await this.store.revalidateForSettle(row.operationId, workerId, claimed.fenceToken ?? "", leaseTtlMs);
    if (!stillValid) {
      const reread = await this.store.getByOperationId(row.operationId);
      if (reread) {
        const retryJoin = await this.joinStoredRow(reread);
        if (retryJoin) return retryJoin;
      }
      return {
        status: 202,
        body: { error: "settlement_in_progress", detail: "Lease lost before settlement; another worker owns this attempt.", paymentIdentifier: paymentId, requestDigest, reconciliationState: "pending", retryable: true },
        headers: {},
      };
    }
    let settleResult: SettleResponse;
    try {
      settleResult = await withTimeout(
        this.resourceServer.settlePayment(signedPayload, supplied),
        facilitatorTimeoutMs(),
        "facilitator settle",
      );
    } catch (err) {
      const knownTransactionHash = transactionHashFromUnknown(err);
      await this.store.transition(
        row.operationId, ["settling"], knownTransactionHash ? "awaiting_evidence" : "manual",
        knownTransactionHash ? { txHash: knownTransactionHash, payer: payerFromVerify } : { payer: payerFromVerify },
        workerId, claimed.fenceToken ?? "", "settle-transport-failed",
        knownTransactionHash
          ? `Transport failed after submission: ${err instanceof Error ? err.message : String(err)}`
          : `Transport failed without signature or discovery path: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        status: 202,
        body: {
          error: "settlement_ambiguous",
          detail: knownTransactionHash
            ? `Settlement transport failed after the payment attempt was submitted. Retry to reconcile the original attempt: ${err instanceof Error ? err.message : String(err)}`
            : `Settlement transport failed without a transaction signature or discovery path. Manual reconciliation is required; no replacement payment will be submitted. ${err instanceof Error ? err.message : String(err)}`,
          paymentIdentifier: paymentId,
          requestDigest,
          reconciliationState: knownTransactionHash ? "pending" : "manual_reconciliation_required",
          retryable: Boolean(knownTransactionHash),
          transactionHash: knownTransactionHash ?? undefined,
        },
        headers: {},
      };
    }

    if (!settleResult || typeof settleResult !== "object") {
      await this.store.transition(row.operationId, ["settling"], "manual", {}, workerId, claimed.fenceToken ?? "",
        "settle-malformed", "Facilitator returned no usable settlement response or transaction signature.");
      return {
        status: 202,
        body: {
          error: "settlement_ambiguous",
          detail: "The facilitator returned no usable settlement response or transaction signature. Manual reconciliation is required; no replacement payment will be submitted.",
          paymentIdentifier: paymentId,
          requestDigest,
          reconciliationState: "manual_reconciliation_required",
          retryable: false,
        },
        headers: {},
      };
    }

    const payerFromSettle = settleResult.payer;
    const verifiedPayer = typeof payerFromVerify === "string" ? payerFromVerify : "";
    const settledPayer = typeof payerFromSettle === "string" ? payerFromSettle : "";
    const payer = verifiedPayer || settledPayer;

    const responseAmount = settlementAmount(settleResult.amount, canonical.amount);
    const responseTransaction = stringValue(settleResult.transaction);
    const responseNetwork = stringValue(settleResult.network) ?? canonical.network;
    if (verifiedPayer && settledPayer && verifiedPayer !== settledPayer) {
      await this.store.transition(row.operationId, ["settling"], "manual",
        { txHash: responseTransaction ?? "", payer },
        workerId, claimed.fenceToken ?? "", "settle-payer-mismatch", "Facilitator settlement payer did not match the verified payment payer.");
      return {
        status: 502,
        body: {
          error: "settlement_transaction_mismatch",
          detail: "Facilitator settlement payer did not match the verified payment payer.",
          paymentIdentifier: paymentId,
          requestDigest,
          reconciliationState: "manual_reconciliation_required",
          retryable: false,
        },
        headers: {},
      };
    }

    let adapted: AdaptedSettlement;
    try {
      adapted = adaptSettlement(
        {
          success: settleResult.success,
          transaction: responseTransaction,
          network: responseNetwork,
          payer,
          amount: responseAmount,
          errorReason: settleResult.errorReason,
          errorMessage: settleResult.errorMessage,
        },
        {
          payee: this.config.payeePublicKey,
          asset: this.config.devnetUsdcMint,
          facilitatorUrl: this.config.facilitatorUrl,
          paymentIdentifier: paymentId,
          amount: canonical.amount,
        },
      );
    } catch (err) {
      await this.store.transition(row.operationId, ["settling"], responseTransaction ? "awaiting_evidence" : "manual",
        { txHash: responseTransaction ?? "", payer },
        workerId, claimed.fenceToken ?? "", "settle-adapt-failed",
        responseTransaction
          ? `Settlement response was incomplete; retry to reconcile the original attempt: ${err instanceof Error ? err.message : String(err)}`
          : `Settlement response was incomplete and did not provide a transaction signature: ${err instanceof Error ? err.message : String(err)}`);
      return {
        status: 202,
        body: {
          error: "settlement_ambiguous",
          detail: responseTransaction
            ? `Settlement response was incomplete; retry to reconcile the original attempt: ${err instanceof Error ? err.message : String(err)}`
            : `Settlement response was incomplete and did not provide a transaction signature; no discovery path is available. Manual reconciliation is required; no replacement payment will be submitted. ${err instanceof Error ? err.message : String(err)}`,
          paymentIdentifier: paymentId,
          requestDigest,
          reconciliationState: responseTransaction ? "pending" : "manual_reconciliation_required",
          retryable: Boolean(responseTransaction),
          transactionHash: responseTransaction ?? undefined,
        },
        headers: {},
      };
    }

    if (!adapted.success) {
      await this.store.transition(row.operationId, ["settling"], adapted.transactionHash ? "awaiting_evidence" : "manual",
        { txHash: adapted.transactionHash, payer },
        workerId, claimed.fenceToken ?? "", "settle-unsuccessful",
        adapted.transactionHash
          ? "Settlement broadcast may have succeeded but confirmation timed out. Retry to reconcile the original transaction without submitting another payment."
          : "Settlement did not provide a transaction signature or discovery path.");
      return {
        status: 202,
        body: {
          error: "settlement_ambiguous",
          detail: adapted.transactionHash
            ? "Settlement broadcast may have succeeded but confirmation timed out. Retry to reconcile the original transaction without submitting another payment."
            : "Settlement did not provide a transaction signature or discovery path. Manual reconciliation is required; no replacement payment will be submitted.",
          paymentIdentifier: paymentId,
          requestDigest,
          reconciliationState: adapted.transactionHash ? "pending" : "manual_reconciliation_required",
          retryable: Boolean(adapted.transactionHash),
        },
        headers: {},
      };
    }

    return await this.completeSettlement(
      row.operationId, workerId, claimed.fenceToken ?? "", adapted, "settled",
      { asset: adapted.asset, amount: adapted.amount, payee: adapted.payee, payer: adapted.payer },
      requestDigest, paymentIdentifier, feePayer,
    );
  }

  /**
   * Read-only join for stored rows. Returns a response, or null when the row
   * is a fresh pending attempt eligible for a first claim. Never submits.
   */
  private async joinStoredRow(row: StoredAttempt): Promise<DevnetResourceResult | null> {
    const paymentIdentifier = row.callerPaymentId ?? "";
    const requestDigest = row.requestDigest;
    const evidence = (row.evidenceJson ?? {}) as Record<string, unknown>;
    const knownPayer = row.payer || String(evidence.payer ?? "");
    switch (row.status) {
      case "settled": {
        const evidence = (row.evidenceJson ?? {}) as Record<string, unknown>;
        const resource = this.score(knownPayer, row.txHash ?? "");
        return {
          status: 200,
          body: { ...resource, settlementEvidence: row.evidenceJson, note: "replay: cached result returned, no second charge" },
          headers: {},
        };
      }
      case "rejected":
        return { status: 402, body: { error: "payment_verification_failed", detail: "This attempt failed facilitator verification." }, headers: {} };
      case "manual":
        return {
          status: 202,
          body: { error: "settlement_ambiguous", detail: "Manual reconciliation is required; no replacement payment will be submitted.", paymentIdentifier, requestDigest, reconciliationState: "manual_reconciliation_required", retryable: false },
          headers: {},
        };
      case "mismatch":
        return {
          status: 502,
          body: { error: "settlement_transaction_mismatch", detail: "The confirmed transaction does not match the expected payment.", paymentIdentifier, requestDigest, reconciliationState: "manual_reconciliation_required", retryable: false },
          headers: {},
        };
      case "released":
        return {
          status: 409,
          body: { error: "release_consumed", detail: "This payment identifier was consumed by an operator-released attempt and cannot be reused." },
          headers: {},
        };
      case "awaiting_evidence": {
        if (!row.txHash) {
          return {
            status: 202,
            body: { error: "settlement_ambiguous", detail: "Retry to reconcile the original attempt; no replacement payment will be submitted.", paymentIdentifier, requestDigest, reconciliationState: "pending", retryable: true },
            headers: {},
          };
        }
        const inspection = await this.inspectTransaction(row.txHash, this.expectedMemoFor(row), {
          asset: this.config.devnetUsdcMint,
          amount: this.getCanonicalRequirements(requestDigest).amount,
          payee: this.config.payeePublicKey,
          payer: knownPayer,
        });
        if (inspection.memoVerification === "verified" && inspection.transferVerification === "verified") {
          const canonicalAmount = this.getCanonicalRequirements(requestDigest).amount;
          const evidencePayer = knownPayer;
          return await this.completeSettlement(row.operationId, null, null, {
            success: true,
            transactionHash: row.txHash,
            payer: evidencePayer,
            payee: this.config.payeePublicKey,
            network: SOLANA_DEVNET_CAIP2,
            asset: this.config.devnetUsdcMint,
            amount: canonicalAmount,
            facilitatorUrl: this.config.facilitatorUrl,
            paymentIdentifier,
          }, "reconciled",
          { asset: this.config.devnetUsdcMint, amount: canonicalAmount, payee: this.config.payeePublicKey, payer: evidencePayer },
          requestDigest, paymentIdentifier, String(evidence.feePayer ?? ""),
          inspection);
        }
        if (inspection.memoVerification === "missing" || inspection.transferVerification === "mismatch") {
          await this.store.transition(row.operationId, ["awaiting_evidence"], "mismatch", {}, null, null, "join-inspect-mismatch", inspection.reason ?? "Confirmed transaction does not match.");
          return {
            status: 502,
            body: { error: "settlement_transaction_mismatch", detail: inspection.reason ?? "The confirmed transaction does not match the expected payment.", paymentIdentifier, requestDigest, reconciliationState: "manual_reconciliation_required", retryable: false },
            headers: {},
          };
        }
        return {
          status: 202,
          body: { error: "settlement_ambiguous", detail: "The original transaction is not yet confirmed with the expected payment evidence. Retry to reconcile without creating another payment.", paymentIdentifier, requestDigest, reconciliationState: "pending", retryable: true },
          headers: {},
        };
      }
      case "settling": {
        const leased = row.leaseExpiresAt ? Date.parse(row.leaseExpiresAt) > Date.now() : false;
        if (leased) {
          return {
            status: 202,
            body: { error: "settlement_in_progress", detail: "Another worker holds this attempt; retry to reconcile the original.", paymentIdentifier, requestDigest, reconciliationState: "pending", retryable: true },
            headers: {},
          };
        }
        // Lease lapsed with no transaction: take over THROUGH the lease
        // mechanism (single-row atomic claim re-checking expiry + status),
        // never by blind check-then-act. The take-over claim carries a fresh
        // fence, so a stale worker's pre-settle revalidation fails if it
        // ever resumes.
        const taken = await this.store.claimRowForTakeover(row.operationId, `takeover-${randomUUID()}`, leaseTtlMsFromEnv());
        if (!taken) {
          return await this.joinStoredRow((await this.store.getByOperationId(row.operationId)) ?? row);
        }
        await this.store.transition(taken.operationId, ["settling"], "pending", {}, taken.leaseOwner, taken.fenceToken, "join-takeover", "Prior lease lapsed with no transaction; slot reopened under fresh fence.");
        return null;
      }
      case "pending":
      default:
        return null;
    }
  }

  private expectedMemoFor(row: StoredAttempt): string {
    return memoForEnvelope(row.requestDigest);
  }



  private async verifyMemo(transactionHash: string, expectedMemo: string): Promise<MemoVerificationState> {
    const inspection = await this.inspectTransaction(transactionHash, expectedMemo);
    return inspection.memoVerification;
  }

  private async inspectTransaction(
    transactionHash: string,
    expectedMemo: string,
    expectedTransfer?: { asset: string; amount: string; payee: string; payer: string },
  ): Promise<TransactionInspection> {
    if (!this.config.solanaRpcUrl) {
      return { memoVerification: "unavailable", transferVerification: "unavailable" };
    }

    try {
      const response = await fetch(this.config.solanaRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [
            transactionHash,
            { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
          ],
        }),
        signal: AbortSignal.timeout(rpcTimeoutMs()),
      });
      if (typeof response.ok === "boolean" && !response.ok) {
        return { memoVerification: "unavailable", transferVerification: "unavailable" };
      }

      const data = (await response.json()) as Record<string, unknown>;
      const result = data.result as Record<string, unknown> | undefined;
      if (!result) {
        return { memoVerification: "unavailable", transferVerification: "unavailable" };
      }

      const meta = result.meta as Record<string, unknown> | undefined;
      const transaction = result.transaction as Record<string, unknown> | undefined;
      const message = transaction?.message as Record<string, unknown> | undefined;
      const topInstructions = Array.isArray(message?.instructions) ? message.instructions : [];
      const innerInstructions = Array.isArray(meta?.innerInstructions)
        ? meta.innerInstructions.flatMap((group) => {
            const instructions = (group as Record<string, unknown>)?.instructions;
            return Array.isArray(instructions) ? instructions : [];
          })
        : [];
      const allInstructions = [...topInstructions, ...innerInstructions] as Array<Record<string, unknown>>;
      const memoVerification = allInstructions.some((ix) =>
        ix.program === "spl-memo" && ix.programId === MEMO_PROGRAM_ID && ix.parsed === expectedMemo,
      ) ? "verified" : "missing";

      if (!expectedTransfer) {
        return { memoVerification, transferVerification: "unavailable" };
      }

      if (!meta || !Object.prototype.hasOwnProperty.call(meta, "err") || meta.err !== null) {
        return {
          memoVerification,
          transferVerification: "mismatch",
          reason: "The original transaction did not complete successfully (meta.err was not null).",
        };
      }

      const messageAccountKeys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
      const accountKeys = messageAccountKeys.map((key) => {
        if (typeof key === "string") return key;
        if (key && typeof key === "object") {
          return stringValue((key as Record<string, unknown>).pubkey) ?? "";
        }
        return "";
      });
      const postTokenBalances = Array.isArray(meta.postTokenBalances)
        ? meta.postTokenBalances as Array<Record<string, unknown>>
        : [];
      const preTokenBalances = Array.isArray(meta.preTokenBalances)
        ? meta.preTokenBalances as Array<Record<string, unknown>>
        : [];

      const parsedTransfers = allInstructions.flatMap((ix) => {
        const programId = stringValue(ix.programId);
        const program = stringValue(ix.program);
        if ((programId && !TOKEN_PROGRAM_IDS.has(programId)) || (!programId && program !== "spl-token")) {
          return [];
        }
        const parsed = ix.parsed as Record<string, unknown> | undefined;
        const info = parsed?.info as Record<string, unknown> | undefined;
        const type = stringValue(parsed?.type);
        if (!info || (type !== "transfer" && type !== "transferChecked")) return [];

        const tokenAmount = info.tokenAmount as Record<string, unknown> | undefined;
        const destination = stringValue(info.destination);
        const source = stringValue(info.source);
        if (!destination) return [];

        const destinationIndex = accountKeys.indexOf(destination);
        const sourceIndex = accountKeys.indexOf(source ?? "");
        const destinationBalance = postTokenBalances.find((balance) => balance.accountIndex === destinationIndex);
        const sourceBalance = preTokenBalances.find((balance) => balance.accountIndex === sourceIndex);
        const mint = stringValue(info.mint) ?? stringValue(destinationBalance?.mint);
        const amount = stringValue(tokenAmount?.amount) ?? stringValue(info.amount);
        const payer = stringValue(info.authority) ?? stringValue(info.owner) ?? stringValue(sourceBalance?.owner);
        if (!mint || !amount || !payer) return [];

        const recipient = stringValue(destinationBalance?.owner)
          ?? (destinationIndex >= 0 ? accountKeys[destinationIndex] : undefined)
          ?? destination;
        return [{ mint, amount, recipient, payer } satisfies DevnetTransferEvidence];
      });

      const matchingTransfers = parsedTransfers.filter((transfer) =>
        transfer.mint === expectedTransfer.asset
        && transfer.amount === expectedTransfer.amount
        && transfer.recipient === expectedTransfer.payee
        && transfer.payer === expectedTransfer.payer,
      );

      if (parsedTransfers.length !== 1 || matchingTransfers.length !== 1) {
        return {
          memoVerification,
          transferVerification: "mismatch",
          reason: "The original transaction did not contain exactly one expected token transfer (mint, amount, recipient and payer must match).",
        };
      }

      return {
        memoVerification,
        transferVerification: "verified",
        transfer: matchingTransfers[0],
      };
    } catch {
      return { memoVerification: "unavailable", transferVerification: "unavailable" };
    }
  }

  private score(payer: string, transactionHash: string): DevnetFitScoreResource {
    const fit = payer === this.config.payerPublicKey ? "wide" : "unknown";
    return {
      resourceName: RESOURCE_NAME,
      scoredAt: new Date().toISOString(),
      fit,
      scores: [
        { productId: "p_vista_max", fitScore: 95, note: "Wide last, max cushioning, outstanding arch support for wide feet" },
        { productId: "p_streak_4", fitScore: 72, note: "Standard fit runs snug on wide feet" },
        { productId: "p_stride_lite", fitScore: 45, note: "Narrow last unsuitable for wide fit" },
        { productId: "p_trail_rock", fitScore: 68, note: "Standard fit, roomy toebox but narrow midfoot" },
        { productId: "p_gym_pace", fitScore: 60, note: "Standard fit, medium width" },
        { productId: "p_casual_day", fitScore: 88, note: "Wide fit, relaxed everyday silhouette" },
      ],
    };
  }
}

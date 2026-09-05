import {
  SOLANA_DEVNET_CAIP2,
  buildPaymentRequired,
  buildPaymentResponse,
  encodeHeader,
  formatX402Amount,
  isMemoValid,
  memoForEnvelope,
  parsePaymentRequired,
  parsePaymentResponse,
  canonicalToolSpendRequestDigest,
  type PaymentRequired,
  type PaymentSignaturePayload,
  type SettlementResponse,
  type ToolSpendRequest,
} from "@agentready/payments";
import { loadX402Config, type X402DevnetConfig } from "@agentready/payments/x402-config";
import { DevnetMachineResource, type DevnetFitScoreResource, type DevnetSettlementEvidence } from "@agentready/payments/devnet-machine";
import {
  assertSettlementStoreAllowed,
  createSettlementPool,
  InMemorySettlementStore,
  parseEncryptionKey,
  pgTransactable,
  PostgresSettlementStore,
  SettlementBootError,
  SettlementDisabledError,
  type SettlementStore,
  type StoredAttempt,
} from "@agentready/payments/x402-settlement-store";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import type { ExactSvmScheme as ExactSvmClientScheme } from "@x402/svm/exact/client";

type DevnetPaymentRequirements = Parameters<ExactSvmClientScheme["createPaymentPayload"]>[1];
type DevnetPaymentRequired = {
  x402Version: number;
  resource: Record<string, unknown>;
  accepts: DevnetPaymentRequirements[];
  extensions?: Record<string, unknown>;
};

type DevnetPaymentPayload = {
  x402Version: number;
  resource: Record<string, unknown>;
  accepted: DevnetPaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

export type DevnetMachinePaymentAttempt = {
  paymentIdentifier: string;
  requestDigest: string;
  spendingRequest: ToolSpendRequest;
  encodedPayment: string;
};

export type FitScore = {
  productId: string;
  fitScore: number;
  note: string;
};

export type FitScoreResource = {
  resourceName: string;
  scoredAt: string;
  fit: string;
  scores: FitScore[];
};

export type MachineSpendConfig = {
  resourceName: string;
  payeeWallet: string;
  usdcMint: string;
  amountMinor: number;
  network: string;
  agentWallet: string;
};

export const DEFAULT_MACHINE_SPEND: MachineSpendConfig = {
  resourceName: "RunVista Premium Fit-Scoring API",
  payeeWallet: "demo_payee_RunVista_mock",
  usdcMint: "usdc_devnet_mock_mint",
  amountMinor: 10_000, // 0.01 USDC
  network: SOLANA_DEVNET_CAIP2,
  agentWallet: "demo_agent_wallet_mock",
};

export type MachineSpendOutcome = {
  ok: boolean;
  settlement?: SettlementResponse;
  resource?: FitScoreResource;
  mock: boolean;
  error?: string;
};

const MEMO_PREFIX = "agentcart:v1:";

export class DemoMachineResource {
  readonly mock = true;
  private processed = new Map<string, SettlementResponse>();
  private cachedResource = new Map<string, FitScoreResource>();

  constructor(private readonly config: MachineSpendConfig) {}

  quote(envelopeHash: string): string {
    const required: PaymentRequired = {
      resource: this.config.resourceName,
      options: [
        {
          scheme: "exact",
          network: this.config.network,
          asset: "USDC",
          amount: formatX402Amount(this.config.amountMinor),
          payee: this.config.payeeWallet,
          timeout: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          paymentIdentifier: { required: true, maxLength: 128 },
          extra: { memo: memoForEnvelope(envelopeHash), maxMemoLength: 256 },
        },
      ],
    };
    return buildPaymentRequired(this.config.resourceName, required.options);
  }

  hasProcessed(paymentIdentifier: string): boolean {
    return this.processed.has(paymentIdentifier);
  }

  reset(): void {
    this.processed.clear();
    this.cachedResource.clear();
  }

  agentWallet(): string {
    return this.config.agentWallet;
  }

  accept(paymentSignatureHeader: string, envelopeHash: string): { status: number; body: unknown; headers: Record<string, string> } {
    if (!paymentSignatureHeader) {
      return {
        status: 402,
        body: { error: "payment_required", detail: "This resource requires payment. Retry with PAYMENT-SIGNATURE." },
        headers: { "PAYMENT-REQUIRED": this.quote(envelopeHash) },
      };
    }

    let payload: PaymentSignaturePayload;
    try {
      payload = JSON.parse(Buffer.from(paymentSignatureHeader, "base64url").toString("utf8")) as PaymentSignaturePayload;
    } catch {
      return { status: 400, body: { error: "malformed_payment_signature" }, headers: {} };
    }

    const errors: string[] = [];
    if (payload.scheme !== "exact") errors.push("scheme must be exact");
    if (payload.network !== this.config.network) errors.push(`wrong network ${payload.network}`);
    if (!payload.paymentIdentifier) errors.push("payment-identifier required");
    if (Number(payload.paymentPayload?.amount) < this.config.amountMinor / 1_000_000) {
      errors.push("underpayment");
    }
    if (payload.paymentPayload?.payee && payload.paymentPayload.payee !== this.config.payeeWallet) {
      errors.push("wrong recipient");
    }
    if (!isMemoValid(payload.paymentPayload?.memo, memoForEnvelope(envelopeHash))) {
      errors.push("memo mismatch");
    }

    if (errors.length > 0) {
      return { status: 402, body: { error: "payment_rejected", detail: errors.join("; ") }, headers: {} };
    }

    if (this.processed.has(payload.paymentIdentifier)) {
      const settlement = this.processed.get(payload.paymentIdentifier)!;
      return {
        status: 200,
        body: { ...this.cachedResource.get(payload.paymentIdentifier)!, note: "replay: cached result returned, no second charge" },
        headers: { "PAYMENT-RESPONSE": buildPaymentResponse(settlement) },
      };
    }

    const settlement: SettlementResponse = {
      success: true,
      network: this.config.network,
      payer: payload.paymentPayload.payer,
      amount: payload.paymentPayload.amount,
      transactionHash: `tx_mock_${payload.paymentIdentifier}`,
      paymentIdentifier: payload.paymentIdentifier,
      memo: payload.paymentPayload.memo,
    };

    const resource = this.score(payload.paymentPayload.payer, settlement.transactionHash ?? "");
    this.processed.set(payload.paymentIdentifier, settlement);
    this.cachedResource.set(payload.paymentIdentifier, resource);

    return {
      status: 200,
      body: resource,
      headers: { "PAYMENT-RESPONSE": buildPaymentResponse(settlement) },
    };
  }

  private score(payer: string, transactionHash: string): FitScoreResource {
    const fit = payer === this.config.agentWallet ? "wide" : "unknown";
    return {
      resourceName: this.config.resourceName,
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

export function signAsAgent(payload: PaymentSignaturePayload): string {
  return encodeHeader(payload);
}

export function runMachineSpend(
  resource: DemoMachineResource,
  envelopeHash: string,
  paymentIdentifier: string,
): MachineSpendOutcome {
  const requiredHeader = resource.quote(envelopeHash);
  const required = parsePaymentRequired(requiredHeader);
  const option = required.options[0]!;

  const paymentSignature = signAsAgent({
    scheme: "exact",
    network: option.network,
    paymentIdentifier,
    paymentPayload: {
      transaction: `tx_signed_mock_${paymentIdentifier}`,
      payer: resource.agentWallet(),
      amount: option.amount,
      payee: option.payee,
      memo: option.extra?.memo,
    },
  } satisfies PaymentSignaturePayload);

  const response = resource.accept(paymentSignature, envelopeHash);
  if (response.status !== 200) {
    return { ok: false, mock: true, error: String(response.body) };
  }
  const settlement = parsePaymentResponse(response.headers["PAYMENT-RESPONSE"]!);
  return {
    ok: true,
    settlement,
    resource: response.body as FitScoreResource,
    mock: true,
  };
}

let _devnetResource: DevnetMachineResource | null = null;
let _devnetTestOverride: DevnetMachineResource | null = null;

export function createDevnetSettlementStore(): SettlementStore {
  if (process.env.X402_SETTLEMENT_ENABLED === "false") {
    throw new SettlementDisabledError("x402 settlement is disabled by operator kill-switch.");
  }
  // The web app must run with the restricted x402_app credential only.
  // X402_APP_DATABASE_URL takes precedence; DATABASE_URL is a fallback for
  // local/mock operation. The operator credential must never be configured
  // here — it lives outside the web app (operator CLI only).
  const appDatabaseUrl = process.env.X402_APP_DATABASE_URL || process.env.DATABASE_URL;
  const config = loadX402Config();
  if ((config.mode === "devnet" || process.env.NODE_ENV === "production") && !process.env.X402_APP_DATABASE_URL) {
    throw new SettlementBootError("X402_APP_DATABASE_URL (x402_app credential) is required; refusing the privileged DATABASE_URL.");
  }
  const backend = assertSettlementStoreAllowed({
    mode: config.mode,
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: appDatabaseUrl,
    encKeyHex: process.env.X402_STORE_ENC_KEY,
    settlementEnabled: process.env.X402_SETTLEMENT_ENABLED !== "false",
  });
  if (backend !== "postgres") {
    throw new SettlementBootError("PostgreSQL settlement store is required for x402 devnet operation.");
  }
  const pool = createSettlementPool(appDatabaseUrl as string, {
    poolMax: Number(process.env.PGPOOL_MAX ?? 3),
    statementTimeoutMs: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000),
  });
  return new PostgresSettlementStore(
    pgTransactable(pool),
    parseEncryptionKey(process.env.X402_STORE_ENC_KEY),
  );
}

export function getDevnetMachineResource(): DevnetMachineResource {
  if (_devnetTestOverride) return _devnetTestOverride;
  if (!_devnetResource) {
    const config = loadX402Config();
    if (config.mode !== "devnet") {
      throw new Error("getDevnetMachineResource called but X402_MODE is not devnet");
    }
    _devnetResource = new DevnetMachineResource(config, createDevnetSettlementStore());
  }
  return _devnetResource;
}

/** Test seam only: inject a resource backed by InMemorySettlementStore. */
export function setDevnetMachineResourceForTests(resource: DevnetMachineResource | null): void {
  _devnetTestOverride = resource;
  if (resource === null) _devnetResource = null;
}

export type MachineResourceMode = "mock" | "devnet";

export function getMachineResourceMode(): MachineResourceMode {
  const config = loadX402Config();
  return config.mode;
}

export type DevnetMachineSpendOutcome = {
  ok: boolean;
  settlement?: SettlementResponse;
  resource?: DevnetFitScoreResource;
  mock: false;
  error?: string;
  status?: number;
  pending?: boolean;
  reconciliationState?: "settled" | "pending" | "manual_reconciliation_required" | "rejected";
  retryable?: boolean;
  paymentIdentifier?: string;
  requestDigest?: string;
  settlementEvidence?: DevnetSettlementEvidence;
};

function cloneDevnetPaymentAttempt(attempt: DevnetMachinePaymentAttempt): DevnetMachinePaymentAttempt {
  return {
    ...attempt,
    spendingRequest: { ...attempt.spendingRequest },
  };
}

export async function prepareDevnetMachineSpend(
  spendingRequest: ToolSpendRequest,
  paymentIdentifier: string,
  approvalEventId?: string,
): Promise<DevnetMachinePaymentAttempt> {
  const resource = getDevnetMachineResource();
  await resource.ensureInitialized();

  const requestDigest = resource.buildRequestDigest(spendingRequest);
  // Same payment ID bound to a different request is always a conflict.
  const samePid = await resource.findAttemptsByPaymentId(paymentIdentifier);
  if (samePid.some((row) => row.requestDigest !== requestDigest)) {
    throw new Error("Payment identifier is already reserved for a different spending request.");
  }

  const requiredHeader = await resource.quote(requestDigest);
  const required = JSON.parse(
    Buffer.from(requiredHeader, "base64url").toString("utf8"),
  ) as DevnetPaymentRequired;

  const officialAccept = required.accepts[0];
  if (!officialAccept) {
    throw new Error("No acceptance options returned from official x402 quote");
  }

  const { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
  const { ExactSvmScheme } = await import("@x402/svm/exact/client");

  const config = loadX402Config() as X402DevnetConfig;
  const signer = config.payerSecretKey.length === 64
    ? await createKeyPairSignerFromBytes(config.payerSecretKey)
    : await createKeyPairSignerFromPrivateKeyBytes(config.payerSecretKey);
  const svmScheme = new ExactSvmScheme(signer, { rpcUrl: config.solanaRpcUrl });

  const paymentPayload = await svmScheme.createPaymentPayload(2, officialAccept);
  const fullPayload: DevnetPaymentPayload = {
    x402Version: required.x402Version,
    resource: required.resource,
    accepted: officialAccept,
    payload: paymentPayload.payload,
    extensions: appendPaymentIdentifierToExtensions(
      { ...(required.extensions ?? {}) },
      paymentIdentifier,
    ),
  };

  const attempt: DevnetMachinePaymentAttempt = {
    paymentIdentifier,
    requestDigest,
    spendingRequest: { ...spendingRequest },
    encodedPayment: Buffer.from(JSON.stringify(fullPayload)).toString("base64url"),
  };
  // Persist the signed attempt BEFORE any external submission, so a crash
  // between signing and POST cannot lose it. Storage deduplicates resubmits.
  await resource.stagePreparedAttempt({
    spendingRequest,
    paymentIdentifier,
    encodedPayment: attempt.encodedPayment,
    approvalEventId,
  });
  return cloneDevnetPaymentAttempt(attempt);
}

export async function runDevnetMachineSpend(
  spendingRequest: ToolSpendRequest,
  appOrigin: string,
  paymentIdentifier: string,
  preparedAttempt?: DevnetMachinePaymentAttempt,
  approvalEventId?: string,
): Promise<DevnetMachineSpendOutcome> {
  const resource = getDevnetMachineResource();
  await resource.ensureInitialized();

  const requestDigest = resource.buildRequestDigest(spendingRequest);
  let attempt: DevnetMachinePaymentAttempt;

  if (preparedAttempt) {
    if (
      preparedAttempt.paymentIdentifier !== paymentIdentifier ||
      preparedAttempt.requestDigest !== requestDigest ||
      canonicalToolSpendRequestDigest(preparedAttempt.spendingRequest) !== requestDigest
    ) {
      return {
        ok: false,
        mock: false,
        status: 409,
        reconciliationState: "rejected",
        error: "Prepared payment attempt does not match the spending request.",
        paymentIdentifier,
        requestDigest,
      };
    }
    attempt = cloneDevnetPaymentAttempt(preparedAttempt);
  } else {
    try {
      attempt = await prepareDevnetMachineSpend(spendingRequest, paymentIdentifier);
    } catch (error) {
      return {
        ok: false,
        mock: false,
        status: 502,
        reconciliationState: "rejected",
        error: error instanceof Error ? error.message : String(error),
        paymentIdentifier,
        requestDigest,
      };
    }
  }

  const origin = appOrigin.replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${origin}/api/resources/premium-fit-score`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": attempt.encodedPayment,
      },
      body: JSON.stringify({ requestDigest: attempt.requestDigest, spendingRequest: attempt.spendingRequest, approvalEventId }),
    });
  } catch (error) {
    return {
      ok: false,
      mock: false,
      status: 202,
      pending: true,
      reconciliationState: "manual_reconciliation_required",
      retryable: false,
      paymentIdentifier: attempt.paymentIdentifier,
      requestDigest: attempt.requestDigest,
      error: `Tool-payment transport failed without a transaction signature; manual reconciliation is required. ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status !== 200) {
    const errorBody = await response.json().catch(() => ({ error: "unknown" }));
    const body = typeof errorBody === "object" && errorBody !== null
      ? errorBody as Record<string, unknown>
      : undefined;
    const errorCode = typeof body?.error === "string" ? body.error : "";
    const settlementUnresolved = errorCode === "settlement_ambiguous" || errorCode === "settlement_transaction_mismatch";
    const hasKnownTransactionHash = typeof body?.transactionHash === "string" && body.transactionHash.length > 0;
    const supportedReconciliation = body?.retryable !== false && (
      body?.reconciliationState === "pending"
      || body?.retryable === true
      || hasKnownTransactionHash
    );
    const reconciliationState = body?.reconciliationState === "manual_reconciliation_required"
      ? "manual_reconciliation_required"
      : settlementUnresolved
        ? supportedReconciliation ? "pending" : "manual_reconciliation_required"
        : "rejected";
    const retryable = supportedReconciliation && reconciliationState === "pending";
    return {
      ok: false,
      mock: false,
      status: response.status,
      pending: settlementUnresolved,
      reconciliationState,
      retryable,
      paymentIdentifier: attempt.paymentIdentifier,
      requestDigest: attempt.requestDigest,
      error: typeof body?.detail === "string" ? body.detail : body?.error
        ? String(body.error)
        : String(errorBody),
    };
  }

  const result = await response.json() as {
    settlementEvidence?: DevnetSettlementEvidence;
    scores?: Array<{ productId: string; fitScore: number; note: string }>;
    fit?: string;
    resourceName?: string;
    scoredAt?: string;
  };

  const paymentResponseHeader = response.headers.get("PAYMENT-RESPONSE");
  let settlement: SettlementResponse | undefined;
  if (paymentResponseHeader) {
    try {
      const parsed = JSON.parse(
        Buffer.from(paymentResponseHeader, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      settlement = {
        success: Boolean(parsed.success),
        network: String(parsed.network ?? ""),
        payer: String(parsed.payer ?? ""),
        amount: String(parsed.amount ?? spendingRequest.amountMinor),
        transactionHash: String(parsed.transactionHash ?? ""),
        paymentIdentifier: String(parsed.paymentIdentifier ?? ""),
        memo: String(parsed.memo ?? ""),
      };
    } catch { /* ignore parse errors */ }
  }

  return {
    ok: true,
    settlement,
    resource: result.scores
      ? { resourceName: result.resourceName ?? "", scoredAt: result.scoredAt ?? "", fit: result.fit ?? "unknown", scores: result.scores }
      : undefined,
    mock: false,
    reconciliationState: "settled",
    retryable: false,
    settlementEvidence: result.settlementEvidence,
  };
}

const RESOURCE_URL = "/api/resources/premium-fit-score";
const RESOURCE_NAME = "RunVista Premium Fit-Scoring API";

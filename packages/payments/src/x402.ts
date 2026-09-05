import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import { type X402Config, type X402DevnetConfig, type X402MockConfig } from "./x402-config";
export type { X402Config, X402DevnetConfig, X402MockConfig } from "./x402-config";

export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export type X402PaymentOption = {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payee: string;
  timeout: string;
  paymentIdentifier?: { required: boolean; maxLength?: number };
  extra?: { memo?: string; maxMemoLength?: number };
};

export type PaymentRequired = {
  resource: string;
  options: X402PaymentOption[];
};

export type PaymentSignaturePayload = {
  scheme: "exact";
  network: string;
  paymentIdentifier: string;
  paymentPayload: {
    transaction: string;
    payer: string;
    amount: string;
    payee?: string;
    memo?: string;
  };
};

export type SettlementResponse = {
  success: boolean;
  network: string;
  payer: string;
  amount: string;
  transactionHash?: string;
  paymentIdentifier?: string;
  memo?: string;
  error?: string;
};

export class X402ProtocolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeHeader<T>(header: string): T {
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as T;
}

export function buildPaymentRequired(resource: string, options: X402PaymentOption[]): string {
  return encodeHeader({ resource, options } satisfies PaymentRequired);
}

export function parsePaymentRequired(header: string): PaymentRequired {
  const parsed = decodeHeader<PaymentRequired>(header);
  if (!parsed.resource || !Array.isArray(parsed.options) || parsed.options.length === 0) {
    throw new X402ProtocolError("Malformed PAYMENT-REQUIRED payload", 400, "malformed_payment_required");
  }
  return parsed;
}

export function buildPaymentResponse(settlement: SettlementResponse): string {
  return encodeHeader(settlement);
}

export function parsePaymentResponse(header: string): SettlementResponse {
  const parsed = decodeHeader<SettlementResponse>(header);
  if (typeof parsed.success !== "boolean") {
    throw new X402ProtocolError("Malformed PAYMENT-RESPONSE payload", 400, "malformed_payment_response");
  }
  return parsed;
}

export type X402ResourceRequest = {
  resourceUrl: string;
  network: string;
  asset: string;
  payee: string;
  amountMinor: number;
  memo: string;
  paymentIdentifier: string;
};

export type X402ResourceResult = {
  resource: unknown;
  settlement: SettlementResponse;
  paymentIdentifier: string;
  mock: boolean;
};

export interface X402MachineAdapter {
  readonly mock: boolean;
  requestResource(input: X402ResourceRequest): Promise<X402ResourceResult>;
  hasProcessed(paymentIdentifier: string): boolean;
  lastSettlement(paymentIdentifier: string): SettlementResponse | undefined;
}

export function memoForEnvelope(envelopeHash: string): string {
  return `agentcart:v1:${envelopeHash}`;
}

export function isMemoValid(memo: string | undefined, expected: string): boolean {
  return memo === expected;
}

/**
 * Extract the recent blockhash from a base64url-encoded signed-payment
 * envelope without trusting any of its contents. Returns null for malformed
 * payloads, missing transactions, or undecodable messages — callers treat
 * null as "expiry unprovable", never as expired.
 */
export async function extractTransactionBlockhash(encodedPayment: string): Promise<string | null> {
  try {
    const envelope = JSON.parse(Buffer.from(encodedPayment, "base64url").toString("utf8")) as {
      payload?: { transaction?: unknown };
    };
    const wire = envelope?.payload?.transaction;
    if (typeof wire !== "string" || wire.length === 0) return null;
    const { getTransactionDecoder, getCompiledTransactionMessageDecoder } = await import("@solana/kit");
    const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64") as unknown as Uint8Array) as {
      messageBytes?: unknown;
    };
    if (!tx?.messageBytes) return null;
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes as Uint8Array) as {
      lifetimeConstraint?: { blockhash?: unknown };
      recentBlockhash?: unknown;
      lifetimeToken?: unknown;
    } | null;
    if (!message) return null;
    const lifetime = message.lifetimeConstraint;
    if (lifetime && typeof lifetime.blockhash === "string" && lifetime.blockhash.length > 0) {
      return lifetime.blockhash;
    }
    if (typeof message.recentBlockhash === "string" && message.recentBlockhash.length > 0) {
      return message.recentBlockhash;
    }
    // Compiled wire form carries the blockhash as the lifetime token.
    if (typeof message.lifetimeToken === "string" && message.lifetimeToken.length > 0) {
      return message.lifetimeToken;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the first Solana transaction signature from the stored signed wire
 * transaction. Release uses this only for a read-only RPC existence check;
 * failure to decode is refusal, never evidence that no transaction exists.
 */
export function extractTransactionSignature(encodedPayment: string): string | null {
  try {
    const envelope = JSON.parse(Buffer.from(encodedPayment, "base64url").toString("utf8")) as {
      payload?: { transaction?: unknown };
    };
    const wire = envelope?.payload?.transaction;
    if (typeof wire !== "string" || wire.length === 0) return null;
    const bytes = Buffer.from(wire, "base64");
    let offset = 0;
    let count = 0;
    let shift = 0;
    while (offset < bytes.length && shift <= 28) {
      const byte = bytes[offset];
      if (byte === undefined) return null;
      offset += 1;
      count |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    if (count < 1 || offset + 64 > bytes.length) return null;
    return base58.encode(bytes.subarray(offset, offset + 64));
  } catch {
    return null;
  }
}

export type BlockhashValidity = {
  expired: boolean;
  slot: number | null;
  blockhash: string;
};

/**
 * Canonical Solana blockhash-validity check: a recent blockhash is usable for
 * roughly 150 slots, and only the RPC `isBlockhashValid` verdict proves
 * expiry. Any transport failure or non-boolean verdict fails closed
 * (expired: false). fetchFn/timeoutMs are injectable for offline tests.
 */
export async function checkBlockhashExpired(
  rpcUrl: string,
  blockhash: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<BlockhashValidity> {
  try {
    const response = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "isBlockhashValid", params: [blockhash, { commitment: "finalized" }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (typeof response.ok === "boolean" && !response.ok) return { expired: false, slot: null, blockhash };
    const data = (await response.json()) as { result?: { value?: unknown; context?: { slot?: unknown } } };
    const value = data?.result?.value;
    const slot = data?.result?.context?.slot;
    if (typeof value !== "boolean") return { expired: false, slot: null, blockhash };
    return { expired: value === false, slot: typeof slot === "number" ? slot : null, blockhash };
  } catch {
    return { expired: false, slot: null, blockhash };
  }
}

export function formatX402Amount(amountMinor: number, decimals = 6): string {
  return (amountMinor / 10 ** decimals).toFixed(decimals);
}

export type ToolSpendRequest = {
  orderId: string;
  intentVersion: number;
  resource: string;
  amountMinor: number;
  network: string;
  asset: string;
  payee: string;
  purpose: string;
};

export const DEVNET_FIT_SCORE_RESOURCE = "/api/resources/premium-fit-score";
export const DEVNET_FIT_SCORE_PURPOSE = "fit_scoring";

export function buildDevnetToolSpendRequest(
  config: X402DevnetConfig,
  orderId: string,
  intentVersion: number,
): ToolSpendRequest {
  return {
    orderId,
    intentVersion,
    resource: DEVNET_FIT_SCORE_RESOURCE,
    amountMinor: config.amountMinor,
    network: SOLANA_DEVNET_CAIP2,
    asset: config.devnetUsdcMint,
    payee: config.payeePublicKey,
    purpose: DEVNET_FIT_SCORE_PURPOSE,
  };
}

export function canonicalToolSpendRequestDigest(req: ToolSpendRequest): string {
  const canonical = JSON.stringify({
    orderId: req.orderId,
    intentVersion: req.intentVersion,
    resource: req.resource,
    amountMinor: req.amountMinor,
    network: req.network,
    asset: req.asset,
    payee: req.payee,
    purpose: req.purpose,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Mock order-payment request for the checkout rail selector.
 *
 * This is a simulation shown in the storefront behind an explicit
 * "Solana Devnet simulation, no funds moved" label. It reuses the canonical
 * digest pattern above but binds to the approved Commerce Envelope hash —
 * never to the real Devnet fit-score settlement, which must not be presented
 * as an order payment. No wallet, facilitator, or chain call is involved.
 */
export const X402_MOCK_ORDER_NETWORK = SOLANA_DEVNET_CAIP2;
export const X402_MOCK_ORDER_ASSET = "usdc_devnet_mock_mint";
export const X402_MOCK_ORDER_PAYEE = "demo_payee_RunVista_mock";
export const X402_MOCK_ORDER_PURPOSE = "order_payment";

export type OrderPaymentRequest = {
  logicalOrderId: string;
  envelopeDigest: string;
  network: string;
  asset: string;
  amountMinor: number;
  currency: string;
  payee: string;
  purpose: typeof X402_MOCK_ORDER_PURPOSE;
};

export function canonicalOrderPaymentRequestDigest(req: OrderPaymentRequest): string {
  const canonical = JSON.stringify({
    logicalOrderId: req.logicalOrderId,
    envelopeDigest: req.envelopeDigest,
    network: req.network,
    asset: req.asset,
    amountMinor: req.amountMinor,
    currency: req.currency,
    payee: req.payee,
    purpose: req.purpose,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function mockOrderPaymentIdentifier(requestDigest: string): string {
  return `x402ord_${requestDigest.slice(0, 12)}`;
}

export type CanonicalPaymentRequirements = {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { memo: string };
};

export function buildCanonicalRequirements(
  config: X402DevnetConfig,
  requestDigest: string,
): CanonicalPaymentRequirements {
  return {
    scheme: "exact",
    network: SOLANA_DEVNET_CAIP2,
    asset: config.devnetUsdcMint,
    amount: String(config.amountMinor),
    payTo: config.payeePublicKey,
    maxTimeoutSeconds: 300,
    extra: { memo: memoForEnvelope(requestDigest) },
  };
}

export function verifyCanonicalRequirements(
  supplied: { scheme?: string; network?: string; asset?: string; amount?: string; payTo?: string; memo?: string },
  canonical: CanonicalPaymentRequirements,
): string[] {
  const errors: string[] = [];
  if (supplied.scheme !== canonical.scheme) errors.push(`scheme must be ${canonical.scheme}, got ${supplied.scheme}`);
  if (supplied.network !== canonical.network) errors.push(`wrong network: expected ${canonical.network}, got ${supplied.network}`);
  if (supplied.asset !== canonical.asset) errors.push(`wrong asset: expected ${canonical.asset}, got ${supplied.asset}`);
  if (supplied.payTo !== canonical.payTo) errors.push(`wrong payee: expected ${canonical.payTo}, got ${supplied.payTo}`);
  if (supplied.memo !== canonical.extra.memo) errors.push(`memo mismatch: expected ${canonical.extra.memo}, got ${supplied.memo}`);
  if (supplied.amount !== undefined && canonical.amount !== undefined) {
    const suppliedAtomic = BigInt(supplied.amount);
    const canonicalAtomic = BigInt(canonical.amount);
    if (suppliedAtomic < canonicalAtomic) {
      errors.push(`underpayment: expected at least ${canonical.amount}, got ${supplied.amount}`);
    }
  }
  return errors;
}

export type AdaptedSettlement = {
  success: boolean;
  transactionHash: string;
  payer: string;
  payee: string;
  network: string;
  asset: string;
  amount: string;
  facilitatorUrl: string;
  paymentIdentifier: string;
};

export function adaptSettlement(
  raw: { success: boolean; transaction?: string; network?: string; payer?: string; amount?: string; errorReason?: string; errorMessage?: string },
  overrides: { payee: string; asset: string; facilitatorUrl: string; paymentIdentifier: string; amount?: string },
): AdaptedSettlement {
  if (!raw.success) {
    const amount = raw.amount || overrides.amount;
    if (!amount) {
      throw new Error("Settlement did not provide an amount and no verified canonical amount was available.");
    }
    return {
      success: false,
      transactionHash: raw.transaction ?? "",
      payer: raw.payer ?? "",
      payee: overrides.payee,
      network: raw.network ?? "",
      asset: overrides.asset,
      amount,
      facilitatorUrl: overrides.facilitatorUrl,
      paymentIdentifier: overrides.paymentIdentifier,
    };
  }
  if (!raw.transaction) {
    throw new Error("Settlement returned success but no transaction signature was provided.");
  }
  if (!raw.payer) {
    throw new Error("Settlement returned success but no payer was provided.");
  }
  const amount = raw.amount || overrides.amount;
  if (!amount) {
    throw new Error("Settlement did not provide an amount and no verified canonical amount was available.");
  }
  return {
    success: true,
    transactionHash: raw.transaction,
    payer: raw.payer,
    payee: overrides.payee,
    network: raw.network ?? SOLANA_DEVNET_CAIP2,
    asset: overrides.asset,
    amount,
    facilitatorUrl: overrides.facilitatorUrl,
    paymentIdentifier: overrides.paymentIdentifier,
  };
}

export type MemoVerificationState = "verified" | "missing" | "unavailable";

export function memoVerificationLabel(state: MemoVerificationState): string {
  switch (state) {
    case "verified": return "on-chain memo verified";
    case "missing": return "memo instruction not found in confirmed transaction";
    case "unavailable": return "on-chain verification unavailable (RPC query did not return results)";
  }
}

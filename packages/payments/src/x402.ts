export const X402_NETWORK_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const X402_NETWORK_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

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

export function formatX402Amount(amountMinor: number, decimals = 6): string {
  return (amountMinor / 10 ** decimals).toFixed(decimals);
}
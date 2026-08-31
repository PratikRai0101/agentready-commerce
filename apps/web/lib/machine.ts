import {
  X402_NETWORK_DEVNET,
  buildPaymentRequired,
  buildPaymentResponse,
  encodeHeader,
  formatX402Amount,
  isMemoValid,
  memoForEnvelope,
  parsePaymentRequired,
  parsePaymentResponse,
  type PaymentRequired,
  type PaymentSignaturePayload,
  type SettlementResponse,
  type X402ResourceResult,
} from "@agentready/payments";

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
  network: X402_NETWORK_DEVNET,
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
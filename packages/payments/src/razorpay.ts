import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { envelopeDigest, newId } from "@agentready/domain";
import type { CommerceEnvelope, PaymentRail } from "@agentready/domain";
import type {
  CompensationInput,
  CompensationResult,
  PaymentAdapter,
  PaymentAttempt,
  VerificationInput,
  VerificationResult,
} from "./types";

export type RazorpayConfig = {
  keyId: string;
  keySecret: string;
  webhookSecret?: string;
  apiBase?: string;
};

const API_BASE = "https://api.razorpay.com/v1";

export function razorpaySignature(keySecret: string, payload: string): string {
  return createHmac("sha256", keySecret).update(payload, "utf8").digest("hex");
}

export function verifyRazorpayPaymentSignature(
  keySecret: string,
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const expected = razorpaySignature(keySecret, `${orderId}|${paymentId}`);
  return timingSafeEqual(expected, signature);
}

export function verifyRazorpayWebhookSignature(
  webhookSecret: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected = razorpaySignature(webhookSecret, rawBody);
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && nodeTimingSafeEqual(bufA, bufB);
}

export class RazorpayAdapter implements PaymentAdapter {
  readonly rail: PaymentRail = "razorpay_checkout";
  readonly isMock = false;

  constructor(private readonly config: RazorpayConfig) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString("base64")}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.config.apiBase ?? API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader(),
        ...(init?.headers ?? {}),
      },
    });
    const body = (await response.json()) as T & { error?: { description?: string; code?: string } };
    if (!response.ok) {
      const description = body.error?.description ?? `HTTP ${response.status}`;
      throw new Error(`Razorpay ${init?.method ?? "GET"} ${path} failed: ${description}`);
    }
    return body;
  }

  async initiate(envelope: CommerceEnvelope): Promise<PaymentAttempt> {
    const order = await this.request<{
      id: string;
      amount: number;
      currency: string;
      receipt?: string;
      notes?: Record<string, string>;
    }>("/orders", {
      method: "POST",
      body: JSON.stringify({
        amount: envelope.totalMinor,
        currency: envelope.currency,
        receipt: `logical_${envelope.logicalOrderId}`,
        notes: {
          logicalOrderId: envelope.logicalOrderId,
          quoteId: envelope.quoteId,
          envelopeHash: envelopeDigest(envelope),
        },
      }),
    });

    return {
      attemptId: newId("att"),
      logicalOrderId: envelope.logicalOrderId,
      rail: this.rail,
      externalOrderId: order.id,
      status: "created",
      createdAt: new Date().toISOString(),
      amountMinor: order.amount,
      currency: order.currency,
      checkoutPayload: {
        key: this.config.keyId,
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        name: "RunVista Sports",
        notes: order.notes,
        theme: { color: "#1a1a2e" },
      },
    };
  }

  async verify(input: VerificationInput): Promise<VerificationResult> {
    if (!input.signature) {
      return {
        verified: false,
        rail: this.rail,
        externalOrderId: input.externalOrderId,
        externalPaymentId: input.externalPaymentId,
        amountMinor: 0,
        currency: "INR",
        status: "failed",
        reason: "Missing signature",
      };
    }

    const signatureOk = verifyRazorpayPaymentSignature(
      this.config.keySecret,
      input.externalOrderId,
      input.externalPaymentId,
      input.signature,
    );

    if (!signatureOk) {
      return {
        verified: false,
        rail: this.rail,
        externalOrderId: input.externalOrderId,
        externalPaymentId: input.externalPaymentId,
        amountMinor: 0,
        currency: "INR",
        status: "failed",
        reason: "Invalid Razorpay signature",
      };
    }

    const payment = await this.request<{
      id: string;
      order_id: string;
      amount: number;
      currency: string;
      status: string;
    }>(`/payments/${input.externalPaymentId}`);

    const captured = payment.status === "captured" || payment.status === "authorized";
    return {
      verified: captured,
      rail: this.rail,
      externalOrderId: payment.order_id ?? input.externalOrderId,
      externalPaymentId: payment.id,
      amountMinor: payment.amount,
      currency: payment.currency,
      status: payment.status as VerificationResult["status"],
      reason: captured ? undefined : `Razorpay payment status: ${payment.status}`,
    };
  }

  async compensate(input: CompensationInput): Promise<CompensationResult> {
    const refund = await this.request<{ id: string; status: string }>(
      `/payments/${input.externalPaymentId}/refund`,
      {
        method: "POST",
        body: JSON.stringify({
          amount: input.amountMinor,
          notes: { logicalOrderId: input.logicalOrderId, reason: input.reason },
        }),
      },
    );
    return {
      compensated: true,
      rail: this.rail,
      refundId: refund.id,
    };
  }
}
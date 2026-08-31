import { createHmac } from "node:crypto";
import { newId } from "@agentready/domain";
import type { CommerceEnvelope, PaymentRail } from "@agentready/domain";
import { razorpaySignature } from "./razorpay";
import type {
  CompensationInput,
  CompensationResult,
  PaymentAdapter,
  PaymentAttempt,
  VerificationInput,
  VerificationResult,
} from "./types";

export type MockRazorpayConfig = {
  keyId: string;
  keySecret: string;
  failInitiate?: boolean;
};

export class MockRazorpayAdapter implements PaymentAdapter {
  readonly rail: PaymentRail = "razorpay_checkout";
  readonly isMock = true;

  constructor(private readonly config: MockRazorpayConfig) {}

  async initiate(envelope: CommerceEnvelope): Promise<PaymentAttempt> {
    if (this.config.failInitiate) {
      throw new Error("MOCK Razorpay: order creation failed (simulated outage)");
    }
    return {
      attemptId: newId("att"),
      logicalOrderId: envelope.logicalOrderId,
      rail: this.rail,
      externalOrderId: `order_MOCK_${envelope.logicalOrderId}`,
      status: "created",
      createdAt: new Date().toISOString(),
      amountMinor: envelope.totalMinor,
      currency: envelope.currency,
      checkoutPayload: {
        key: this.config.keyId,
        order_id: `order_MOCK_${envelope.logicalOrderId}`,
        amount: envelope.totalMinor,
        currency: envelope.currency,
        name: "RunVista Sports (MOCK)",
        mock: true,
      },
    };
  }

  async verify(input: VerificationInput): Promise<VerificationResult> {
    const expected = razorpaySignature(this.config.keySecret, `${input.externalOrderId}|${input.externalPaymentId}`);
    const signatureOk = input.signature !== undefined && timingSafeEqual(expected, input.signature);

    if (!signatureOk) {
      return {
        verified: false,
        rail: this.rail,
        externalOrderId: input.externalOrderId,
        externalPaymentId: input.externalPaymentId,
        amountMinor: 0,
        currency: "INR",
        status: "failed",
        reason: "Invalid signature (mock)",
      };
    }

    return {
      verified: true,
      rail: this.rail,
      externalOrderId: input.externalOrderId,
      externalPaymentId: input.externalPaymentId,
      amountMinor: input.expectedAmountMinor ?? 0,
      currency: "INR",
      status: "captured",
    };
  }

  async compensate(input: CompensationInput): Promise<CompensationResult> {
    return {
      compensated: true,
      rail: this.rail,
      refundId: `rfnd_MOCK_${input.externalPaymentId}`,
      reason: `MOCK refund for ${input.reason}`,
    };
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && createHmac("sha256", bufA).update(bufB).digest() === createHmac("sha256", bufB).update(bufA).digest();
}
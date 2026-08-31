import type { CommerceEnvelope, PaymentRail } from "@agentready/domain";

export type PaymentAttempt = {
  attemptId: string;
  logicalOrderId: string;
  rail: PaymentRail;
  externalOrderId?: string;
  externalPaymentId?: string;
  status: "created" | "authorized" | "captured" | "failed";
  createdAt: string;
  amountMinor: number;
  currency: string;
  checkoutPayload?: Record<string, unknown>;
};

export type VerificationInput = {
  logicalOrderId: string;
  envelopeHash: string;
  rail: PaymentRail;
  externalOrderId: string;
  externalPaymentId: string;
  expectedAmountMinor?: number;
  signature?: string;
  webhookPayload?: unknown;
};

export type VerificationResult = {
  verified: boolean;
  rail: PaymentRail;
  externalOrderId: string;
  externalPaymentId: string;
  amountMinor: number;
  currency: string;
  status: "captured" | "authorized" | "failed" | "pending";
  reason?: string;
};

export type CompensationInput = {
  logicalOrderId: string;
  envelopeHash: string;
  rail: PaymentRail;
  externalPaymentId: string;
  amountMinor: number;
  reason: string;
};

export type CompensationResult = {
  compensated: boolean;
  rail: PaymentRail;
  refundId?: string;
  reason?: string;
};

export interface PaymentAdapter {
  readonly rail: PaymentRail;
  readonly isMock: boolean;
  initiate(envelope: CommerceEnvelope): Promise<PaymentAttempt>;
  verify(input: VerificationInput): Promise<VerificationResult>;
  compensate(input: CompensationInput): Promise<CompensationResult>;
}
export const OPERATION_TYPES = [
  "session.create",
  "conversation.respond",
  "quote.build",
  "approval.grant",
  "payment.initiate",
  "payment.verify",
  "x402_order.prepare",
  "x402_order.confirm",
  "fulfilment.complete",
  "compensation.refund",
] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];

export const OPERATION_PHASES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "rejected",
] as const;

export type OperationPhase = (typeof OPERATION_PHASES)[number];

export type OperationOutcome = "success" | "failure" | "rejected";

export type OperationRecord = {
  operationId: string;
  aggregateIdentity: string;
  operationType: OperationType;
  requestHash: string;
  phase: OperationPhase;
  outcome?: OperationOutcome;
  resultRef?: string;
  errorRef?: string;
  resultPayload?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type SessionCreateRequest = {
  customerId: string;
};

export type ConversationRespondRequest = {
  orderId: string;
  message: string;
  intentVersion: number;
  recommendationVersion: number;
  recommendationActionToken: string;
};

export type QuoteBuildRequest = {
  orderId: string;
  productId: string;
};

export type ApprovalGrantRequest = {
  orderId: string;
  digest: string;
};

export type PaymentInitiateRequest = {
  orderId: string;
  rail: string;
};

export type PaymentVerifyRequest = {
  orderId: string;
  externalOrderId: string;
  externalPaymentId: string;
};

export type X402OrderPrepareRequest = {
  orderId: string;
};

export type X402OrderConfirmRequest = {
  orderId: string;
  paymentIdentifier: string;
};

export type FulfilmentCompleteRequest = {
  orderId: string;
  fail: boolean;
};

export type CompensationRefundRequest = {
  orderId: string;
};

export type OperationRequest =
  | { type: "session.create"; request: SessionCreateRequest }
  | { type: "conversation.respond"; request: ConversationRespondRequest }
  | { type: "quote.build"; request: QuoteBuildRequest }
  | { type: "approval.grant"; request: ApprovalGrantRequest }
  | { type: "payment.initiate"; request: PaymentInitiateRequest }
  | { type: "payment.verify"; request: PaymentVerifyRequest }
  | { type: "x402_order.prepare"; request: X402OrderPrepareRequest }
  | { type: "x402_order.confirm"; request: X402OrderConfirmRequest }
  | { type: "fulfilment.complete"; request: FulfilmentCompleteRequest }
  | { type: "compensation.refund"; request: CompensationRefundRequest };

export type IdempotencyResult =
  | { kind: "new"; record: OperationRecord }
  | { kind: "replay"; record: OperationRecord }
  | { kind: "conflict"; existing: OperationRecord; requestHash: string };

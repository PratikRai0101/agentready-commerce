import { createHash } from "node:crypto";
import { canonicalize } from "@agentready/domain";
import type {
  OperationType,
  SessionCreateRequest,
  ConversationRespondRequest,
  QuoteBuildRequest,
  ApprovalGrantRequest,
  PaymentInitiateRequest,
  PaymentVerifyRequest,
  FulfilmentCompleteRequest,
  CompensationRefundRequest,
} from "./types";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export type CanonicalRequest =
  | SessionCreateRequest
  | ConversationRespondRequest
  | QuoteBuildRequest
  | ApprovalGrantRequest
  | PaymentInitiateRequest
  | PaymentVerifyRequest
  | FulfilmentCompleteRequest
  | CompensationRefundRequest;

export function canonicalRequestHash(
  operationType: OperationType,
  request: CanonicalRequest,
): string {
  const canonical = canonicalize({ operationType, ...request });
  return sha256Hex(canonical);
}

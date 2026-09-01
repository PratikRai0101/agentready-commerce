import { createHash } from "node:crypto";
import { canonicalize } from "@agentready/domain";
import type {
  OperationType,
  SessionCreateRequest,
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

export function canonicalRequestHash(
  operationType: OperationType,
  request:
    | SessionCreateRequest
    | QuoteBuildRequest
    | ApprovalGrantRequest
    | PaymentInitiateRequest
    | PaymentVerifyRequest
    | FulfilmentCompleteRequest
    | CompensationRefundRequest,
): string {
  const canonical = canonicalize({ operationType, ...request });
  return sha256Hex(canonical);
}

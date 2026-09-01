import type {
  OperationRecord,
  OperationType,
  OperationPhase,
  OperationOutcome,
  IdempotencyResult,
  SessionCreateRequest,
  ConversationRespondRequest,
  QuoteBuildRequest,
  ApprovalGrantRequest,
  PaymentInitiateRequest,
  PaymentVerifyRequest,
  FulfilmentCompleteRequest,
  CompensationRefundRequest,
} from "./types";
import { canonicalRequestHash } from "./hashing";
import type { OperationStore } from "./store";

export type OperationRequest =
  | SessionCreateRequest
  | ConversationRespondRequest
  | QuoteBuildRequest
  | ApprovalGrantRequest
  | PaymentInitiateRequest
  | PaymentVerifyRequest
  | FulfilmentCompleteRequest
  | CompensationRefundRequest;

export type OperationCoordinator = {
  begin(
    operationId: string,
    operationType: OperationType,
    request: OperationRequest,
    aggregateIdentity: string,
  ): IdempotencyResult;

  transition(operationId: string, phase: OperationPhase): void;

  complete(operationId: string, outcome: OperationOutcome, resultRef?: string, errorRef?: string, resultPayload?: unknown): void;

  lookup(operationId: string): OperationRecord | undefined;

  clear(): void;
};

export function createOperationCoordinator(store: OperationStore): OperationCoordinator {
  return {
    begin(operationId, operationType, request, aggregateIdentity) {
      const requestHash = canonicalRequestHash(operationType, request);
      const existing = store.get(operationId);

      if (!existing) {
        const now = new Date().toISOString();
        const record: OperationRecord = {
          operationId,
          aggregateIdentity,
          operationType,
          requestHash,
          phase: "pending",
          createdAt: now,
          updatedAt: now,
        };
        store.set(operationId, record);
        return { kind: "new", record };
      }

      if (existing.requestHash === requestHash) {
        return { kind: "replay", record: existing };
      }

      return { kind: "conflict", existing, requestHash };
    },

    transition(operationId, phase) {
      const record = store.get(operationId);
      if (!record) throw new Error(`Operation ${operationId} not found`);
      record.phase = phase;
      record.updatedAt = new Date().toISOString();
      store.set(operationId, record);
    },

    complete(operationId, outcome, resultRef, errorRef, resultPayload) {
      const record = store.get(operationId);
      if (!record) throw new Error(`Operation ${operationId} not found`);
      record.phase = outcome === "success" ? "completed" : outcome === "failure" ? "failed" : "rejected";
      record.outcome = outcome;
      if (resultRef !== undefined) record.resultRef = resultRef;
      if (errorRef !== undefined) record.errorRef = errorRef;
      if (resultPayload !== undefined) record.resultPayload = structuredClone(resultPayload);
      record.updatedAt = new Date().toISOString();
      store.set(operationId, record);
    },

    lookup(operationId) {
      return store.get(operationId);
    },

    clear() {
      store.clear();
    },
  };
}

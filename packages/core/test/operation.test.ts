import { describe, expect, it, beforeEach } from "vitest";
import { createOperationCoordinator, MemoryOperationStore, EncryptedOperationStore, canonicalRequestHash } from "../src/index";

function makeCoordinator(secret?: string) {
  const store = secret
    ? new EncryptedOperationStore(secret)
    : new MemoryOperationStore();
  return { coordinator: createOperationCoordinator(store), store };
}

describe("canonicalRequestHash", () => {
  it("produces a deterministic 64-char hex digest", () => {
    const h1 = canonicalRequestHash("session.create", { customerId: "cust_1" });
    const h2 = canonicalRequestHash("session.create", { customerId: "cust_1" });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("differs for different inputs under the same type", () => {
    const h1 = canonicalRequestHash("payment.initiate", { orderId: "ord_A", rail: "razorpay_checkout" });
    const h2 = canonicalRequestHash("payment.initiate", { orderId: "ord_B", rail: "razorpay_checkout" });
    expect(h1).not.toBe(h2);
  });

  it("differs for the same input under different types", () => {
    const h1 = canonicalRequestHash("session.create", { customerId: "cust_1" });
    const h2 = canonicalRequestHash("payment.initiate", { orderId: "cust_1", rail: "razorpay_checkout" });
    expect(h1).not.toBe(h2);
  });

  it("conversation.respond hashes orderId + message + binding", () => {
    const h1 = canonicalRequestHash("conversation.respond", { orderId: "ord_1", message: "hello", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok" });
    const h2 = canonicalRequestHash("conversation.respond", { orderId: "ord_1", message: "hello", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok" });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("conversation.respond differs for different messages", () => {
    const h1 = canonicalRequestHash("conversation.respond", { orderId: "ord_1", message: "black shoes", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok" });
    const h2 = canonicalRequestHash("conversation.respond", { orderId: "ord_1", message: "red shoes", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok" });
    expect(h1).not.toBe(h2);
  });

  it("conversation.respond differs for different bindings", () => {
    const h1 = canonicalRequestHash("conversation.respond", { orderId: "ord_1", message: "hello", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok_a" });
    const h2 = canonicalRequestHash("conversation.respond", { orderId: "ord_1", message: "hello", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok_b" });
    expect(h1).not.toBe(h2);
  });
});

describe("OperationCoordinator", () => {
  let coordinator: ReturnType<typeof createOperationCoordinator>;

  beforeEach(() => {
    ({ coordinator } = makeCoordinator());
  });

  it("returns 'new' for the first submission with a given ID", () => {
    const result = coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(result.kind).toBe("new");
    if (result.kind === "new") {
      expect(result.record.operationId).toBe("op_1");
      expect(result.record.phase).toBe("pending");
      expect(result.record.operationType).toBe("session.create");
      expect(result.record.aggregateIdentity).toBe("ord_1");
      expect(result.record.requestHash).toHaveLength(64);
    }
  });

  it("returns 'replay' for same ID and same request", () => {
    coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    const result = coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(result.kind).toBe("replay");
    if (result.kind === "replay") {
      expect(result.record.operationId).toBe("op_1");
    }
  });

  it("returns 'conflict' for same ID but different request", () => {
    coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    const result = coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    expect(result.kind).toBe("replay");

    const conflict = coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "x402_solana" }, "ord_1");
    expect(conflict.kind).toBe("conflict");
    if (conflict.kind === "conflict") {
      expect(conflict.existing.requestHash).toHaveLength(64);
      expect(conflict.requestHash).toHaveLength(64);
      expect(conflict.existing.requestHash).not.toBe(conflict.requestHash);
    }
  });

  it("tracks phase transitions", () => {
    coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    coordinator.transition("op_1", "in_progress");
    const record = coordinator.lookup("op_1");
    expect(record?.phase).toBe("in_progress");

    coordinator.complete("op_1", "success", "evt_123");
    const completed = coordinator.lookup("op_1");
    expect(completed?.phase).toBe("completed");
    expect(completed?.outcome).toBe("success");
    expect(completed?.resultRef).toBe("evt_123");
  });

  it("records failure outcome", () => {
    coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    coordinator.complete("op_1", "failure", undefined, "Payment gateway timeout");
    const record = coordinator.lookup("op_1");
    expect(record?.phase).toBe("failed");
    expect(record?.outcome).toBe("failure");
    expect(record?.errorRef).toBe("Payment gateway timeout");
  });

  it("records rejected outcome", () => {
    coordinator.begin("op_1", "approval.grant", { orderId: "ord_1", digest: "abc" }, "ord_1");
    coordinator.complete("op_1", "rejected", undefined, "Policy blocked");
    const record = coordinator.lookup("op_1");
    expect(record?.phase).toBe("rejected");
    expect(record?.outcome).toBe("rejected");
  });

  it("lookup returns undefined for unknown ID", () => {
    expect(coordinator.lookup("nonexistent")).toBeUndefined();
  });

  it("clear resets the store", () => {
    coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    coordinator.clear();
    expect(coordinator.lookup("op_1")).toBeUndefined();
  });

  it("throws on transition for unknown operation", () => {
    expect(() => coordinator.transition("nonexistent", "in_progress")).toThrow("not found");
  });

  it("throws on complete for unknown operation", () => {
    expect(() => coordinator.complete("nonexistent", "success")).toThrow("not found");
  });
});

describe("resultPayload storage and replay", () => {
  it("stores and replays typed result for session.create", () => {
    const { coordinator } = makeCoordinator();
    const session = { logicalOrderId: "ord_1", customerId: "cust_1", state: "DRAFT" };
    coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    coordinator.complete("op_1", "success", "ord_1", undefined, session);

    const replay = coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.resultPayload).toEqual(session);
    }
  });

  it("stores and replays typed result for conversation.respond", () => {
    const { coordinator } = makeCoordinator();
    const result = { kind: "shortlist" as const, message: "Here are matches", matches: [], state: "QUOTED" as const, intentVersion: 1, recommendationVersion: 1, recommendationActionToken: "tok" };
    coordinator.begin("op_1", "conversation.respond", { orderId: "ord_1", message: "black shoes", intentVersion: 1, recommendationVersion: 1, recommendationActionToken: "tok" }, "ord_1");
    coordinator.complete("op_1", "success", "QUOTED", undefined, result);

    const replay = coordinator.begin("op_1", "conversation.respond", { orderId: "ord_1", message: "black shoes", intentVersion: 1, recommendationVersion: 1, recommendationActionToken: "tok" }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.resultPayload).toEqual(result);
    }
  });

  it("stores and replays typed result for payment.initiate", () => {
    const { coordinator } = makeCoordinator();
    const result = { ok: true, attempt: { attemptId: "att_1", externalOrderId: "rzp_1" }, state: "PAYMENT_PENDING" };
    coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    coordinator.complete("op_1", "success", "rzp_1", undefined, result);

    const replay = coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.resultPayload).toEqual(result);
    }
  });

  it("stores and replays typed failure result", () => {
    const { coordinator } = makeCoordinator();
    const result = { ok: false, state: "PAYMENT_FAILED", error: "Gateway timeout" };
    coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    coordinator.complete("op_1", "failure", undefined, "Gateway timeout", result);

    const replay = coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.resultPayload).toEqual(result);
      expect(replay.record.outcome).toBe("failure");
    }
  });
});

describe("EncryptedOperationStore", () => {
  it("round-trips records through encryption", () => {
    const store = new EncryptedOperationStore("test-secret-key-for-encryption");
    const coordinator = createOperationCoordinator(store);

    coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    coordinator.transition("op_1", "in_progress");
    coordinator.complete("op_1", "success", "evt_123");

    const record = coordinator.lookup("op_1");
    expect(record).toBeDefined();
    expect(record?.operationId).toBe("op_1");
    expect(record?.phase).toBe("completed");
    expect(record?.outcome).toBe("success");
    expect(record?.resultRef).toBe("evt_123");
  });

  it("data is not stored as plaintext", () => {
    const store = new EncryptedOperationStore("test-secret-key-for-encryption");
    const internals = store as unknown as { data: Map<string, string> };
    const coordinator = createOperationCoordinator(store);
    coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");

    const raw = internals.data.get("op_1")!;
    expect(raw).not.toContain("cust_1");
    expect(raw).not.toContain("session.create");
  });
});

describe("process-local store initialization", () => {
  it("initializes a fresh store and supports full lifecycle", () => {
    const store = new MemoryOperationStore();
    const coordinator = createOperationCoordinator(store);

    expect(store.size()).toBe(0);

    coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(store.size()).toBe(1);

    coordinator.begin("op_2", "quote.build", { orderId: "ord_1", productId: "p_1" }, "ord_1");
    expect(store.size()).toBe(2);

    coordinator.begin("op_3", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    expect(store.size()).toBe(3);
  });

  it("same coordinator instance provides process-local idempotency", () => {
    const { coordinator } = makeCoordinator();
    coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    coordinator.complete("op_1", "success", "ord_1");

    const replay = coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(replay.kind).toBe("replay");
  });

  it("new coordinator backed by same store sees existing records", () => {
    const store = new MemoryOperationStore();
    const c1 = createOperationCoordinator(store);
    c1.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    c1.complete("op_1", "success", "ord_1");

    const c2 = createOperationCoordinator(store);
    const replay = c2.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(replay.kind).toBe("replay");
  });

  it("new coordinator backed by different store does NOT see existing records (no restart survival)", () => {
    const { coordinator: c1 } = makeCoordinator();
    c1.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    c1.complete("op_1", "success", "ord_1");

    const { coordinator: c2 } = makeCoordinator();
    const result = c2.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(result.kind).toBe("new");
  });
});

describe("P0 idempotency scenarios", () => {
  it("same ID and same request returns existing result with payload", () => {
    const { coordinator } = makeCoordinator();
    const payload = { ok: true, state: "PAYMENT_PENDING", attempt: { id: "att_1" } };
    coordinator.begin("op_retry", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    coordinator.transition("op_retry", "in_progress");
    coordinator.complete("op_retry", "success", "pay_123", undefined, payload);

    const replay = coordinator.begin("op_retry", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.phase).toBe("completed");
      expect(replay.record.outcome).toBe("success");
      expect(replay.record.resultRef).toBe("pay_123");
      expect(replay.record.resultPayload).toEqual(payload);
    }
  });

  it("same ID and different request fails with conflict before any effect", () => {
    const { coordinator } = makeCoordinator();
    coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");

    const conflict = coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "x402_solana" }, "ord_1");
    expect(conflict.kind).toBe("conflict");
  });

  it("conversation.respond: same ID + same message + same binding returns replay", () => {
    const { coordinator } = makeCoordinator();
    const result = { kind: "shortlist" as const, message: "matches", matches: [], state: "QUOTED" as const, intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok" };
    coordinator.begin("op_1", "conversation.respond", { orderId: "ord_1", message: "black shoes", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok" }, "ord_1");
    coordinator.complete("op_1", "success", "QUOTED", undefined, result);

    const replay = coordinator.begin("op_1", "conversation.respond", { orderId: "ord_1", message: "black shoes", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok" }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.resultPayload).toEqual(result);
    }
  });

  it("conversation.respond: same ID + different message produces conflict", () => {
    const { coordinator } = makeCoordinator();
    coordinator.begin("op_1", "conversation.respond", { orderId: "ord_1", message: "black shoes", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok" }, "ord_1");

    const conflict = coordinator.begin("op_1", "conversation.respond", { orderId: "ord_1", message: "red shoes", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok" }, "ord_1");
    expect(conflict.kind).toBe("conflict");
  });

  it("conversation.respond: same ID + different binding produces conflict", () => {
    const { coordinator } = makeCoordinator();
    coordinator.begin("op_1", "conversation.respond", { orderId: "ord_1", message: "black shoes", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok_a" }, "ord_1");

    const conflict = coordinator.begin("op_1", "conversation.respond", { orderId: "ord_1", message: "black shoes", intentVersion: 1, recommendationVersion: 2, recommendationActionToken: "tok_b" }, "ord_1");
    expect(conflict.kind).toBe("conflict");
  });

  it("response loss followed by retry returns pending state", () => {
    const { coordinator } = makeCoordinator();
    const first = coordinator.begin("op_lost", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(first.kind).toBe("new");
    if (first.kind === "new") {
      expect(first.record.phase).toBe("pending");
    }

    const retry = coordinator.begin("op_lost", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(retry.kind).toBe("replay");
    if (retry.kind === "replay") {
      expect(retry.record.phase).toBe("pending");
    }
  });

  it("concurrent duplicate submission: first is new, rest are replays", () => {
    const { coordinator } = makeCoordinator();
    const results = [
      coordinator.begin("op_concurrent", "session.create", { customerId: "cust_1" }, "ord_1"),
      coordinator.begin("op_concurrent", "session.create", { customerId: "cust_1" }, "ord_1"),
      coordinator.begin("op_concurrent", "session.create", { customerId: "cust_1" }, "ord_1"),
    ];

    expect(results[0]!.kind).toBe("new");
    expect(results[1]!.kind).toBe("replay");
    expect(results[2]!.kind).toBe("replay");
  });

  it("concurrent duplicates of same operation produce only one effect", () => {
    const { coordinator } = makeCoordinator();
    let effectCount = 0;
    const results = [
      coordinator.begin("op_effect", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1"),
      coordinator.begin("op_effect", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1"),
      coordinator.begin("op_effect", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1"),
    ];

    for (const r of results) {
      if (r.kind === "new") effectCount += 1;
    }
    expect(effectCount).toBe(1);
  });

  it("pending in-progress operation returns replay with in_progress phase", () => {
    const { coordinator } = makeCoordinator();
    coordinator.begin("op_inprogress", "session.create", { customerId: "cust_1" }, "ord_1");
    coordinator.transition("op_inprogress", "in_progress");

    const replay = coordinator.begin("op_inprogress", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.phase).toBe("in_progress");
    }
  });

  it("completed-result replay returns the stored payload (not a re-execution)", () => {
    const { coordinator } = makeCoordinator();
    const payload = { ok: true, state: "FULFILLED" };
    coordinator.begin("op_done", "fulfilment.complete", { orderId: "ord_1", fail: false }, "ord_1");
    coordinator.transition("op_done", "in_progress");
    coordinator.complete("op_done", "success", "ful_123", undefined, payload);

    const replay = coordinator.begin("op_done", "fulfilment.complete", { orderId: "ord_1", fail: false }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.phase).toBe("completed");
      expect(replay.record.outcome).toBe("success");
      expect(replay.record.resultRef).toBe("ful_123");
      expect(replay.record.resultPayload).toEqual(payload);
    }
  });

  it("failed outcome replay returns the stored failure payload", () => {
    const { coordinator } = makeCoordinator();
    const failPayload = { ok: false, state: "PAYMENT_FAILED", error: "Gateway timeout" };
    coordinator.begin("op_fail", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    coordinator.complete("op_fail", "failure", undefined, "Gateway timeout", failPayload);

    const replay = coordinator.begin("op_fail", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.phase).toBe("failed");
      expect(replay.record.outcome).toBe("failure");
      expect(replay.record.resultPayload).toEqual(failPayload);
    }
  });

  it("rejected outcome replay returns the stored rejection payload", () => {
    const { coordinator } = makeCoordinator();
    const rejectPayload = { ok: false, state: "APPROVED", error: "Policy blocked" };
    coordinator.begin("op_rej", "approval.grant", { orderId: "ord_1", digest: "abc" }, "ord_1");
    coordinator.complete("op_rej", "rejected", undefined, "Policy blocked", rejectPayload);

    const replay = coordinator.begin("op_rej", "approval.grant", { orderId: "ord_1", digest: "abc" }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.phase).toBe("rejected");
      expect(replay.record.outcome).toBe("rejected");
      expect(replay.record.resultPayload).toEqual(rejectPayload);
    }
  });

  it("no duplicate authoritative events or runtime effects on replay", () => {
    const { coordinator } = makeCoordinator();
    let effectCount = 0;

    function executeWithIdempotency(operationId: string) {
      const result = coordinator.begin(operationId, "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
      if (result.kind === "new") {
        effectCount += 1;
        coordinator.transition(operationId, "in_progress");
        coordinator.complete(operationId, "success", "pay_new", undefined, { ok: true });
      }
      return result;
    }

    const first = executeWithIdempotency("op_idempotent");
    expect(first.kind).toBe("new");
    expect(effectCount).toBe(1);

    const second = executeWithIdempotency("op_idempotent");
    expect(second.kind).toBe("replay");
    expect(effectCount).toBe(1);

    const third = executeWithIdempotency("op_idempotent");
    expect(third.kind).toBe("replay");
    expect(effectCount).toBe(1);
  });

  it("different operation IDs are independent", () => {
    const { coordinator } = makeCoordinator();
    const r1 = coordinator.begin("op_a", "session.create", { customerId: "cust_1" }, "ord_1");
    const r2 = coordinator.begin("op_b", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(r1.kind).toBe("new");
    expect(r2.kind).toBe("new");
  });

  it("records aggregate identity and operation type", () => {
    const { coordinator } = makeCoordinator();
    coordinator.begin("op_meta", "compensation.refund", { orderId: "ord_1" }, "ord_1");
    const record = coordinator.lookup("op_meta");
    expect(record?.aggregateIdentity).toBe("ord_1");
    expect(record?.operationType).toBe("compensation.refund");
  });

  it("tracks timestamps through lifecycle", () => {
    const { coordinator } = makeCoordinator();
    coordinator.begin("op_time", "session.create", { customerId: "cust_1" }, "ord_1");
    const before = coordinator.lookup("op_time")!.createdAt;

    coordinator.transition("op_time", "in_progress");
    coordinator.complete("op_time", "success");
    const after = coordinator.lookup("op_time")!.updatedAt;

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after >= before).toBe(true);
  });
});

describe("all operation types", () => {
  it("supports session.create", () => {
    const { coordinator } = makeCoordinator();
    const r = coordinator.begin("op_sc", "session.create", { customerId: "c1" }, "ord_1");
    expect(r.kind).toBe("new");
  });

  it("supports conversation.respond", () => {
    const { coordinator } = makeCoordinator();
    const r = coordinator.begin("op_cr", "conversation.respond", { orderId: "ord_1", message: "hello", intentVersion: 1, recommendationVersion: 1, recommendationActionToken: "tok" }, "ord_1");
    expect(r.kind).toBe("new");
  });

  it("supports quote.build", () => {
    const { coordinator } = makeCoordinator();
    const r = coordinator.begin("op_qb", "quote.build", { orderId: "ord_1", productId: "p1" }, "ord_1");
    expect(r.kind).toBe("new");
  });

  it("supports approval.grant", () => {
    const { coordinator } = makeCoordinator();
    const r = coordinator.begin("op_ag", "approval.grant", { orderId: "ord_1", digest: "abc123" }, "ord_1");
    expect(r.kind).toBe("new");
  });

  it("supports payment.initiate", () => {
    const { coordinator } = makeCoordinator();
    const r = coordinator.begin("op_pi", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    expect(r.kind).toBe("new");
  });

  it("supports payment.verify", () => {
    const { coordinator } = makeCoordinator();
    const r = coordinator.begin("op_pv", "payment.verify", { orderId: "ord_1", externalOrderId: "eo1", externalPaymentId: "ep1" }, "ord_1");
    expect(r.kind).toBe("new");
  });

  it("supports fulfilment.complete", () => {
    const { coordinator } = makeCoordinator();
    const r = coordinator.begin("op_fc", "fulfilment.complete", { orderId: "ord_1", fail: false }, "ord_1");
    expect(r.kind).toBe("new");
  });

  it("supports compensation.refund", () => {
    const { coordinator } = makeCoordinator();
    const r = coordinator.begin("op_cr2", "compensation.refund", { orderId: "ord_1" }, "ord_1");
    expect(r.kind).toBe("new");
  });
});

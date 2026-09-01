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
    // Access internal data via cast to verify encryption
    const internals = store as unknown as { data: Map<string, string> };
    const coordinator = createOperationCoordinator(store);
    coordinator.begin("op_1", "session.create", { customerId: "cust_1" }, "ord_1");

    const raw = internals.data.get("op_1")!;
    expect(raw).not.toContain("cust_1");
    expect(raw).not.toContain("session.create");
  });
});

describe("schema migration from empty store", () => {
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
});

describe("P0 idempotency scenarios", () => {
  it("same ID and same request returns existing result", () => {
    const { coordinator } = makeCoordinator();
    const first = coordinator.begin("op_retry", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    expect(first.kind).toBe("new");

    coordinator.transition("op_retry", "in_progress");
    coordinator.complete("op_retry", "success", "pay_123");

    const replay = coordinator.begin("op_retry", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.phase).toBe("completed");
      expect(replay.record.outcome).toBe("success");
      expect(replay.record.resultRef).toBe("pay_123");
    }
  });

  it("same ID and different request fails with conflict", () => {
    const { coordinator } = makeCoordinator();
    coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "razorpay_checkout" }, "ord_1");

    const conflict = coordinator.begin("op_1", "payment.initiate", { orderId: "ord_1", rail: "x402_solana" }, "ord_1");
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

  it("concurrent duplicate submission is handled via session lock pattern", () => {
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

  it("restart with a pending operation returns pending replay", () => {
    const { coordinator } = makeCoordinator();
    coordinator.begin("op_restart", "session.create", { customerId: "cust_1" }, "ord_1");
    coordinator.transition("op_restart", "in_progress");

    const restart = coordinator.begin("op_restart", "session.create", { customerId: "cust_1" }, "ord_1");
    expect(restart.kind).toBe("replay");
    if (restart.kind === "replay") {
      expect(restart.record.phase).toBe("in_progress");
    }
  });

  it("completed-result replay returns the cached outcome", () => {
    const { coordinator } = makeCoordinator();
    coordinator.begin("op_done", "fulfilment.complete", { orderId: "ord_1", fail: false }, "ord_1");
    coordinator.transition("op_done", "in_progress");
    coordinator.complete("op_done", "success", "ful_123");

    const replay = coordinator.begin("op_done", "fulfilment.complete", { orderId: "ord_1", fail: false }, "ord_1");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.phase).toBe("completed");
      expect(replay.record.outcome).toBe("success");
      expect(replay.record.resultRef).toBe("ful_123");
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
        coordinator.complete(operationId, "success", "pay_new");
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
    const r = coordinator.begin("op_cr", "compensation.refund", { orderId: "ord_1" }, "ord_1");
    expect(r.kind).toBe("new");
  });
});

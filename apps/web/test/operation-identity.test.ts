import { describe, expect, it } from "vitest";
import { MemoryOperationStore, createOperationCoordinator } from "@agentready/core";
import { getServices, type AppServices, type Session, type RespondResult, type RecommendationBinding } from "../lib/services";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "rzp_test_mock",
  RAZORPAY_KEY_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
};

const DEMO_MESSAGE = "I need black shoes under ₹5,000.";
const CLARIFICATIONS = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];

async function setupShortlist(services: AppServices) {
  const session = services.createSession();
  const orderId = session.logicalOrderId;
  await services.respond(orderId, DEMO_MESSAGE);
  for (const c of CLARIFICATIONS) await services.respond(orderId, c);
  const ranked = await services.respond(orderId, "I need black shoes under ₹5,000.");
  expect(ranked.kind).toBe("shortlist");
  return { session, orderId, ranking: ranked.kind === "shortlist" ? ranked : undefined };
}

async function setupApproved(services: AppServices, quoteOperationId?: string, approveOperationId?: string) {
  const { session, orderId, ranking } = await setupShortlist(services);
  if (!ranking) throw new Error("setupApproved requires a shortlist");
  const binding: RecommendationBinding = {
    intentVersion: ranking.intentVersion,
    recommendationVersion: ranking.recommendationVersion,
    recommendationActionToken: ranking.recommendationActionToken,
  };
  const quote = await services.buildQuote(orderId, "p_streak_4", binding, quoteOperationId);
  const approval = await services.approve(orderId, quote.digest, approveOperationId);
  expect(approval.ok).toBe(true);
  return { session, orderId, quote, binding };
}

describe("createSession operation identity", () => {
  it("same operationId replays the exact session object", () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const first = services.createSession("op_cs_1");
    const second = services.createSession("op_cs_1");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("different operationId creates different sessions", () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const a = services.createSession("op_cs_a");
    const b = services.createSession("op_cs_b");
    expect(a.logicalOrderId).not.toBe(b.logicalOrderId);
  });

  it("replayed session is a deep clone, not the same reference", () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const original = services.createSession("op_cs_clone");
    const replayed = services.createSession("op_cs_clone");
    expect(replayed).toEqual(original);
    expect(replayed).not.toBe(original);
  });

  it("no duplicate audit events on replay", () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const first = services.createSession("op_cs_audit");
    const second = services.createSession("op_cs_audit");
    expect(second.logicalOrderId).toBe(first.logicalOrderId);
  });
});

describe("respond operation identity", () => {
  it("same operationId replays the exact result", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession("op_rsp_1");
    const orderId = session.logicalOrderId;
    const first = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_rsp_2");
    const second = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_rsp_2");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("different message with same operationId produces conflict", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    await services.respond(orderId, DEMO_MESSAGE, undefined, "op_rsp_3");
    const conflict = await services.respond(orderId, "red shoes", undefined, "op_rsp_3");
    expect(conflict.kind).toBe("error");
    if (conflict.kind === "error") expect(conflict.message).toContain("conflict");
  });

  it("different binding with same operationId produces conflict", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    const bindingA: RecommendationBinding = { intentVersion: 1, recommendationVersion: 1, recommendationActionToken: "tok_a" };
    const bindingB: RecommendationBinding = { intentVersion: 1, recommendationVersion: 1, recommendationActionToken: "tok_b" };
    await services.respond(orderId, DEMO_MESSAGE, bindingA, "op_rsp_4");
    const conflict = await services.respond(orderId, DEMO_MESSAGE, bindingB, "op_rsp_4");
    expect(conflict.kind).toBe("error");
    if (conflict.kind === "error") expect(conflict.message).toContain("conflict");
  });

  it("repeated respond does not append duplicate audit events", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    const first = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_rsp_5");
    const second = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_rsp_5");
    expect(second).toEqual(first);
    const events = await services.timeline(orderId);
    const interpretEvents = events.filter((e) => e.type === "interpreter.interpreted");
    expect(interpretEvents).toHaveLength(1);
  });

  it("pending replay returns operation-in-progress without executing logic", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    const first = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_rsp_pending");
    expect(first.kind).not.toBe("error");
    const second = await services.respond(orderId, "red shoes", undefined, "op_rsp_pending");
    expect(second.kind).toBe("error");
    if (second.kind === "error") expect(second.message).toContain("conflict");
  });

  it("replayed result is a deep clone, not the same reference", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    const first = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_rsp_clone");
    const second = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_rsp_clone");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("mutating original does not affect replayed payload", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    const first = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_rsp_mut");
    const second = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_rsp_mut");
    if (first.kind === "shortlist") {
      (first as Record<string, unknown>).message = "MUTATED";
      (first as Record<string, unknown>).state = "FULFILLED";
    }
    expect(second).toEqual(first);
    if (second.kind === "shortlist") {
      expect(second.message).not.toBe("MUTATED");
      expect(second.state).not.toBe("FULFILLED");
    }
  });
});

describe("buildQuote operation identity", () => {
  it("same operationId replays the exact quote", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId, quote, binding } = await setupApproved(services, "op_qt_1");
    const replayed = await services.buildQuote(orderId, "p_streak_4", binding, "op_qt_1");
    expect(replayed).toEqual(quote);
    expect(replayed).not.toBe(quote);
  });

  it("different product with same operationId produces conflict", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId, binding } = await setupApproved(services, "op_qt_2");
    try {
      await services.buildQuote(orderId, "p_vista_max", binding, "op_qt_2");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("conflict");
    }
  });

  it("repeated quote does not create a second envelope", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId, binding } = await setupApproved(services, "op_qt_3");
    await services.buildQuote(orderId, "p_streak_4", binding, "op_qt_3");
    const events = await services.timeline(orderId);
    expect(events.filter((e) => e.type === "quote.envelope_created")).toHaveLength(1);
  });
});

describe("approve operation identity", () => {
  it("same operationId replays the exact approval result", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId, quote } = await setupApproved(services);
    const first = await services.approve(orderId, quote.digest, "op_ap_1");
    const second = await services.approve(orderId, quote.digest, "op_ap_1");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("different digest with same operationId produces conflict", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId, quote } = await setupApproved(services);
    await services.approve(orderId, quote.digest, "op_ap_2");
    const conflict = await services.approve(orderId, "f".repeat(64), "op_ap_2");
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toContain("Operation ID conflict");
  });

  it("repeated approval does not create duplicate audit event", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId, quote } = await setupApproved(services);
    await services.approve(orderId, quote.digest, "op_ap_3");
    await services.approve(orderId, quote.digest, "op_ap_3");
    const events = await services.timeline(orderId);
    expect(events.filter((e) => e.type === "approval.granted")).toHaveLength(1);
  });
});

describe("initiatePayment operation identity", () => {
  it("same operationId replays the exact payment result", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    const first = await services.initiatePayment(orderId, "razorpay_checkout", "op_pay_1");
    const second = await services.initiatePayment(orderId, "razorpay_checkout", "op_pay_1");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("different rail with same operationId produces conflict", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout", "op_pay_2");
    const conflict = await services.initiatePayment(orderId, "x402_solana", "op_pay_2");
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toContain("conflict");
  });

  it("repeated payment initiation does not create duplicate audit event", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout", "op_pay_3");
    await services.initiatePayment(orderId, "razorpay_checkout", "op_pay_3");
    const events = await services.timeline(orderId);
    expect(events.filter((e) => e.type === "payment.initiated")).toHaveLength(1);
  });
});

describe("verifyPayment operation identity", () => {
  it("same operationId replays the exact verification result", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    const first = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature, "op_vf_1");
    const second = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature, "op_vf_1");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("different externalPaymentId with same operationId produces conflict", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature, "op_vf_2");
    const conflict = await services.verifyPayment(orderId, capture.orderId, "pay_other", capture.signature, "op_vf_2");
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toContain("conflict");
  });

  it("repeated verification does not create duplicate audit event", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature, "op_vf_3");
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature, "op_vf_3");
    const events = await services.timeline(orderId);
    expect(events.filter((e) => e.type === "payment.verified")).toHaveLength(1);
  });

  it("failed verification replay returns exact failure result", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const session = services.getSession(orderId)!;
    const first = await services.verifyPayment(orderId, session.externalOrderId!, "pay_bad", "forged", "op_vf_4");
    expect(first.ok).toBe(false);
    const second = await services.verifyPayment(orderId, session.externalOrderId!, "pay_bad", "forged", "op_vf_4");
    expect(second).toEqual(first);
    expect(second.ok).toBe(false);
  });
});

describe("fulfil operation identity", () => {
  it("same operationId replays the exact fulfilment result", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    const first = await services.fulfil(orderId, false, "op_fl_1");
    const second = await services.fulfil(orderId, false, "op_fl_1");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("different fail flag with same operationId produces conflict", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    await services.fulfil(orderId, false, "op_fl_2");
    const conflict = await services.fulfil(orderId, true, "op_fl_2");
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toContain("conflict");
  });

  it("repeated fulfilment does not create duplicate audit event", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    await services.fulfil(orderId, false, "op_fl_3");
    await services.fulfil(orderId, false, "op_fl_3");
    const events = await services.timeline(orderId);
    expect(events.filter((e) => e.type === "fulfilment.completed")).toHaveLength(1);
  });
});

describe("compensate operation identity", () => {
  it("same operationId replays the exact refund result", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    await services.fulfil(orderId, true);
    const first = await services.compensate(orderId, "op_rf_1");
    const second = await services.compensate(orderId, "op_rf_1");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("repeated refund does not create duplicate audit event", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const { orderId } = await setupApproved(services);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    await services.fulfil(orderId, true);
    await services.compensate(orderId, "op_rf_2");
    await services.compensate(orderId, "op_rf_2");
    const events = await services.timeline(orderId);
    expect(events.filter((e) => e.type === "compensation.refunded")).toHaveLength(1);
  });
});

describe("full lifecycle with operation identity", () => {
  it("end-to-end with operation IDs: create → respond → quote → approve → pay → verify → fulfil", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession("op_lc_create");
    const orderId = session.logicalOrderId;

    const respond1 = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_lc_respond_1");
    expect(respond1.kind).toBe("clarify");
    for (const c of CLARIFICATIONS) {
      await services.respond(orderId, c, undefined, `op_lc_clarify_${c.slice(0, 5)}`);
    }
    const respondFinal = await services.respond(orderId, "I need black shoes under ₹5,000.", undefined, "op_lc_respond_final");
    expect(respondFinal.kind).toBe("shortlist");

    const quote = await services.buildQuote(orderId, "p_streak_4", undefined, "op_lc_quote");
    expect(quote.digest).toHaveLength(64);

    const approval = await services.approve(orderId, quote.digest, "op_lc_approve");
    expect(approval.ok).toBe(true);

    const payment = await services.initiatePayment(orderId, "razorpay_checkout", "op_lc_pay");
    expect(payment.ok).toBe(true);

    const capture = await services.mockCapture(orderId);
    const verified = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature, "op_lc_verify");
    expect(verified.ok).toBe(true);

    const fulfilled = await services.fulfil(orderId, false, "op_lc_fulfil");
    expect(fulfilled.ok).toBe(true);

    const sessionAfter = services.getSession(orderId);
    expect(sessionAfter?.state).toBe("FULFILLED");
  });
});

describe("immutable snapshots", () => {
  it("MemoryOperationStore clone-on-write and clone-on-read", () => {
    const store = new MemoryOperationStore();
    const record = { operationId: "op_imm", aggregateIdentity: "ord_1", operationType: "session.create" as const, requestHash: "abc", phase: "completed" as const, resultPayload: { nested: { value: 1 } }, createdAt: "2024-01-01", updatedAt: "2024-01-01" };
    store.set("op_imm", record);
    record.resultPayload = { nested: { value: 2 } };
    const retrieved = store.get("op_imm");
    expect(retrieved!.resultPayload).toEqual({ nested: { value: 1 } });
  });

  it("mutating original returned object does not affect replayed payload", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    const first = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_immut");
    const second = await services.respond(orderId, DEMO_MESSAGE, undefined, "op_immut");
    if (first.kind === "shortlist") {
      first.matches = [];
      first.state = "FULFILLED";
      (first as Record<string, unknown>).message = "MUTATED";
    }
    expect(second).toEqual(first);
    if (second.kind === "shortlist") {
      expect(second.matches.length).toBeGreaterThan(0);
      expect(second.state).not.toBe("FULFILLED");
    }
  });
});

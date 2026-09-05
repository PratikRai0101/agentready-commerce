import { describe, expect, it } from "vitest";
import { openSnapshot } from "../lib/session-token";
import { getServices } from "../lib/services";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "",
  RAZORPAY_KEY_SECRET: "",
  RAZORPAY_WEBHOOK_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
  X402_MODE: "mock",
  X402_SETTLEMENT_ENABLED: "false",
};

const DEMO_MESSAGE = "I need black shoes under ₹5,000.";
const CLARIFICATIONS = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];

function freshServices() {
  return getServices(env, { forceMock: true, skipCache: true });
}

async function runToApproved(services: ReturnType<typeof getServices>) {
  const session = services.createSession();
  const orderId = session.logicalOrderId;
  await services.respond(orderId, DEMO_MESSAGE);
  let shortlist: Extract<Awaited<ReturnType<typeof services.respond>>, { kind: "shortlist" }> | undefined;
  for (const clarification of CLARIFICATIONS) {
    const result = await services.respond(orderId, clarification);
    if (result.kind === "shortlist") shortlist = result;
  }
  if (!shortlist) throw new Error("no shortlist");
  const binding = {
    intentVersion: shortlist.intentVersion,
    recommendationVersion: shortlist.recommendationVersion,
    recommendationActionToken: shortlist.recommendationActionToken,
  };
  const selected = await services.respond(orderId, "Select Streak 4.", binding);
  if (selected.kind !== "select") throw new Error("no selection");
  const quote = await services.buildQuote(orderId, "p_streak_4", {
    intentVersion: selected.intentVersion,
    recommendationVersion: selected.recommendationVersion,
    recommendationActionToken: selected.recommendationActionToken,
  });
  const approved = await services.approve(orderId, quote.digest);
  if (!approved.ok) throw new Error("not approved");
  return { orderId, quote };
}

describe("stateless session handoff", () => {
  it("continues an approved order on a fresh instance with the same digest", async () => {
    const a = freshServices();
    const { orderId, quote } = await runToApproved(a);
    const token = await a.exportSession(orderId);
    expect(typeof token).toBe("string");

    const b = freshServices();
    expect(b.getSession(orderId)).toBeUndefined();
    const imported = await b.importSession(token!);
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    expect(imported.orderId).toBe(orderId);
    expect(b.getEnvelope(orderId)?.digest).toBe(quote.digest);

    const initiated = await b.initiatePayment(orderId, "razorpay_checkout");
    expect(initiated.ok).toBe(true);
    expect(initiated.attempt?.externalOrderId).toMatch(/^order_MOCK_/);
  });

  it("preserves audit history without duplicating on double import", async () => {
    const a = freshServices();
    const { orderId } = await runToApproved(a);
    const token = (await a.exportSession(orderId))!;
    const before = await a.timeline(orderId);

    const b = freshServices();
    await b.importSession(token);
    await b.importSession(token);
    const after = await b.timeline(orderId);
    expect(after.map((e) => e.type)).toEqual(before.map((e) => e.type));
    const ids = after.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects tampered, foreign-secret and expired tokens", async () => {
    const a = freshServices();
    const { orderId } = await runToApproved(a);
    const token = (await a.exportSession(orderId))!;
    const [payload, sig] = token.split(".");

    const b = freshServices();
    const flipped = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${sig}`;
    expect((await b.importSession(flipped)).ok).toBe(false);
    expect((await b.importSession("not-a-token")).ok).toBe(false);

    expect(openSnapshot(token, "wrong-secret")).toBeNull();
    expect(openSnapshot(token, "test-secret")).not.toBeNull();
    // A day past issue the snapshot must read as expired
    const pastExpiry = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    expect(openSnapshot(token, "test-secret", pastExpiry)).toBeNull();
  });

  it("stays compact enough for header transport after a full mock flow", async () => {
    const a = freshServices();
    const { orderId } = await runToApproved(a);
    await a.initiatePayment(orderId, "razorpay_checkout");
    const captured = await a.mockCapture(orderId);
    await a.verifyPayment(orderId, captured.orderId, captured.paymentId, captured.signature);
    const token = (await a.exportSession(orderId))!;
    expect(token.length).toBeLessThan(24 * 1024);
  });
});

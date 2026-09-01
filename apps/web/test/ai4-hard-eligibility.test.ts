import { describe, expect, it } from "vitest";
import { getServices, type AppServices, type RecommendationBinding, type RespondResult } from "../lib/services";
import type { LlmProvider } from "../lib/llm";
import { intentDigest } from "../lib/intent";
import { GET as scenario } from "../app/api/scenario/route";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "rzp_test_mock",
  RAZORPAY_KEY_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
};

const DISABLED_LLM: LlmProvider = {
  name: "none",
  enabled: false,
  extractSoftPreferences: async () => null,
  explainRecommendation: async () => null,
  interpret: async () => ({ ok: false as const, reason: "disabled" as const }),
};

function binding(result: RespondResult): RecommendationBinding {
  const intentVersion = "intentVersion" in result ? result.intentVersion : undefined;
  const recommendationVersion = "recommendationVersion" in result ? result.recommendationVersion : undefined;
  const recommendationActionToken = "recommendationActionToken" in result ? result.recommendationActionToken : undefined;
  if (typeof intentVersion !== "number" || typeof recommendationVersion !== "number" || typeof recommendationActionToken !== "string") {
    throw new Error("expected a versioned recommendation result");
  }
  return {
    intentVersion,
    recommendationVersion,
    recommendationActionToken,
  };
}

async function prepareShortlist() {
  const services = getServices(env, { skipCache: true, llm: DISABLED_LLM });
  const session = services.createSession();
  await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000.");
  await services.respond(session.logicalOrderId, "UK 9");
  const result = await services.respond(session.logicalOrderId, "road running up to 10K");
  if (result.kind !== "shortlist") throw new Error("expected shortlist");
  return { services, session, result, binding: binding(result) };
}

async function changeBudgetTo3000(services: AppServices, orderId: string) {
  const result = await services.respond(orderId, "Change budget to ₹3,000.");
  if (result.kind !== "shortlist") throw new Error("expected refreshed shortlist");
  return result;
}

describe("AI-4 hard eligibility and stale selection", () => {
  it("product above the current budget cannot be selected", async () => {
    const { services, session, binding: oldBinding } = await prepareShortlist();
    const refreshed = await changeBudgetTo3000(services, session.logicalOrderId);
    const result = await services.respond(session.logicalOrderId, "Select Streak 4.", oldBinding);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected stale selection rejection");
    expect(result.message).toBe("RunVista Streak 4 no longer fits your ₹3,000 budget. I refreshed your options.");
    expect(result.matches?.map((match) => match.product.productId)).toEqual(refreshed.matches.map((match) => match.product.productId));
    expect(result.matches?.every((match) => match.product.priceMinor <= 300_000)).toBe(true);
    expect(session.dialogue.selectedProductId).toBeUndefined();
    expect(services.getEnvelope(session.logicalOrderId)).toBeUndefined();
  });

  it("a stale recommendation cannot prepare a quote", async () => {
    const { services, session, binding: oldBinding } = await prepareShortlist();
    await changeBudgetTo3000(services, session.logicalOrderId);

    await expect(services.buildQuote(session.logicalOrderId, "p_streak_4", oldBinding)).rejects.toThrow(
      "RunVista Streak 4 no longer fits your ₹3,000 budget",
    );
    expect(services.getEnvelope(session.logicalOrderId)).toBeUndefined();
    expect(session.dialogue.quoteValid).toBe(false);
  });

  it("a delayed Select from an earlier intent version is rejected", async () => {
    const { services, session, binding: oldBinding } = await prepareShortlist();
    const current = await services.respond(session.logicalOrderId, "wide fit");
    expect(current.kind).toBe("shortlist");

    const delayed = await services.respond(session.logicalOrderId, "Select Streak 4.", oldBinding);
    expect(delayed.kind).toBe("error");
    if (delayed.kind !== "error") throw new Error("expected delayed selection rejection");
    expect(delayed.selectionRejected).toBe(true);
    expect(delayed.message).toContain("older recommendation");
    expect(delayed.matches?.map((match) => match.product.productId)).toEqual(
      session.lastRanking?.matches.map((match) => match.product.productId),
    );
    expect(session.dialogue.selectedProductId).toBeUndefined();
  });

  it("ignores client-supplied price and eligibility", async () => {
    const { services, session, binding: currentBinding } = await prepareShortlist();
    const forged = {
      ...currentBinding,
      priceMinor: 1,
      eligibility: true,
      score: 100,
      role: "bestOverall",
    } as RecommendationBinding;
    const quote = await services.buildQuote(session.logicalOrderId, "p_streak_4", forged);

    expect(quote.envelope.items[0]?.unitAmountMinor).toBe(429_900);
    expect(quote.envelope.totalMinor).toBe(434_800);
  });

  it("a budget edit invalidates and removes the active quote", async () => {
    const { services, session } = await prepareShortlist();
    const quote = await services.buildQuote(session.logicalOrderId, "p_streak_4");
    const previousIntentVersion = session.dialogue.intentVersion;
    const previousRecommendationVersion = session.dialogue.recommendationVersion;

    const refreshed = await changeBudgetTo3000(services, session.logicalOrderId);

    expect(session.intent.maxAmountMinor).toBe(300_000);
    expect(session.dialogue.intentVersion).toBe(previousIntentVersion + 1);
    expect(session.dialogue.recommendationVersion).toBeGreaterThan(previousRecommendationVersion);
    expect(session.dialogue.quoteValid).toBe(false);
    expect(session.dialogue.selectedProductId).toBeUndefined();
    expect(session.state).toBe("QUOTED");
    expect(services.getEnvelope(session.logicalOrderId)).toBeUndefined();
    expect(refreshed.matches).toHaveLength(1);
    expect(refreshed.matches[0]?.product.productId).toBe("p_casual_day");
    expect(refreshed.matches.every((match) => match.product.priceMinor <= 300_000)).toBe(true);
    expect(quote.digest).not.toBe(session.dialogue.quoteActionToken);
  });

  it("an invalidated quote cannot be approved or paid", async () => {
    const { services, session } = await prepareShortlist();
    const quote = await services.buildQuote(session.logicalOrderId, "p_streak_4");
    await changeBudgetTo3000(services, session.logicalOrderId);

    const approval = await services.approve(session.logicalOrderId, quote.digest);
    const payment = await services.initiatePayment(session.logicalOrderId, "razorpay_checkout");

    expect(approval.ok).toBe(false);
    expect(payment.ok).toBe(false);
    expect(session.approvalEventId).toBeUndefined();
    expect(session.externalOrderId).toBeUndefined();
    expect(session.state).toBe("QUOTED");
    const events = await services.timeline(session.logicalOrderId);
    expect(events.some((event) => event.type === "approval.granted")).toBe(false);
    expect(events.some((event) => event.type === "payment.initiated")).toBe(false);
  });

  it("a 3000-to-3000 edit is a no-op", async () => {
    const { services, session } = await prepareShortlist();
    const refreshed = await changeBudgetTo3000(services, session.logicalOrderId);
    const replacement = refreshed.matches[0];
    if (!replacement) throw new Error("expected an eligible replacement");
    const replacementQuote = await services.buildQuote(
      session.logicalOrderId,
      replacement.product.productId,
      binding(refreshed),
    );
    const before = {
      intentVersion: session.dialogue.intentVersion,
      recommendationVersion: session.dialogue.recommendationVersion,
      recommendationActionToken: session.dialogue.recommendationActionToken,
      digest: replacementQuote.digest,
      rankingEvents: (await services.timeline(session.logicalOrderId)).filter((event) => event.type === "intent.shortlist_ranked").length,
    };

    const noOp = await services.respond(session.logicalOrderId, "Change budget to ₹3,000.");
    const afterEvents = await services.timeline(session.logicalOrderId);

    expect(noOp.kind).toBe("shortlist");
    expect(session.dialogue.intentVersion).toBe(before.intentVersion);
    expect(session.dialogue.recommendationVersion).toBe(before.recommendationVersion);
    expect(session.dialogue.recommendationActionToken).toBe(before.recommendationActionToken);
    expect(session.dialogue.quoteValid).toBe(true);
    expect(services.getEnvelope(session.logicalOrderId)?.digest).toBe(before.digest);
    expect(afterEvents.filter((event) => event.type === "intent.shortlist_ranked")).toHaveLength(before.rankingEvents);
  });

  it("an eligible product under ₹3,000 can be selected", async () => {
    const { services, session } = await prepareShortlist();
    const refreshed = await changeBudgetTo3000(services, session.logicalOrderId);
    const result = await services.respond(session.logicalOrderId, "Select RunVista Everyday.", binding(refreshed));

    expect(result.kind).toBe("select");
    if (result.kind !== "select") throw new Error("expected eligible selection");
    expect(result.productId).toBe("p_casual_day");
    expect(session.dialogue.selectedProductId).toBe("p_casual_day");
  });

  it("the new quote is bound to current intent, result, product, price and constraints", async () => {
    const { services, session } = await prepareShortlist();
    const refreshed = await changeBudgetTo3000(services, session.logicalOrderId);
    const selected = await services.respond(session.logicalOrderId, "Select RunVista Everyday.", binding(refreshed));
    if (selected.kind !== "select") throw new Error("expected eligible selection");
    const quote = await services.buildQuote(session.logicalOrderId, selected.productId, binding(selected));
    const record = services.getEnvelope(session.logicalOrderId);
    const variant = record?.envelope.items[0]?.variant;

    expect(quote.intentVersion).toBe(session.dialogue.intentVersion);
    expect(quote.recommendationVersion).toBe(session.dialogue.recommendationVersion);
    expect(quote.recommendationActionToken).toBe(session.dialogue.recommendationActionToken);
    expect(record?.intentDigest).toBe(intentDigest(session.intent));
    expect(record?.envelope.items[0]?.productId).toBe("p_casual_day");
    expect(record?.envelope.items[0]?.unitAmountMinor).toBe(299_900);
    expect(record?.envelope.items[0]?.sku).toBe("CASE-BLK-9");
    expect(variant).toEqual({ size: "UK 9", colour: "black" });
    expect(record?.envelope.totalMinor).toBe(304_800);
    expect(session.state).toBe("AWAITING_APPROVAL");
  });

  it("changing intent between Select and quote creation fails safely", async () => {
    const { services, session, binding: oldBinding } = await prepareShortlist();
    const selected = await services.respond(session.logicalOrderId, "Select Streak 4.", oldBinding);
    expect(selected.kind).toBe("select");
    await changeBudgetTo3000(services, session.logicalOrderId);

    await expect(services.buildQuote(session.logicalOrderId, "p_streak_4", binding(selected))).rejects.toThrow(
      "RunVista Streak 4 no longer fits your ₹3,000 budget",
    );
    expect(services.getEnvelope(session.logicalOrderId)).toBeUndefined();
    expect(session.dialogue.selectedProductId).toBeUndefined();
    expect(session.state).toBe("QUOTED");
  });

  it("has zero unauthorized approval, payment and refund actions", async () => {
    const { services, session } = await prepareShortlist();
    const quote = await services.buildQuote(session.logicalOrderId, "p_streak_4");
    const forgedDigest = `${quote.digest.slice(0, -1)}${quote.digest.endsWith("0") ? "1" : "0"}`;
    const approval = await services.approve(session.logicalOrderId, forgedDigest);
    const payment = await services.initiatePayment(session.logicalOrderId, "razorpay_checkout");
    const refund = await services.compensate(session.logicalOrderId);

    expect(approval.ok).toBe(false);
    expect(payment.ok).toBe(false);
    expect(refund.ok).toBe(false);
    expect(session.state).toBe("AWAITING_APPROVAL");
    const events = await services.timeline(session.logicalOrderId);
    expect(events.filter((event) => event.type === "approval.granted")).toHaveLength(0);
    expect(events.filter((event) => event.type === "payment.initiated")).toHaveLength(0);
    expect(events.filter((event) => event.type === "compensation.refunded")).toHaveLength(0);
  });

  it("serializes overlapping Select and budget-edit requests safely", async () => {
    const { services, session, binding: oldBinding } = await prepareShortlist();
    const [selection, edit] = await Promise.all([
      services.respond(session.logicalOrderId, "Select Streak 4.", oldBinding),
      services.respond(session.logicalOrderId, "Change budget to ₹3,000."),
    ]);

    expect(edit.kind).toBe("shortlist");
    expect(session.intent.maxAmountMinor).toBe(300_000);
    expect(session.lastRanking?.matches.every((match) => match.product.priceMinor <= 300_000)).toBe(true);
    expect(session.dialogue.selectedProductId).toBeUndefined();
    expect(services.getEnvelope(session.logicalOrderId)).toBeUndefined();
    expect(session.state).toBe("QUOTED");
    expect(["select", "error"]).toContain(selection.kind);
    const events = await services.timeline(session.logicalOrderId);
    expect(events.some((event) => event.type === "payment.initiated")).toBe(false);
    expect(events.some((event) => event.type === "approval.granted")).toBe(false);
  });

  it("generates the corrected acceptance transcript through real handlers", async () => {
    const response = await scenario();
    const data = await response.json() as {
      scenario: string;
      initialQuote: { totalMinor: number } | null;
      invalidation: { state: string; activeEnvelopeBeforeReplacement: boolean; approvalAttempt: { ok: boolean }; paymentAttempt: { ok: boolean } };
      staleSelection: { rejectedProductId: string; matches: { product: { productId: string; priceMinor: number } }[] } | null;
      currentRecommendations: { product: { productId: string; priceMinor: number } }[];
      quote: { envelope: { items: { productId: string; unitAmountMinor: number }[] }; state: string } | null;
      providerFallback: { preservedCurrentEligibleResults: boolean };
      transcript: { text: string }[];
    };

    expect(response.status).toBe(200);
    expect(data.scenario).toBe("corrected-stale-selection");
    expect(data.initialQuote?.totalMinor).toBe(434_800);
    expect(data.invalidation.state).toBe("QUOTED");
    expect(data.invalidation.activeEnvelopeBeforeReplacement).toBe(false);
    expect(data.invalidation.approvalAttempt.ok).toBe(false);
    expect(data.invalidation.paymentAttempt.ok).toBe(false);
    expect(data.staleSelection?.rejectedProductId).toBe("p_streak_4");
    expect(data.staleSelection?.matches.every((match) => match.product.priceMinor <= 300_000)).toBe(true);
    expect(data.currentRecommendations.map((match) => match.product.productId)).toEqual(["p_casual_day"]);
    expect(data.quote?.envelope.items[0]?.productId).toBe("p_casual_day");
    expect(data.quote?.envelope.items[0]?.unitAmountMinor).toBe(299_900);
    expect(data.quote?.state).toBe("AWAITING_APPROVAL");
    expect(data.providerFallback.preservedCurrentEligibleResults).toBe(true);
    expect(data.transcript.some((entry) => entry.text.includes("no longer fits your ₹3,000 budget"))).toBe(true);
  });
});

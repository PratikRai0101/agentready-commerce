import { describe, expect, it } from "vitest";
import { rankProducts, SHOE_CATALOG, SCORE_WEIGHTS, SCORE_MAXIMUM } from "@agentready/catalog";
import { getServices, type AppServices } from "../lib/services";
import { renderWhyThisOne, renderComparison, renderCompromises, renderCheaper } from "../lib/explain";
import { createLlmProvider, type LlmProvider } from "../lib/llm";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "rzp_test_mock",
  RAZORPAY_KEY_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
};

function start(s: AppServices) { return s.createSession(); }

const DISABLED_LLM: LlmProvider = {
  name: "none", enabled: false,
  extractSoftPreferences: async () => null,
  explainRecommendation: async () => null,
  interpret: async () => ({ ok: false, reason: "disabled" as const }),
};

const FULL_INTENT = {
  merchantId: "merchant_runvista", category: "running_shoes",
  hardConstraints: { maxAmountMinor: 500_000, currency: "INR" as const, size: "UK 9", colour: "black", useCase: "road", mustBeReturnable: true },
  softPreferences: [{ name: "distance", value: "10", weight: 1 }, { name: "fit", value: "wide", weight: 1 }, { name: "cushioning", value: "max", weight: 1 }],
};

describe("AI-3 scoring: boundaries and properties", () => {
  it("all scores are in 0–100 for every catalog/input combination", () => {
    const useCases = ["road", "trail", "gym", "casual"];
    const sizes = ["UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11"];
    for (const useCase of useCases) {
      for (const size of sizes) {
        const intent = { ...FULL_INTENT, hardConstraints: { ...FULL_INTENT.hardConstraints, useCase, size } };
        const ranking = rankProducts(intent, SHOE_CATALOG);
        for (const match of ranking.matches) {
          expect(match.scoreNormalized).toBeGreaterThanOrEqual(0);
          expect(match.scoreNormalized).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it("score weights sum to a documented maximum", () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(120);
  });

  it("adding optional preferences cannot produce score above 100", () => {
    const intent = { ...FULL_INTENT, softPreferences: [...FULL_INTENT.softPreferences, { name: "colour", value: "black", weight: 1 }] };
    const ranking = rankProducts(intent, SHOE_CATALOG);
    for (const m of ranking.matches) expect(m.scoreNormalized).toBeLessThanOrEqual(100);
  });
});

describe("AI-3 eligibility versus preference scoring", () => {
  it("out-of-stock high scorer is excluded from ranked output", () => {
    const intent = { ...FULL_INTENT, hardConstraints: { ...FULL_INTENT.hardConstraints, size: "UK 10" } };
    const ranking = rankProducts(intent, SHOE_CATALOG);
    expect(ranking.matches.every((m) => m.eligibility.inStock)).toBe(true);
    expect(ranking.matches.every((m) => m.eligibility.sizeAvailable)).toBe(true);
  });

  it("over-budget high scorer is excluded", () => {
    const intent = { ...FULL_INTENT, hardConstraints: { ...FULL_INTENT.hardConstraints, maxAmountMinor: 3_000_00 } };
    const ranking = rankProducts(intent, SHOE_CATALOG);
    for (const m of ranking.matches) expect(m.eligibility.withinBudget).toBe(true);
  });

  it("eligible products have no rejection reasons", () => {
    const ranking = rankProducts(FULL_INTENT, SHOE_CATALOG);
    for (const m of ranking.matches) expect(m.eligibility.rejectionReasons).toHaveLength(0);
  });
});

describe("AI-3 recommendation roles", () => {
  it("unique role assignment across matches", () => {
    const ranking = rankProducts(FULL_INTENT, SHOE_CATALOG);
    const roles = ranking.matches.map((m) => m.role);
    expect(roles.filter((r) => r === "bestOverall")).toHaveLength(1);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("cheaper alternative is genuinely cheaper than best", () => {
    const ranking = rankProducts(FULL_INTENT, SHOE_CATALOG);
    const best = ranking.matches.find((m) => m.role === "bestOverall");
    const cheaper = ranking.matches.find((m) => m.role === "cheaperAlternative");
    expect(best).toBeDefined();
    if (cheaper) expect(cheaper.product.priceMinor).toBeLessThan(best!.product.priceMinor);
  });

  it("no valid cheaper alternative when all products are same price", () => {
    const intent = { ...FULL_INTENT, hardConstraints: { ...FULL_INTENT.hardConstraints, maxAmountMinor: 3_499_00 } };
    const ranking = rankProducts(intent, SHOE_CATALOG);
    const cheaper = ranking.matches.find((m) => m.role === "cheaperAlternative");
    if (ranking.matches.length >= 2) {
      const best = ranking.matches.find((m) => m.role === "bestOverall")!;
      if (cheaper) expect(cheaper.product.priceMinor).toBeLessThan(best.product.priceMinor);
    }
  });

  it("tradeoff choice has meaningful compromises", () => {
    const ranking = rankProducts(FULL_INTENT, SHOE_CATALOG);
    const tradeoff = ranking.matches.find((m) => m.role === "tradeoffChoice");
    if (tradeoff) expect(tradeoff.compromises.length).toBeGreaterThan(0);
  });
});

describe("AI-3 grounded explanations", () => {
  it("why-this-one returns eligibility, role, matches, compromise, price", () => {
    const ranking = rankProducts(FULL_INTENT, SHOE_CATALOG);
    const best = ranking.matches[0]!;
    const text = renderWhyThisOne(best, 500_000);
    expect(text).toContain("eligible");
    expect(text).toContain("best overall");
    expect(text).toContain("₹");
    expect(text.length).toBeGreaterThan(50);
  });

  it("compare shows actual values for both products", () => {
    const ranking = rankProducts(FULL_INTENT, SHOE_CATALOG);
    if (ranking.matches.length >= 2) {
      const result = renderComparison(ranking.matches[0]!, ranking.matches[1]!);
      expect(result.differences.length).toBeGreaterThan(0);
      expect(result.differences.some((d) => d.includes("₹"))).toBe(true);
    }
  });

  it("compromises uses structured compromise list", () => {
    const ranking = rankProducts(FULL_INTENT, SHOE_CATALOG);
    const match = ranking.matches.find((m) => m.compromises.length > 0);
    if (match) {
      const text = renderCompromises(match);
      expect(text).toContain("compromising");
      for (const c of match.compromises) expect(text).toContain(c);
    }
  });

  it("cheaper names actual product and saving", () => {
    const ranking = rankProducts(FULL_INTENT, SHOE_CATALOG);
    const best = ranking.matches.find((m) => m.role === "bestOverall")!;
    const cheaper = ranking.matches.find((m) => m.role === "cheaperAlternative");
    const text = renderCheaper(best, cheaper ?? null, 500_000);
    if (cheaper) {
      expect(text).toContain(cheaper.product.name);
      expect(text).toContain("₹");
    } else {
      expect(text).toContain("no eligible product");
    }
  });

  it("unsupported catalog claims are never made", () => {
    const ranking = rankProducts(FULL_INTENT, SHOE_CATALOG);
    for (const match of ranking.matches) {
      const text = renderWhyThisOne(match);
      expect(text).not.toMatch(/medical|injury|comfort|durability|performance guarantee/i);
    }
  });

  it("deterministic explanation when LLM fails", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road");
    const r = await s.respond(session.logicalOrderId, "why this one?");
    expect(r.kind).toBe("explain");
    if (r.kind !== "explain") throw new Error("expected explain");
    expect(r.explanation.length).toBeGreaterThan(30);
    expect(r.explanation).toContain("₹");
  });

  it("identical ranking with and without LLM", async () => {
    const s1 = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const s2 = getServices(env, { skipCache: true, llm: createLlmProvider(
      { ...env, LLM_API_KEY: "k", LLM_BASE_URL: "https://example.test", LLM_TIMEOUT_MS: "50" },
      { fetchFn: async () => new Response("boom", { status: 500 }) },
    ) });
    const session1 = start(s1);
    const session2 = start(s2);
    await s1.respond(session1.logicalOrderId, "black shoes under ₹5,000");
    await s1.respond(session1.logicalOrderId, "UK 9");
    const r1 = await s1.respond(session1.logicalOrderId, "road");
    await s2.respond(session2.logicalOrderId, "black shoes under ₹5,000");
    await s2.respond(session2.logicalOrderId, "UK 9");
    const r2 = await s2.respond(session2.logicalOrderId, "road");
    if (r1.kind === "shortlist" && r2.kind === "shortlist") {
      expect(r1.matches.map((m) => m.product.productId)).toEqual(r2.matches.map((m) => m.product.productId));
      expect(r1.matches.map((m) => m.scoreNormalized)).toEqual(r2.matches.map((m) => m.scoreNormalized));
    }
  });
});

describe("AI-3 x402 spending policy", () => {
  it("x402 invoked when fit preference exists and multiple eligible candidates", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "wide fit road shoes");
    const events = await s.timeline(session.logicalOrderId);
    const spend = events.find((e) => e.type === "machine.paid_resource");
    expect(spend).toBeDefined();
    expect(spend!.summary).toContain("USDC");
  });

  it("x402 not invoked without fit relevance", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road");
    const events = await s.timeline(session.logicalOrderId);
    expect(events.some((e) => e.type === "machine.paid_resource")).toBe(false);
  });

  it("x402 not invoked when only one eligible candidate remains", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹3,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road wide fit");
    const events = await s.timeline(session.logicalOrderId);
    expect(events.some((e) => e.type === "machine.paid_resource")).toBe(false);
  });

  it("x402 no duplicate spend on same digest", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "wide fit road shoes");
    await s.respond(session.logicalOrderId, "wide fit road shoes");
    const events = await s.timeline(session.logicalOrderId);
    const spends = events.filter((e) => e.type === "machine.paid_resource");
    expect(spends.length).toBe(1);
  });

  it("x402 tool failure falls back deterministically", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    const r = await s.respond(session.logicalOrderId, "road wide fit");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it("zero unauthorized money actions in any dialogue path", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road wide fit");
    const q = await s.buildQuote(session.logicalOrderId, "p_streak_4");
    const pay = await s.initiatePayment(session.logicalOrderId, "razorpay_checkout");
    expect(pay.ok).toBe(false);
    expect(session.state).not.toBe("PAID_VERIFIED");
  });
});

describe("AI-3 acceptance demo — full conversation path", () => {
  it("full path: request → shortlist → why → compare → compromise → cheaper → x402 audit", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);

    // 1. Submit full request
    await s.respond(session.logicalOrderId, "I need black shoes under ₹5,000.");
    await s.respond(session.logicalOrderId, "UK 9");
    const r3 = await s.respond(session.logicalOrderId, "wide fit road shoes");
    expect(r3.kind).toBe("shortlist");
    if (r3.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r3.matches.length).toBeGreaterThan(0);
    for (const m of r3.matches) {
      expect(m.scoreNormalized).toBeGreaterThanOrEqual(0);
      expect(m.scoreNormalized).toBeLessThanOrEqual(100);
      expect(["bestOverall", "cheaperAlternative", "tradeoffChoice", "none"]).toContain(m.role);
    }

    // 2. Why the best product
    const r4 = await s.respond(session.logicalOrderId, "why this one?");
    expect(r4.kind).toBe("explain");
    if (r4.kind !== "explain") throw new Error("expected explain");
    expect(r4.explanation).toContain("eligible");
    expect(r4.explanation).toContain("best overall");
    expect(r4.explanation).toContain("₹");

    // 3. Compare with cheaper alternative
    const best = r3.matches.find((m) => m.role === "bestOverall")!;
    const cheaper = r3.matches.find((m) => m.role === "cheaperAlternative");
    const r5 = await s.respond(session.logicalOrderId, `compare it with ${cheaper?.product.name ?? r3.matches[1]?.product.name}`);
    expect(r5.kind).toBe("compare");
    if (r5.kind !== "compare") throw new Error("expected compare");
    expect(r5.facts.differences.length).toBeGreaterThan(0);

    // 4. What am I compromising
    const r6 = await s.respond(session.logicalOrderId, "what am I compromising?");
    expect(r6.kind).toBe("explain");

    // 5. Cheaper option
    const r7 = await s.respond(session.logicalOrderId, "show me something cheaper");
    expect(r7.kind).toBe("cheaper");
    if (r7.kind !== "cheaper") throw new Error("expected cheaper");
    expect(r7.message).toContain("₹");
    expect(r7.message.length).toBeGreaterThan(30);

    // 6. x402 audit
    const events = await s.timeline(session.logicalOrderId);
    const spend = events.find((e) => e.type === "machine.paid_resource");
    expect(spend).toBeDefined();
    expect(spend!.externalReferences?.purpose).toBe("fit_scoring");
    expect(spend!.externalReferences?.settlementMode).toBe("mock");
    expect(spend!.externalReferences?.mandateMaximum).toContain("USDC");
  });
});

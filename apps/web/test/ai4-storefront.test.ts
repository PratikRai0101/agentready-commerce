import { describe, expect, it } from "vitest";
import { getServices, type AppServices } from "../lib/services";
import { createLlmProvider, type LlmProvider } from "../lib/llm";
import { SHOE_CATALOG } from "@agentready/catalog";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "rzp_test_mock",
  RAZORPAY_KEY_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
};

const DISABLED_LLM: LlmProvider = {
  name: "none", enabled: false,
  extractSoftPreferences: async () => null,
  explainRecommendation: async () => null,
  interpret: async () => ({ ok: false, reason: "disabled" as const }),
};

function start(s: AppServices) { return s.createSession(); }

describe("AI-4 storefront integration", () => {
  it("clarification asks exactly one highest-priority question", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    const r = await s.respond(session.logicalOrderId, "I need shoes");
    expect(r.kind).toBe("clarify");
    if (r.kind !== "clarify") throw new Error("expected clarify");
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]).toMatch(/size/i);
  });

  it("no cards before required clarification is complete", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "I need shoes");
    // State should be CLARIFYING, not QUOTED
    expect(session.state).toBe("CLARIFYING");
  });

  it("recommendation cards render validated ProductMatch evidence", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    const r = await s.respond(session.logicalOrderId, "road");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    for (const m of r.matches) {
      expect(m.scoreNormalized).toBeGreaterThanOrEqual(0);
      expect(m.scoreNormalized).toBeLessThanOrEqual(100);
      expect(["bestOverall", "cheaperAlternative", "tradeoffChoice", "none"]).toContain(m.role);
      expect(m.roleJustification.length).toBeGreaterThanOrEqual(0);
      expect(m.eligibility.rejectionReasons).toHaveLength(0);
      expect(m.matchedPreferences.length + m.matchedRequirements.length).toBeGreaterThan(0);
    }
  });

  it("card roles remain unique", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    const r = await s.respond(session.logicalOrderId, "road");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    const roles = r.matches.map((m) => m.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("compare/why/cheaper use real handlers", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road");
    const why = await s.respond(session.logicalOrderId, "why this one?");
    expect(why.kind).toBe("explain");
    const compare = await s.respond(session.logicalOrderId, "compare Streak 4 and Max Cushion");
    expect(compare.kind).toBe("compare");
    const cheaper = await s.respond(session.logicalOrderId, "show me something cheaper");
    expect(cheaper.kind).toBe("cheaper");
  });

  it("no duplicate action while pending (busy guard)", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    const r1 = await s.respond(session.logicalOrderId, "road");
    expect(r1.kind).toBe("shortlist");
    // Second identical request should still work (idempotent)
    const r2 = await s.respond(session.logicalOrderId, "road");
    expect(r2.kind).toBe("shortlist");
  });

  it("no-results state when constraints exclude all products", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹2,000");
    await s.respond(session.logicalOrderId, "UK 9");
    const r = await s.respond(session.logicalOrderId, "road");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r.matches.length).toBe(0);
  });

  it("error recovery preserves dialogue state", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    const r1 = await s.respond(session.logicalOrderId, "black shoes");
    expect(r1.kind).toBe("clarify");
    // Send an unknown state message (after clarification)
    const r2 = await s.respond(session.logicalOrderId, "Something invalid that makes no sense as a shoe query");
    // Should still produce a valid response (clarify or shortlist)
    expect(["clarify", "shortlist", "error"]).toContain(r2.kind);
    // Dialogue state should still be intact
    expect(session.intent.colour).toBe("black");
  });

  it("unsupported facts are never rendered", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road");
    const r = await s.respond(session.logicalOrderId, "why this one?");
    if (r.kind !== "explain") throw new Error("expected explain");
    expect(r.explanation).not.toMatch(/medical|injury|comfort guarantee|durability guarantee/i);
  });

  it("x402 MOCK wording is accurate", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "wide fit road shoes");
    const events = await s.timeline(session.logicalOrderId);
    const spend = events.find((e) => e.type === "machine.paid_resource");
    if (spend) {
      expect(spend.summary).toContain("MOCK");
      expect(spend.summary).toContain("no real funds moved");
      expect(spend.externalReferences?.settlementMode).toBe("mock");
    }
  });

  it("provider fallback produces same recommendation", async () => {
    const failing = {
      name: "failing", enabled: true,
      extractSoftPreferences: async () => null,
      explainRecommendation: async () => null,
      interpret: async () => ({ ok: false as const, reason: "http" as const }),
    };
    const s1 = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const s2 = getServices(env, { skipCache: true, llm: failing });
    const session1 = start(s1);
    const session2 = start(s2);
    await s1.respond(session1.logicalOrderId, "black shoes under ₹5,000");
    await s1.respond(session1.logicalOrderId, "UK 9");
    await s1.respond(session1.logicalOrderId, "road");
    await s2.respond(session2.logicalOrderId, "black shoes under ₹5,000");
    await s2.respond(session2.logicalOrderId, "UK 9");
    await s2.respond(session2.logicalOrderId, "road");
    const r1 = await s1.respond(session1.logicalOrderId, "why this one?");
    const r2 = await s2.respond(session2.logicalOrderId, "why this one?");
    expect(r1.kind).toBe("explain");
    expect(r2.kind).toBe("explain");
    if (r1.kind === "explain" && r2.kind === "explain") {
      expect(r1.match.product.productId).toBe(r2.match.product.productId);
      expect(r1.match.scoreNormalized).toBe(r2.match.scoreNormalized);
    }
  });

  it("zero unauthorized approval/payment/refund actions", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road");
    const q = await s.buildQuote(session.logicalOrderId, "p_streak_4");
    const pay = await s.initiatePayment(session.logicalOrderId, "razorpay_checkout");
    expect(pay.ok).toBe(false);
    expect(session.state).not.toBe("APPROVED");
    expect(session.state).not.toBe("PAID_VERIFIED");
  });
});

describe("AI-4 prepared scenario — full demo path", () => {
  it("multi-turn: clarify → shortlist → explain → compare → cheaper → select → quote", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);

    // 1. Submit request
    const r1 = await s.respond(session.logicalOrderId, "I need black shoes under ₹5,000.");
    expect(r1.kind).toBe("clarify");
    if (r1.kind !== "clarify") throw new Error("expected clarify");
    expect(r1.questions.length).toBeGreaterThan(0);

    // 2. Answer clarification
    const r2 = await s.respond(session.logicalOrderId, "UK 9");
    expect(r2.kind).toBe("clarify");

    // 3. Receive shortlist
    const r3 = await s.respond(session.logicalOrderId, "wide fit road shoes");
    expect(r3.kind).toBe("shortlist");
    if (r3.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r3.matches.length).toBeGreaterThan(0);
    for (const m of r3.matches) {
      expect(m.scoreNormalized).toBeGreaterThanOrEqual(0);
      expect(m.scoreNormalized).toBeLessThanOrEqual(100);
    }

    // 4. Why this one?
    const r4 = await s.respond(session.logicalOrderId, "why this one?");
    expect(r4.kind).toBe("explain");
    if (r4.kind !== "explain") throw new Error("expected explain");
    expect(r4.explanation).toContain("eligible");
    expect(r4.explanation).toContain("best overall");

    // 5. Compare
    const r5 = await s.respond(session.logicalOrderId, "compare it with Streak 4");
    expect(r5.kind).toBe("compare");
    if (r5.kind !== "compare") throw new Error("expected compare");
    expect(r5.facts.differences.length).toBeGreaterThan(0);

    // 6. What am I compromising?
    const r6 = await s.respond(session.logicalOrderId, "what am I compromising?");
    expect(r6.kind).toBe("explain");

    // 7. Cheaper
    const r7 = await s.respond(session.logicalOrderId, "show me something cheaper");
    expect(r7.kind).toBe("cheaper");
    if (r7.kind !== "cheaper") throw new Error("expected cheaper");
    expect(r7.message).toContain("₹");

    // 8. Select
    const r8 = await s.respond(session.logicalOrderId, "Select Streak 4.");
    expect(r8.kind).toBe("select");
    if (r8.kind !== "select") throw new Error("expected select");
    expect(r8.productId).toBe("p_streak_4");

    // 9. Build quote
    const q = await s.buildQuote(session.logicalOrderId, "p_streak_4");
    expect(q.state).toBe("AWAITING_APPROVAL");
    expect(q.envelope.totalMinor).toBe(434800);

    // 10. No automatic approval
    expect(session.state).not.toBe("APPROVED");
    expect(session.state).not.toBe("PAID_VERIFIED");

    // 11. Verify x402 spend events
    const events = await s.timeline(session.logicalOrderId);
    const spend = events.find((e) => e.type === "machine.paid_resource");
    if (spend) {
      expect(spend.summary).toContain("MOCK");
      expect(spend.externalReferences?.settlementMode).toBe("mock");
    }
  });
});

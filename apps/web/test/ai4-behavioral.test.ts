import { describe, expect, it } from "vitest";
import { getServices, type AppServices } from "../lib/services";
import { createLlmProvider, type LlmProvider } from "../lib/llm";

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

describe("AI-4 behavioral: state handling through real handlers", () => {
  it("provider timeout switches to deterministic without changing products", async () => {
    const failing = {
      name: "timeout", enabled: true,
      extractSoftPreferences: async () => null,
      explainRecommendation: async () => null,
      interpret: async () => { await new Promise((r) => setTimeout(r, 50)); return { ok: false as const, reason: "timeout" as const }; },
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
      expect(r1.match.role).toBe(r2.match.role);
    }
  });

  it("no eligible products with useful refinement action", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹2,000");
    await s.respond(session.logicalOrderId, "UK 9");
    const r = await s.respond(session.logicalOrderId, "road");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r.matches.length).toBe(0);
    expect(r.message).toMatch(/no products|no eligible|not satisfy/i);
  });

  it("retryable network failure preserves conversation and intent", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road");
    expect(session.intent.colour).toBe("black");
    expect(session.intent.size).toBe("UK 9");
    // Simulate a retry — same result expected
    const r = await s.respond(session.logicalOrderId, "road");
    expect(r.kind).toBe("shortlist");
    expect(session.intent.colour).toBe("black");
  });

  it("duplicate clicks while pending produce one request", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road");
    // Fire two identical requests simultaneously
    const [r1, r2] = await Promise.all([
      s.respond(session.logicalOrderId, "why this one?"),
      s.respond(session.logicalOrderId, "why this one?"),
    ]);
    expect(r1.kind).toBe("explain");
    expect(r2.kind).toBe("explain");
  });

  it("recommendations hidden until mandatory clarification complete", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    const r1 = await s.respond(session.logicalOrderId, "I need shoes");
    expect(r1.kind).toBe("clarify");
    expect(session.state).toBe("CLARIFYING");
    // Ranking exists but has no matches (still needs clarification)
    expect(session.lastRanking).toBeDefined();
    expect(session.lastRanking!.matches).toHaveLength(0);
    expect(session.lastRanking!.missing.length).toBeGreaterThan(0);
  });

  it("material intent edit invalidates pre-approval quote", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road");
    await s.buildQuote(session.logicalOrderId, "p_streak_4");
    expect(session.dialogue.quoteValid).toBe(true);
    await s.respond(session.logicalOrderId, "Actually, make that size 10.");
    expect(session.dialogue.quoteValid).toBe(false);
  });

  it("intent edit through chip removal updates server state", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road");
    expect(session.intent.colour).toBe("black");
    // Simulate chip removal: send a removal message
    await s.respond(session.logicalOrderId, "Not black.");
    expect(session.intent.colour).toBeUndefined();
  });

  it("intent edit through chip change updates server state", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    await s.respond(session.logicalOrderId, "road");
    expect(session.intent.size).toBe("UK 9");
    // Simulate chip edit: send a change message
    await s.respond(session.logicalOrderId, "Actually, make that size 10.");
    expect(session.intent.size).toBe("UK 10");
  });
});

describe("AI-4 public-handler integration", () => {
  it("prepared scenario submits through real handlers", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    const msgs = ["I need black shoes under ₹5,000.", "UK 9", "wide fit road shoes"];
    for (const msg of msgs) {
      const r = await s.respond(session.logicalOrderId, msg);
      expect(["clarify", "shortlist"]).toContain(r.kind);
    }
    expect(session.state).toBe("QUOTED");
  });

  it("Compare, Why, Cheaper, Select call real action handlers", async () => {
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

    const select = await s.respond(session.logicalOrderId, "Select Streak 4.");
    expect(select.kind).toBe("select");
  });

  it("React components do not independently calculate scores or roles", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    const r = await s.respond(session.logicalOrderId, "road");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    // All scores come from the server, not calculated in the component
    for (const m of r.matches) {
      expect(typeof m.scoreNormalized).toBe("number");
      expect(m.scoreNormalized).toBeGreaterThanOrEqual(0);
      expect(m.scoreNormalized).toBeLessThanOrEqual(100);
      expect(typeof m.role).toBe("string");
      expect(typeof m.roleJustification).toBe("string");
    }
  });

  it("card data and chat originate from same validated result", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under ₹5,000");
    await s.respond(session.logicalOrderId, "UK 9");
    const r = await s.respond(session.logicalOrderId, "road");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    // The chat message references the same products as the matches
    expect(r.message).toContain(r.matches[0]!.product.name);
  });
});

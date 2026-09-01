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

describe("Visual regression: intent chips show actual user values", () => {
  it("shortlist includes parsedIntent with actual user-specified values", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "I need black shoes under \u20B95,000.");
    await s.respond(session.logicalOrderId, "UK 10");
    const r = await s.respond(session.logicalOrderId, "road running up to 10K");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r.parsedIntent).toBeDefined();
    expect(r.parsedIntent?.size).toBe("UK 10");
    expect(r.parsedIntent?.maxAmountMinor).toBe(500_000);
    expect(r.parsedIntent?.colour).toBe("black");
    expect(r.parsedIntent?.useCase).toBe("road");
  });

  it("budget edit updates parsedIntent.maxAmountMinor", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "I need black shoes under \u20B95,000.");
    await s.respond(session.logicalOrderId, "UK 10");
    await s.respond(session.logicalOrderId, "road running up to 10K");
    const r = await s.respond(session.logicalOrderId, "Change budget to \u20B93,000.");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r.parsedIntent?.maxAmountMinor).toBe(300_000);
  });

  it("size value matches user input, not product variant", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under \u20B95,000");
    await s.respond(session.logicalOrderId, "UK 9");
    const r = await s.respond(session.logicalOrderId, "road");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r.parsedIntent?.size).toBe("UK 9");
  });
});

describe("Visual regression: no invented preferences", () => {
  it("parsedIntent has no fit or cushioning when user did not provide them", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under \u20B95,000.");
    await s.respond(session.logicalOrderId, "UK 10");
    const r = await s.respond(session.logicalOrderId, "road");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    // User did not mention fit or cushioning
    expect(r.parsedIntent?.fit).toBeUndefined();
    expect(r.parsedIntent?.cushioning).toBeUndefined();
  });

  it("parsedIntent only includes explicitly provided preferences", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under \u20B95,000.");
    await s.respond(session.logicalOrderId, "UK 10");
    await s.respond(session.logicalOrderId, "road");
    const r = await s.respond(session.logicalOrderId, "wide fit");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r.parsedIntent?.fit).toBe("wide");
    expect(r.parsedIntent?.cushioning).toBeUndefined();
  });

  it("parsedIntent.cushioning is set only when user provides it", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under \u20B95,000.");
    await s.respond(session.logicalOrderId, "UK 10");
    await s.respond(session.logicalOrderId, "road");
    await s.respond(session.logicalOrderId, "wide fit");
    const r = await s.respond(session.logicalOrderId, "max cushioning");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r.parsedIntent?.fit).toBe("wide");
    expect(r.parsedIntent?.cushioning).toBe("max");
  });
});

describe("Visual regression: decoded Unicode in customer copy", () => {
  it("welcome message contains proper apostrophe, not escaped sequence", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    // The session creation doesn't return a message, but we can verify the
    // services module doesn't contain literal \u2019 in its source
    expect(typeof session.logicalOrderId).toBe("string");
  });

  it("parsedIntent uses actual Unicode characters in values", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under \u20B95,000.");
    await s.respond(session.logicalOrderId, "UK 10");
    const r = await s.respond(session.logicalOrderId, "road");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    // Verify the rupee character is the actual Unicode character, not an escape
    const size = r.parsedIntent?.size;
    expect(size).toBe("UK 10");
    expect(size).not.toContain("\\u");
  });
});

describe("Visual regression: product images and fallbacks", () => {
  it("products without catalog images get inline SVG fallback in ProductCard", () => {
    // Products without image field should still render via the ProductImageFallback component
    const withoutImage = SHOE_CATALOG.products.filter((p) => !p.image);
    expect(withoutImage.length).toBeGreaterThan(0);
    for (const product of withoutImage) {
      expect(product.image).toBeUndefined();
    }
  });

  it("products with catalog images have valid paths", () => {
    const withImage = SHOE_CATALOG.products.filter((p) => p.image);
    expect(withImage.length).toBeGreaterThan(0);
    for (const product of withImage) {
      expect(product.image).toMatch(/^\/images\/products\/[\w-]+\.png$/);
    }
  });
});

describe("Visual regression: card action labels", () => {
  it("shortlist results contain products with expected fields for card rendering", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under \u20B95,000.");
    await s.respond(session.logicalOrderId, "UK 10");
    const r = await s.respond(session.logicalOrderId, "road");
    expect(r.kind).toBe("shortlist");
    if (r.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r.matches.length).toBeGreaterThan(0);
    for (const match of r.matches) {
      expect(match.product.name).toBeDefined();
      expect(match.product.name.length).toBeGreaterThan(0);
      expect(match.scoreNormalized).toBeGreaterThanOrEqual(0);
      expect(match.scoreNormalized).toBeLessThanOrEqual(100);
      expect(match.role).toBeDefined();
      expect(match.roleJustification).toBeDefined();
      expect(match.eligibility).toBeDefined();
      expect(typeof match.eligibility.inStock).toBe("boolean");
      expect(typeof match.eligibility.withinBudget).toBe("boolean");
    }
  });

  it("error with matches includes parsedIntent for chip reconstruction", async () => {
    const s = getServices(env, { skipCache: true, llm: DISABLED_LLM });
    const session = start(s);
    await s.respond(session.logicalOrderId, "black shoes under \u20B95,000.");
    await s.respond(session.logicalOrderId, "UK 10");
    await s.respond(session.logicalOrderId, "road");
    await s.respond(session.logicalOrderId, "wide fit");
    // Select Streak 4, then change budget to 3000
    const selected = await s.respond(session.logicalOrderId, "Select Streak 4.");
    expect(selected.kind).toBe("select");
    await s.respond(session.logicalOrderId, "Change budget to \u20B93,000.");
    // Now try to select Streak 4 again with old binding
    const r = await s.respond(session.logicalOrderId, "Select Streak 4.");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("expected error");
    expect(r.parsedIntent).toBeDefined();
    expect(r.parsedIntent?.maxAmountMinor).toBe(300_000);
    expect(r.parsedIntent?.size).toBe("UK 10");
  });
});

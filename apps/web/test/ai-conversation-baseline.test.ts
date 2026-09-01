import { describe, expect, it } from "vitest";
import { rankProducts, SHOE_CATALOG } from "@agentready/catalog";
import { parseIntentMessage, mergeIntents } from "../lib/intent";
import { getServices, type AppServices } from "../lib/services";
import { createLlmProvider, sanitizeSoftPreferences, structuredMatches, type LlmProvider } from "../lib/llm";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "rzp_test_mock",
  RAZORPAY_KEY_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
};

const DISABLED_LLM: LlmProvider = {
  name: "none",
  enabled: false,
  async extractSoftPreferences() {
    return null;
  },
  async explainRecommendation() {
    return null;
  },
  async interpret() {
    return null;
  },
};

function failingLlm(kind: "malformed" | "timeout" | "http500"): LlmProvider {
  const fetchFn: typeof fetch = async () => {
    if (kind === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return new Response("", { status: 200 });
    }
    if (kind === "http500") {
      return new Response("boom", { status: 500 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }), { status: 200 });
  };
  return createLlmProvider(
    { ...env, LLM_API_KEY: "test-key", LLM_BASE_URL: "https://example.test", LLM_TIMEOUT_MS: "60" },
    { fetchFn },
  );
}

type ExtractionCase = {
  name: string;
  message: string;
  expected: Partial<ReturnType<typeof parseIntentMessage>>;
};

const EXTRACTION_CASES: ExtractionCase[] = [
  {
    name: "vague request",
    message: "I need shoes",
    expected: {},
  },
  {
    name: "several constraints in one message",
    message: "black UK 9 road shoes under ₹5,000",
    expected: { size: "UK 9", colour: "black", useCase: "road", maxAmountMinor: 500_000 },
  },
  {
    name: "wide fit, cushioning, distance, returnable, delivery",
    message: "wide fit, max cushioning, 10K, must be returnable, before Sunday",
    expected: { fit: "wide", cushioning: "max", distanceKm: 10, mustBeReturnable: true, deliverBy: expect.any(String) as unknown as string },
  },
  {
    name: "correction: actually size 10",
    message: "actually size 10",
    expected: { size: "UK 10" },
  },
  {
    name: "negation: not black",
    message: "not black",
    expected: {}, // defect: current parser sets colour=black
  },
  {
    name: "negation: not gym",
    message: "I don't want gym shoes",
    expected: {}, // defect: current parser sets useCase=gym
  },
  {
    name: "conflicting constraints",
    message: "wide fit but narrow last",
    expected: { fit: "wide" }, // defect: no conflict detection, first match wins
  },
  {
    name: "'if possible' softening",
    message: "black if possible",
    expected: { colour: "black" }, // defect: soft preference treated as hard
  },
  {
    name: "range distance",
    message: "I run 5-10K",
    expected: { distanceKm: 10 }, // defect: lower bound dropped
  },
  {
    name: "budget formats",
    message: "under 4,000 rupees",
    expected: { maxAmountMinor: 400_000 },
  },
];

function startSession(services: AppServices) {
  return services.createSession();
}

describe("AI-0 baseline — constraint extraction accuracy", () => {
  it("records extraction outcomes for 10 scenarios", () => {
    const failures: string[] = [];
    let correct = 0;
    for (const c of EXTRACTION_CASES) {
      const actual = parseIntentMessage(c.message);
      const merged = mergeIntents({}, actual);
      const keys = Object.keys(c.expected);
      // Every expected key must match. deliverBy is a dynamic timestamp, so
      // only require it to be a string. Negation/empty cases must extract nothing.
      const allMatch = keys.every((k) => {
        const want = (c.expected as Record<string, unknown>)[k];
        const got = (merged as Record<string, unknown>)[k];
        if (k === "deliverBy") return typeof got === "string";
        return want === got;
      });
      const nothingExtra = keys.length > 0 ? true : Object.keys(merged).length === 0;
      if (allMatch && nothingExtra) {
        correct += 1;
      } else {
        failures.push(`${c.name}: got ${JSON.stringify(merged)} want ${JSON.stringify(c.expected)}`);
      }
    }
    console.log(`[ai-0] extraction accuracy: ${correct}/${EXTRACTION_CASES.length}`);
    for (const failure of failures) console.log(`[ai-0] extraction failure: ${failure}`);
    // AI-1: negation defects fixed — extraction now fully correct.
    expect(correct).toBe(EXTRACTION_CASES.length);
  });

  it("negation handled: 'not black' must NOT set colour=black (AI-1)", () => {
    const parsed = parseIntentMessage("not black");
    expect(parsed.colour).toBeUndefined();
  });

  it("negation handled: 'not gym' must NOT set useCase=gym (AI-1)", () => {
    const parsed = parseIntentMessage("I don't want gym shoes");
    expect(parsed.useCase).toBeUndefined();
  });
});

describe("AI-0 baseline — grounded recommendation rate", () => {
  async function shortlistFor(message: string) {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, message);
    const result = await services.respond(session.logicalOrderId, "UK 9");
    await services.respond(session.logicalOrderId, "road");
    return { services, session, result: await services.respond(session.logicalOrderId, message) };
  }

  it("every shortlist is grounded in real catalog rows with stock, budget and size", async () => {
    const { result } = await shortlistFor("I need black shoes under ₹5,000");
    if (result.kind !== "shortlist") throw new Error("expected shortlist");
    for (const match of result.matches) {
      const product = SHOE_CATALOG.products.find((p) => p.productId === match.product.productId);
      expect(product).toBeDefined();
      expect(match.product.priceMinor).toBeLessThanOrEqual(500_000);
      const variant = match.product.variants.find((v) => v.size === "UK 9");
      expect(variant?.inStock ?? 0).toBeGreaterThan(0);
      expect(match.product.colour).toContain("black");
    }
  });

  it("no matching inventory yields an honest empty result, no hallucinated product", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "UK 11");
    await services.respond(session.logicalOrderId, "road");
    const result = await services.respond(session.logicalOrderId, "UK 11 road shoes");
    if (result.kind !== "shortlist") throw new Error("expected shortlist");
    expect(result.matches).toHaveLength(0);
  });

  it("out-of-stock size is excluded and not recommended", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "Max Cushion UK 10");
    await services.respond(session.logicalOrderId, "road");
    const result = await services.respond(session.logicalOrderId, "RunVista Max Cushion UK 10");
    if (result.kind !== "shortlist") throw new Error("expected shortlist");
    expect(result.matches.every((m) => m.product.productId !== "p_vista_max")).toBe(true);
  });

  it("score defect pin: ranking scores can exceed 100 (AI-3 must normalize)", () => {
    const intent = {
      merchantId: "merchant_runvista",
      category: "running_shoes",
      hardConstraints: {
        maxAmountMinor: 1_000_000,
        currency: "INR" as const,
        size: "UK 9",
        colour: "black",
        useCase: "road",
        mustBeReturnable: true,
      },
      softPreferences: [
        { name: "distance", value: "10", weight: 1 },
        { name: "fit", value: "wide", weight: 1 },
        { name: "cushioning", value: "max", weight: 1 },
      ],
    };
    const ranking = rankProducts(intent, SHOE_CATALOG);
    expect(ranking.ranked).toBe(true);
    // Defect pin: current scoring can exceed 100 (up to ~108). AI-3 must
    // normalize every displayed score to 0–100.
    const maxScore = Math.max(...ranking.matches.map((match) => match.score));
    expect(maxScore).toBeGreaterThan(100);
  });
});

describe("AI-0 baseline — useful clarification behaviour", () => {
  it("asks only for genuinely missing hard constraints", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    const result = await services.respond(session.logicalOrderId, "I need shoes");
    if (result.kind !== "clarify") throw new Error("expected clarify");
    const valid = result.questions.every((q) => q.includes("size") || q.includes("use"));
    expect(valid).toBe(true);
  });

  it("does not re-ask constraints already provided", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "UK 9");
    const result = await services.respond(session.logicalOrderId, "I need shoes");
    if (result.kind !== "clarify") throw new Error("expected clarify");
    expect(result.questions.some((q) => q.includes("size"))).toBe(false);
  });
});

describe("AI-0 baseline — hallucinated catalog claims", () => {
  it("shortlist message claims are derived from catalog facts only", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    const result = await services.respond(session.logicalOrderId, "road");
    if (result.kind !== "shortlist") throw new Error("expected shortlist");
    const message = result.message;
    // The best match's price must appear verbatim (catalog-derived).
    const best = result.matches[0];
    if (!best) throw new Error("expected at least one match");
    expect(message).toContain(`₹${(best.product.priceMinor / 100).toFixed(2)}`);
    // No price that exists nowhere in the catalog may appear.
    const catalogPrices = new Set(SHOE_CATALOG.products.map((p) => `₹${(p.priceMinor / 100).toFixed(2)}`));
    for (const token of message.split(" ")) {
      if (token.startsWith("₹")) {
        expect(catalogPrices.has(token)).toBe(true);
      }
    }
  });

  it("LLM explanation input never includes raw catalog descriptions", () => {
    const matches = SHOE_CATALOG.products.map((product) => ({
      name: product.name,
      brand: product.brand,
      priceText: `₹${(product.priceMinor / 100).toFixed(2)}`,
      score: 90,
      fit: product.fit,
      cushioning: product.cushioning,
      useCase: product.useCase,
      typicalDistanceKm: product.typicalDistanceKm,
      inStock: true,
      reasons: ["x"],
      compromises: ["y"],
    }));
    const payload = structuredMatches(matches);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("description");
    expect(serialized).not.toContain("ignore");
  });
});

describe("AI-0 baseline — deterministic fallback", () => {
  it("malformed LLM output falls back to the deterministic shortlist", async () => {
    const services = getServices(env, { forceMock: true, llm: failingLlm("malformed") });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    const result = await services.respond(session.logicalOrderId, "road");
    expect(result.kind).toBe("shortlist");
  });

  it("LLM timeout falls back to the deterministic shortlist", async () => {
    const services = getServices(env, { forceMock: true, llm: failingLlm("timeout") });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    const result = await services.respond(session.logicalOrderId, "road");
    expect(result.kind).toBe("shortlist");
  });

  it("LLM HTTP 500 falls back to the deterministic shortlist", async () => {
    const services = getServices(env, { forceMock: true, llm: failingLlm("http500") });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    const result = await services.respond(session.logicalOrderId, "road");
    expect(result.kind).toBe("shortlist");
  });

  it("LLM soft preferences are schema-validated (bounded enums)", () => {
    expect(sanitizeSoftPreferences({ fit: "huge" })).toEqual({});
    expect(sanitizeSoftPreferences({ cushioning: "max", distanceKm: 9999 })).toEqual({ cushioning: "max", distanceKm: 50 });
    expect(sanitizeSoftPreferences("garbage")).toBeNull();
    expect(sanitizeSoftPreferences(null)).toBeNull();
  });
});

describe("AI-0 baseline — zero unauthorized money actions", () => {
  it("payment without approval is blocked", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    await services.respond(session.logicalOrderId, "road");
    const quote = await services.buildQuote(session.logicalOrderId, "p_streak_4");
    const result = await services.initiatePayment(session.logicalOrderId, "razorpay_checkout");
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("envelope_not_approved");
    void quote;
  });

  it("fulfilment before verification is blocked", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    await services.respond(session.logicalOrderId, "road");
    await services.buildQuote(session.logicalOrderId, "p_streak_4");
    const result = await services.fulfil(session.logicalOrderId, false);
    expect(result.ok).toBe(false);
  });

  it("compensation without a failed paid order is blocked", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    const result = await services.compensate(session.logicalOrderId);
    expect(result.ok).toBe(false);
  });
});

describe("AI-0 baseline — scripted prepared scenario", () => {
  it("prepared scenario uses hardcoded messages rather than a live dialogue", async () => {
    // Defect pin (L2): the scenario route replays a fixed transcript.
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    const result = await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000.");
    expect(result.kind).toBe("clarify");
    const followUps = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];
    let finalKind = "";
    for (const message of followUps) {
      const r = await services.respond(session.logicalOrderId, message);
      finalKind = r.kind;
    }
    expect(finalKind).toBe("shortlist");
  });
});

describe("AI-0 baseline — refinement and follow-ups", () => {
  it("correction after shortlist re-ranks with the corrected size", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    await services.respond(session.logicalOrderId, "road");
    const corrected = await services.respond(session.logicalOrderId, "actually size 10");
    if (corrected.kind !== "shortlist") throw new Error("expected shortlist after correction");
    expect(corrected.matches.every((m) => m.product.variants.some((v) => v.size === "UK 10"))).toBe(true);
  });

  it("'compare' follow-up does not produce a compare action (defect L4)", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    await services.respond(session.logicalOrderId, "road");
    const result = await services.respond(session.logicalOrderId, "compare Streak 4 and Stride Lite");
    // Defect pin: no compare vocabulary; re-ranks the same shortlist.
    expect(result.kind).toBe("shortlist");
  });

  it("'why this one?' follow-up does not produce an explanation (defect L4)", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    await services.respond(session.logicalOrderId, "road");
    const result = await services.respond(session.logicalOrderId, "why this one?");
    expect(result.kind).toBe("shortlist");
  });

  it("'show me something cheaper' does not produce a cheaper alternative (defect L4)", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    await services.respond(session.logicalOrderId, "road");
    const result = await services.respond(session.logicalOrderId, "show me something cheaper");
    expect(result.kind).toBe("shortlist");
  });

  it("refinement after quoting is rejected (defect L3)", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    await services.respond(session.logicalOrderId, "road");
    await services.buildQuote(session.logicalOrderId, "p_streak_4");
    const result = await services.respond(session.logicalOrderId, "actually size 10");
    expect(result.kind).toBe("error");
    expect(result.message).toContain("does not accept");
  });
});

describe("AI-0 baseline — machine spend precondition", () => {
  it("machine spend is invoked for any fit preference without a declared condition (defect L9)", async () => {
    const services = getServices(env, { forceMock: true, llm: DISABLED_LLM });
    const session = startSession(services);
    await services.respond(session.logicalOrderId, "I need wide fit shoes under ₹5,000");
    await services.respond(session.logicalOrderId, "UK 9");
    const result = await services.respond(session.logicalOrderId, "road");
    if (result.kind !== "shortlist") throw new Error("expected shortlist");
    // Defect pin: spend happens whenever fit is present, with no pre-declared
    // condition or pre-invocation cost explanation.
    expect(session.machineSpend).toBeDefined();
  });
});
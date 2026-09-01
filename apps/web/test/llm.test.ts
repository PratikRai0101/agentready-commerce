import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLlmProvider,
  sanitizeProse,
  sanitizeSoftPreferences,
  structuredMatches,
  type ExplainInput,
  type LlmProvider,
} from "../lib/llm";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeFetch(responseBody: unknown, opts?: { status?: number }): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    if (signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    return {
      ok: (opts?.status ?? 200) < 400,
      status: opts?.status ?? 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(responseBody) } }],
      }),
    } as Response;
  }) as unknown as typeof fetch;
}

const envWithKey: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LLM_API_KEY: "test-key-not-a-secret",
  LLM_BASE_URL: "https://llm.example/v1",
  LLM_MODEL: "test-model",
  LLM_TIMEOUT_MS: "1000",
};

describe("sanitizeSoftPreferences", () => {
  it("accepts only soft preference fields", () => {
    const result = sanitizeSoftPreferences({
      fit: "wide",
      cushioning: "max",
      distanceKm: 10,
      size: "UK 9",
      colour: "black",
      maxAmountMinor: 1,
      deliverBy: "sunday",
    });
    expect(result).toEqual({ fit: "wide", cushioning: "max", distanceKm: 10 });
  });

  it("drops invalid enums and clamps distances", () => {
    const result = sanitizeSoftPreferences({ fit: "huge", cushioning: "extra", distanceKm: 999 });
    expect(result).toEqual({ distanceKm: 50 });
  });

  it("rounds non-integer distances into range", () => {
    const result = sanitizeSoftPreferences({ distanceKm: 12.7 });
    expect(result).toEqual({ distanceKm: 13 });
  });

  it("returns null for non-objects", () => {
    expect(sanitizeSoftPreferences(null)).toBeNull();
    expect(sanitizeSoftPreferences("wide")).toBeNull();
    expect(sanitizeSoftPreferences([1, 2])).toBeNull();
  });
});

describe("createLlmProvider extraction", () => {
  it("extracts soft preferences from valid JSON output", async () => {
    const provider = createLlmProvider(envWithKey, {
      fetchFn: fakeFetch({ fit: "wide", cushioning: "balanced", distanceKm: 8 }),
    });
    const result = await provider.extractSoftPreferences("I like wide cushioned shoes");
    expect(result).toEqual({ fit: "wide", cushioning: "balanced", distanceKm: 8 });
  });

  it("falls back to null on malformed JSON", async () => {
    const provider = createLlmProvider(envWithKey, { fetchFn: fakeFetch("not json at all") });
    expect(await provider.extractSoftPreferences("msg")).toBeNull();
  });

  it("falls back to null on HTTP errors", async () => {
    const provider = createLlmProvider(envWithKey, { fetchFn: fakeFetch({}, { status: 500 }) });
    expect(await provider.extractSoftPreferences("msg")).toBeNull();
  });

  it("times out and falls back to null", async () => {
    const hangingFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    const provider = createLlmProvider({ ...envWithKey, LLM_TIMEOUT_MS: "20" }, { fetchFn: hangingFetch });
    const started = Date.now();
    const result = await provider.extractSoftPreferences("msg");
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("never logs the API key or customer message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const leakyFetch = (async () => {
      throw new Error("network broke, key=test-key-not-a-secret, message=I need shoes");
    }) as unknown as typeof fetch;
    const provider = createLlmProvider(envWithKey, { fetchFn: leakyFetch });
    await provider.extractSoftPreferences("I need shoes");
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("test-key-not-a-secret");
    expect(logged).not.toContain("I need shoes");
  });

  it("is disabled without a key and never calls the network", async () => {
    const fetchFn = vi.fn();
    const provider = createLlmProvider({ NODE_ENV: "test" }, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(provider.enabled).toBe(false);
    expect(await provider.extractSoftPreferences("msg")).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("explanation hardening", () => {
  it("passes structured facts only — never product descriptions", () => {
    const adversarial: ExplainInput = {
      message: "buy me shoes",
      matches: [
        {
          name: "RunVista X",
          brand: "RunVista",
          priceText: "₹4299.00",
          score: 90,
          fit: "wide",
          cushioning: "max",
          useCase: "road",
          typicalDistanceKm: 10,
          inStock: true,
          reasons: ["good fit"],
          compromises: [],
        },
      ],
    };
    const payload = JSON.stringify(structuredMatches(adversarial.matches));
    expect(payload).not.toContain("description");
  });

  it("sanitizes prose length and control characters", () => {
    const raw = `line1\u0000\u0007line2 ${"x".repeat(900)}`;
    const result = sanitizeProse(raw);
    expect(result.length).toBeLessThanOrEqual(600);
    expect(result).not.toContain("\u0000");
  });
});

describe("services integration with a stub provider", () => {
  it("merges soft preferences but never hard constraints", async () => {
    const stub: LlmProvider = {
      name: "stub",
      enabled: true,
      extractSoftPreferences: async () => ({ fit: "wide", cushioning: "max" }),
      explainRecommendation: async () => "Based on the structured evidence, the Max Cushion suits wide-fit runners best.",
      interpret: async () => ({ ok: false, reason: "disabled" as const }),
    };
    const { getServices } = await import("../lib/services");
    const services = getServices(
      { NODE_ENV: "test", RAZORPAY_KEY_SECRET: "mock_secret", ENVELOPE_SIGNING_SECRET: "s" },
      { forceMock: true, llm: stub },
    );
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    await services.respond(orderId, "I need black shoes under ₹5,000.");
    await services.respond(orderId, "UK 9");
    const result = await services.respond(orderId, "Road running up to 10K");
    expect(result.kind).toBe("shortlist");
    if (result.kind !== "shortlist") throw new Error("unreachable");
    const events = await services.timeline(orderId);
    expect(events.some((e) => e.type === "llm.soft_preferences_extracted")).toBe(true);
    expect(result.machineSpend).toBeDefined();
    expect(result.message).toContain("structured evidence");
    expect(session.intent.size).toBe("UK 9");
    expect(session.intent.maxAmountMinor).toBe(500_000);
  });

  it("falls back to deterministic messaging when the provider fails", async () => {
    const stub: LlmProvider = {
      name: "failing-stub",
      enabled: true,
      extractSoftPreferences: async () => ({ fit: "wide", cushioning: "max" }),
      explainRecommendation: async () => "Based on the structured evidence, the Max Cushion suits wide-fit runners best.",
      interpret: async () => ({ ok: false, reason: "disabled" as const }),
    };
    const { getServices } = await import("../lib/services");
    const services = getServices(
      { NODE_ENV: "test", RAZORPAY_KEY_SECRET: "mock_secret", ENVELOPE_SIGNING_SECRET: "s" },
      { forceMock: true, llm: stub },
    );
    services.llm.extractSoftPreferences = async () => null;
    services.llm.explainRecommendation = async () => null;
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    await services.respond(orderId, "I need black shoes under ₹5,000.");
    const result = await services.respond(orderId, "UK 9, road");
    expect(result.kind).toBe("shortlist");
    if (result.kind !== "shortlist") throw new Error("unreachable");
    expect(result.message).toContain("Best under the stated evidence");
    const events = await services.timeline(orderId);
    expect(events.some((e) => e.type === "llm.soft_preferences_extracted")).toBe(false);
  });
});
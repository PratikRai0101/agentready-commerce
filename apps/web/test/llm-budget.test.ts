import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createLlmProvider,
  getLlmUsageSnapshot,
  resetLlmUsageSnapshot,
  MAX_INPUT_CHARS_MESSAGE,
  EXPLAIN_MAX_INPUT_CHARS,
  MAX_OUTPUT_TOKENS_INTERPRET,
  MAX_OUTPUT_TOKENS_EXTRACT,
  MAX_OUTPUT_TOKENS_EXPLAIN,
  type LlmProvider,
} from "../lib/llm";
import {
  createBoundedLlmProvider,
  createVerificationRunner,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_MESSAGES,
  GROK_BUILD_01_PRICING,
  INPUT_TOKEN_CEILINGS,
  OUTPUT_TOKEN_CAPS,
  maxSessionCostUsd,
} from "../lib/llm-budget";

afterEach(() => {
  vi.restoreAllMocks();
  resetLlmUsageSnapshot();
});

const envWithKey: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LLM_API_KEY: "test-key-not-a-secret",
  LLM_BASE_URL: "https://llm.example/v1",
  LLM_MODEL: "test-model",
  LLM_TIMEOUT_MS: "1000",
};

function okCompletion(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

describe("provider output-token limits", () => {
  it("sends max_tokens on every LLM path", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return okCompletion("{}");
    }) as unknown as typeof fetch;
    const provider = createLlmProvider(envWithKey, { fetchFn });
    await provider.interpret("UK 9");
    await provider.extractSoftPreferences("wide fit");
    await provider.explainRecommendation({ message: "hi", matches: [] });
    expect(seen).toHaveLength(3);
    expect(seen[0]?.max_tokens).toBe(MAX_OUTPUT_TOKENS_INTERPRET);
    expect(seen[1]?.max_tokens).toBe(MAX_OUTPUT_TOKENS_EXTRACT);
    expect(seen[2]?.max_tokens).toBe(MAX_OUTPUT_TOKENS_EXPLAIN);
  });

  it("bounds input on every LLM path", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return okCompletion("{}");
    }) as unknown as typeof fetch;
    const provider = createLlmProvider(envWithKey, { fetchFn });
    const longMessage = "x".repeat(MAX_INPUT_CHARS_MESSAGE + 500);
    await provider.interpret(longMessage);
    await provider.extractSoftPreferences(longMessage);
    const userContent = (seen[0] as { messages: Array<{ content: string }> }).messages[1]?.content ?? "";
    expect(userContent.length).toBeLessThanOrEqual(MAX_INPUT_CHARS_MESSAGE);
    const extractContent = (seen[1] as { messages: Array<{ content: string }> }).messages[1]?.content ?? "";
    expect(extractContent.length).toBeLessThanOrEqual(`Customer message:\n`.length + MAX_INPUT_CHARS_MESSAGE);

    const bigMatches = Array.from({ length: 20 }, (_, i) => ({
      name: `Shoe ${i} with a very long padded name `.repeat(20),
      brand: "RunVista",
      priceText: "₹4,299.00",
      score: 90,
      fit: "wide",
      cushioning: "max",
      useCase: "road",
      typicalDistanceKm: 10,
      inStock: true,
      reasons: ["reason ".repeat(50)],
      compromises: ["compromise ".repeat(50)],
    }));
    await provider.explainRecommendation({ message: longMessage, matches: bigMatches });
    const explainContent = (seen[2] as { messages: Array<{ content: string }> }).messages[1]?.content ?? "";
    expect(explainContent.length).toBeLessThanOrEqual(EXPLAIN_MAX_INPUT_CHARS);
  });

  it("issues exactly one request per logical call — no automatic retries", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("boom"));
    const provider = createLlmProvider(envWithKey, { fetchFn: fetchFn as unknown as typeof fetch });
    await expect(provider.extractSoftPreferences("wide fit")).resolves.toBeNull();
    await expect(provider.explainRecommendation({ message: "hi", matches: [] })).resolves.toBeNull();
    await expect(provider.interpret("UK 9")).resolves.toEqual({ ok: false, reason: "http" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe("bounded provider", () => {
  function enabledStub(): LlmProvider {
    return {
      name: "stub",
      enabled: true,
      extractSoftPreferences: async () => null,
      explainRecommendation: async () => null,
      interpret: async () => ({ ok: true, value: {} }),
    };
  }

  it("allows maxAttempts calls then falls back without further requests", async () => {
    const inner = enabledStub();
    const interpret = vi.spyOn(inner, "interpret");
    const provider = createBoundedLlmProvider(inner, 3);
    expect(provider.attemptsRemaining()).toBe(3);
    await provider.interpret("a");
    await provider.interpret("b");
    await provider.interpret("c");
    expect(provider.attemptsUsed()).toBe(3);
    expect(provider.attemptsRemaining()).toBe(0);
    const exhausted = await provider.interpret("d");
    expect(exhausted).toEqual({ ok: false, reason: "budget_exhausted" });
    expect(await provider.extractSoftPreferences("d")).toBeNull();
    expect(await provider.explainRecommendation({ message: "d", matches: [] })).toBeNull();
    expect(interpret).toHaveBeenCalledTimes(3);
    expect(provider.attemptsUsed()).toBe(3);
  });

  it("counts failed attempts against the budget", async () => {
    const inner: LlmProvider = {
      name: "stub",
      enabled: true,
      extractSoftPreferences: async () => { throw new Error("fail"); },
      explainRecommendation: async () => null,
      interpret: async () => ({ ok: false, reason: "http" as const }),
    };
    const provider = createBoundedLlmProvider(inner, 1);
    await expect(provider.extractSoftPreferences("x")).rejects.toThrow("fail");
    expect(provider.attemptsRemaining()).toBe(0);
    expect(await provider.extractSoftPreferences("x")).toBeNull();
  });

  it("does not count calls when the inner provider is disabled", async () => {
    const inner: LlmProvider = {
      name: "none",
      enabled: false,
      extractSoftPreferences: async () => null,
      explainRecommendation: async () => null,
      interpret: async () => ({ ok: false, reason: "disabled" as const }),
    };
    const provider = createBoundedLlmProvider(inner, 1);
    expect(await provider.interpret("x")).toEqual({ ok: false, reason: "disabled" });
    expect(provider.attemptsUsed()).toBe(0);
    expect(provider.attemptsRemaining()).toBe(1);
  });
});

describe("verification runner", () => {
  function enabledStub(): LlmProvider {
    return {
      name: "stub",
      enabled: true,
      extractSoftPreferences: async () => null,
      explainRecommendation: async () => null,
      interpret: async () => ({ ok: true, value: {} }),
    };
  }

  it("caps one session at 15 messages over a 45-attempt budget", async () => {
    const runner = createVerificationRunner(enabledStub());
    for (let i = 0; i < DEFAULT_MAX_MESSAGES; i++) {
      expect(runner.beginMessage()).toBe(true);
      // Worst case per message: interpret + extract + explain.
      await runner.provider.interpret(`m${i}`);
      await runner.provider.extractSoftPreferences(`m${i}`);
      await runner.provider.explainRecommendation({ message: `m${i}`, matches: [] });
    }
    expect(runner.beginMessage()).toBe(false);
    expect(runner.usage()).toEqual({ messages: DEFAULT_MAX_MESSAGES, attempts: DEFAULT_MAX_ATTEMPTS, attemptsRemaining: 0 });
  });
});

describe("session cost ceiling", () => {  it("matches the official grok-build-0.1 price list arithmetic", () => {
    const perTurnIn = INPUT_TOKEN_CEILINGS.interpret + INPUT_TOKEN_CEILINGS.extract + INPUT_TOKEN_CEILINGS.explain;
    const perTurnOut = OUTPUT_TOKEN_CAPS.interpret + OUTPUT_TOKEN_CAPS.extract + OUTPUT_TOKEN_CAPS.explain;
    const expected =
      (DEFAULT_MAX_MESSAGES * perTurnIn * GROK_BUILD_01_PRICING.inputPerMillionUsd +
        DEFAULT_MAX_MESSAGES * perTurnOut * GROK_BUILD_01_PRICING.outputPerMillionUsd) /
      1_000_000;
    expect(maxSessionCostUsd()).toBeCloseTo(expected, 10);
  });

  it("stays under ten cents worst case at official pricing", () => {
    expect(maxSessionCostUsd()).toBeLessThan(0.1);
  });
});

describe("usage accounting (measured tokens, no secrets)", () => {
  function usageFetch(promptTokens: number, completionTokens: number) {
    return (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }),
    })) as unknown as typeof fetch;
  }

  it("accumulates prompt/completion tokens across calls", async () => {
    resetLlmUsageSnapshot();
    const provider = createLlmProvider(envWithKey, { fetchFn: usageFetch(800, 120) });
    await provider.interpret("UK 9");
    await provider.extractSoftPreferences("wide fit");
    const snapshot = getLlmUsageSnapshot();
    expect(snapshot.calls).toBe(2);
    expect(snapshot.promptTokens).toBe(1600);
    expect(snapshot.completionTokens).toBe(240);
  });

  it("ignores missing usage without breaking the call", async () => {
    resetLlmUsageSnapshot();
    const provider = createLlmProvider(envWithKey, {
      fetchFn: (async () => okCompletion("{}")) as unknown as typeof fetch,
    });
    await provider.interpret("UK 9");
    expect(getLlmUsageSnapshot()).toEqual({ calls: 1, promptTokens: 0, completionTokens: 0 });
  });

  it("does not accumulate on failed calls", async () => {
    resetLlmUsageSnapshot();
    const provider = createLlmProvider(envWithKey, {
      fetchFn: (async () => { throw new Error("down"); }) as unknown as typeof fetch,
    });
    await provider.extractSoftPreferences("wide fit");
    expect(getLlmUsageSnapshot()).toEqual({ calls: 0, promptTokens: 0, completionTokens: 0 });
  });

  it("shares counters across module instances (route-bundle safe)", async () => {
    // Next.js may evaluate one copy of lib/llm.ts per route bundle in the same
    // process; the counters must still observe every provider instance.
    resetLlmUsageSnapshot();
    const provider = createLlmProvider(envWithKey, { fetchFn: usageFetch(100, 20) });
    await provider.interpret("UK 9");
    expect(getLlmUsageSnapshot().calls).toBe(1);
    vi.resetModules();
    const fresh = await import("../lib/llm");
    expect(fresh.getLlmUsageSnapshot()).toEqual({ calls: 1, promptTokens: 100, completionTokens: 20 });
    fresh.resetLlmUsageSnapshot();
    expect(getLlmUsageSnapshot()).toEqual({ calls: 0, promptTokens: 0, completionTokens: 0 });
  });
});

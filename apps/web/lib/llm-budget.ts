/**
 * Bounded verification runner for LLM spend.
 *
 * One verification session = at most DEFAULT_MAX_MESSAGES user messages and
 * DEFAULT_MAX_ATTEMPTS provider attempts total (15 messages × up to 3 calls
 * per message: interpret + soft-extract + explain). There are no automatic
 * retries anywhere: the provider issues one request per logical call
 * (lib/llm.ts, AbortSignal timeout, no retry loop) and this wrapper counts
 * every attempt — successes and failures alike — against the same budget.
 * Past the budget the wrapper returns deterministic-safe fallbacks so the
 * application continues on its deterministic path with an auditable
 * `budget_exhausted` reason instead of spending more.
 *
 * Cost ceiling: per-call output caps (max_tokens, standard OpenAI-compatible
 * field) bound billed completion tokens, including reasoning tokens where the
 * provider emits them. Input is bounded by fixed system prompts plus explicit
 * character caps. maxSessionCostUsd() turns those code-enforced bounds into a
 * dollar ceiling for a stated price list.
 */
import type { LlmProvider } from "./llm";
import {
  EXPLAIN_MAX_INPUT_CHARS,
  EXPLANATION_SYSTEM,
  EXTRACTION_SYSTEM,
  INTERPRET_SYSTEM,
  MAX_INPUT_CHARS_MESSAGE,
  MAX_OUTPUT_TOKENS_EXPLAIN,
  MAX_OUTPUT_TOKENS_EXTRACT,
  MAX_OUTPUT_TOKENS_INTERPRET,
} from "./llm";

export const DEFAULT_MAX_MESSAGES = 15;
export const DEFAULT_MAX_ATTEMPTS = 45;

/** Conservative tokenizer estimate: overstates token counts, so the cost ceiling stays an upper bound. */
const CHARS_PER_TOKEN = 4;

function inputCeiling(systemPrompt: string, maxUserChars: number): number {
  return Math.ceil((systemPrompt.length + maxUserChars) / CHARS_PER_TOKEN);
}

export const INPUT_TOKEN_CEILINGS = {
  interpret: inputCeiling(INTERPRET_SYSTEM, MAX_INPUT_CHARS_MESSAGE),
  extract: inputCeiling(EXTRACTION_SYSTEM, MAX_INPUT_CHARS_MESSAGE),
  explain: inputCeiling(EXPLANATION_SYSTEM, EXPLAIN_MAX_INPUT_CHARS),
} as const;

export const OUTPUT_TOKEN_CAPS = {
  interpret: MAX_OUTPUT_TOKENS_INTERPRET,
  extract: MAX_OUTPUT_TOKENS_EXTRACT,
  explain: MAX_OUTPUT_TOKENS_EXPLAIN,
} as const;

export type ModelPricing = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

/**
 * Officially listed xAI pricing for grok-build-0.1, sub-200k-token tier
 * (docs.x.ai, verified 2026-09-04; our prompts are single-digit k tokens).
 * Re-verify in console before any spend; pass explicit pricing to
 * maxSessionCostUsd() if it has changed.
 */
export const GROK_BUILD_01_PRICING: ModelPricing = {
  inputPerMillionUsd: 1.0,
  outputPerMillionUsd: 2.0,
};

/**
 * Worst-case session cost: every message triggers all three provider calls,
 * each consuming its full input ceiling and full output cap. Reasoning tokens,
 * where emitted, bill as completion output inside max_tokens and are therefore
 * included in the output caps.
 */
export function maxSessionCostUsd(
  pricing: ModelPricing = GROK_BUILD_01_PRICING,
  messages = DEFAULT_MAX_MESSAGES,
): number {
  const inputPerTurn =
    INPUT_TOKEN_CEILINGS.interpret + INPUT_TOKEN_CEILINGS.extract + INPUT_TOKEN_CEILINGS.explain;
  const outputPerTurn =
    OUTPUT_TOKEN_CAPS.interpret + OUTPUT_TOKEN_CAPS.extract + OUTPUT_TOKEN_CAPS.explain;
  return (
    (messages * inputPerTurn * pricing.inputPerMillionUsd +
      messages * outputPerTurn * pricing.outputPerMillionUsd) /
    1_000_000
  );
}

export type BoundedLlmProvider = LlmProvider & {
  attemptsUsed(): number;
  attemptsRemaining(): number;
};

/**
 * Hard attempt budget around any LlmProvider. A disabled inner provider makes
 * no calls, so nothing is counted. No retries are issued: one logical call is
 * exactly one counted attempt, and exhaustion yields safe fallbacks.
 */
export function createBoundedLlmProvider(
  inner: LlmProvider,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): BoundedLlmProvider {
  let used = 0;
  const consume = (): boolean => {
    if (!inner.enabled) return true;
    if (used >= maxAttempts) return false;
    used += 1;
    return true;
  };
  return {
    name: inner.name,
    enabled: inner.enabled,
    async extractSoftPreferences(message) {
      if (!consume()) return null;
      return inner.extractSoftPreferences(message);
    },
    async explainRecommendation(input) {
      if (!consume()) return null;
      return inner.explainRecommendation(input);
    },
    async interpret(message) {
      if (!consume()) return { ok: false, reason: "budget_exhausted" };
      return inner.interpret(message);
    },
    attemptsUsed: () => used,
    attemptsRemaining: () => Math.max(0, maxAttempts - used),
  };
}

export type VerificationRunner = {
  provider: BoundedLlmProvider;
  /** Returns false once the message cap is reached; the caller must stop. */
  beginMessage(): boolean;
  usage(): { messages: number; attempts: number; attemptsRemaining: number };
};

/** One session: at most maxMessages user messages over a maxAttempts provider budget. */
export function createVerificationRunner(
  inner: LlmProvider,
  limits: { maxMessages?: number; maxAttempts?: number } = {},
): VerificationRunner {
  const maxMessages = limits.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const provider = createBoundedLlmProvider(inner, limits.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  let messages = 0;
  return {
    provider,
    beginMessage() {
      if (messages >= maxMessages) return false;
      messages += 1;
      return true;
    },
    usage: () => ({
      messages,
      attempts: provider.attemptsUsed(),
      attemptsRemaining: provider.attemptsRemaining(),
    }),
  };
}

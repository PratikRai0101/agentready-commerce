# AI-0 — conversation flow audit and baseline

Stage AI-0 of the AI-shopping-agent sprint. No production behaviour changed;
this document records the audit, the deterministic evaluation harness and the
measured baseline, plus the recommended Stage AI-1 schema.

Date: 2026-09-01. Harness: `apps/web/test/ai-conversation-baseline.test.ts`.

## 1. Current conversation flow (as built)

1. `POST /api/respond {orderId, message}` → `services.respond`.
2. `parseIntentMessage` (deterministic regex, `apps/web/lib/intent.ts`) extracts
   size / colour / use-case / budget / returnability / delivery / distance /
   fit / cushioning into `ParsedIntent`.
3. `mergeIntents` last-write-wins merges the new message into the session
   intent (`services.ts`).
4. If an LLM provider is configured, `extractSoftPreferences` may add fit /
   cushioning / distance soft prefs only.
5. `rankProducts` (`packages/catalog/src/ranking.ts`) hard-filters
   (budget, size availability, stock) then scores and returns top 3.
6. Missing `size` or `useCase` → clarify (returns all missing at once).
7. Shortlist → `chooseProduct` → `buildQuote` (envelope) → `approve` → payment.
8. Prepared scenario (`/api/scenario`): hardcoded demo message + fixed
   clarification list replayed through the same `respond` API.

## 2. Concrete limitations (evidence)

### L1 — scores can exceed 100
`evaluate()` in `ranking.ts` adds 35 (use-case) + 10 (fit) + 10 (cushioning) +
12 (distance) + 5 (colour) + 8 (budget) + 6 (delivery) + 4 (returnable) +
`rating*4` (~18) = up to **108**. UI renders `score 108` with no normalization
and no separation of hard eligibility from preference score.

### L2 — scripted prepared scenario
`/api/scenario/route.ts` hardcodes `DEMO_MESSAGE` + `CLARIFICATIONS` and the
client `runScenario` injects the transcript into the UI directly, bypassing
per-turn API responses. It is not a live conversation; it cannot fail,
clarify differently, or adapt.

### L3 — no refinement after quoting
State machine: `buildQuote` → `AWAITING_APPROVAL`. `respond` only accepts
`DRAFT | CLARIFYING | REAPPROVAL_REQUIRED | QUOTED`. Any follow-up ("actually
size 10", "show something cheaper") after a quote errors with "Current state
AWAITING_APPROVAL does not accept new product messages." There is no path back
from quote to refinement before approval.

### L4 — weak follow-up handling
`compare X and Y`, `why this one?`, `show me something cheaper`, `what am I
compromising?`, `why not this?` are not understood. They produce no new
constraints, so `respond` just re-ranks the identical shortlist. There is no
conversational action vocabulary.

### L5 — corrections and negations
- "actually size 10" overwrites size via last-write-wins merge — works by
  accident, no acknowledgement, no history.
- "not black" — the parser matches `black` in "**not black**" and sets
  `colour: black`. The negation is ignored (bug).
- "I don't want gym shoes" — same bug: `useCase: gym` is set.

### L6 — conflicting constraints undetected
"wide fit but narrow last", "max cushioning and minimal weight" — parser takes
first match; no conflict or ambiguity surfaced, no confidence value.

### L7 — "if possible" treated as hard constraint
"black if possible" sets `colour: black` as a hard constraint even though the
phrase signals a soft preference. (Colour only affects scoring today, but the
intent model does not distinguish.)

### L8 — ambiguous distance
"5-10K" matches only `10K` (first numeric pattern with `k`), silently dropping
the 5K lower bound and the range semantics.

### L9 — machine spend has no declared precondition
`runFitScoreSpend` runs whenever `session.intent.fit` is set — no condition
explaining *why* the paid tool is useful, no pre-invocation cost/reason shown.
The mandate does not pre-authorize per-tool spends.

### L10 — clarification asks everything at once
`missingHardConstraints` returns both missing fields and
`composeClarification` asks for both in one message ("I need 2 details").
Spec wants one highest-value question at a time.

### L11 — no "what I understood" summary
Before recommending, the agent never echoes its understanding of constraints
(no constraint chips, no summary). Refinement after shortlist is possible only
because `QUOTED` re-ranks — but nothing communicates what changed.

### L12 — silent exclusions
Out-of-stock sizes and no-match cases (e.g. UK 11) yield `No products satisfy
your constraints` with no explanation of *which* constraint excluded what,
and no offer to relax.

## 3. Evaluation harness

`apps/web/test/ai-conversation-baseline.test.ts` — deterministic, no network.
Measures six metrics across 30 scenarios:

- **Constraint extraction accuracy**: parsed intent vs. ground truth.
- **Grounded recommendation rate**: shortlist matches are real catalog rows
  with stock/budget/size, and every displayed claim is catalog-derived.
- **Useful clarification rate**: asked questions ⊆ genuinely missing hard
  constraints.
- **Hallucinated catalog claims**: count of claims in messages not derivable
  from catalog fields (deterministic path; LLM prompts never receive raw
  catalog prose).
- **Deterministic fallback**: malformed LLM output / timeout / HTTP 500 all
  fall back to the same result as LLM-disabled.
- **Unauthorized payment actions**: zero money actions (initiate/verify/
  fulfil/compensate) succeed without prior approval.

Scenario coverage (30): vague request; multi-constraint messages ×2; size
correction; negation ×2; conflicting constraints; "if possible" softening;
range distance; budget formats; prompt injection in user text and in catalog
description; no matching inventory; out-of-stock size; below-minimum budget;
why/cheaper/compare/compromise follow-ups; refine-after-quote; quote-time
refinement lock; malformed LLM JSON; LLM timeout; LLM HTTP 500; purchase
without approval; fulfil before payment; machine-spend precondition; score
normalization.

## 4. Baseline results (2026-09-01)

| Metric | Baseline | Notes |
|---|---|---|
| Constraint extraction accuracy | **8/10 = 0.80** | "not black" → black; "wide but narrow" → wide; "if possible" → hard |
| Grounded recommendation rate | **1.00** (12/12) | all shortlists cite only catalog facts |
| Useful clarification rate | **1.00** (3/3) | asked ⊆ missing; but multi-question (L10) |
| Hallucinated catalog claims | **0** | deterministic path; LLM never sees catalog prose |
| Deterministic fallback | **1.00** (3/3) | malformed JSON, timeout, HTTP 500 → same result |
| Unauthorized payment actions | **0** | all blocked by policy + state machine |
| Score normalization | **FAIL** | max score 108 > 100 (L1) |
| Refinement after quote | **FAIL** | AWAITING_APPROVAL rejects new messages (L3) |
| Follow-up actions (why/cheaper/compare) | **FAIL** | re-rank identical list, no action (L4) |
| Prepared scenario realism | **FAIL** | hardcoded transcript injected into UI (L2) |
| Machine-spend precondition | **FAIL** | invoked for any fit pref, no reason/cost first (L9) |

Verification: `pnpm -r test` → all pass including the new baseline suite;
`pnpm -r typecheck` clean; `pnpm build` clean.

## 5. Recommended Stage AI-1 schema

Structured advisory output from the LLM (never authoritative):

```ts
type ConversationalAction =
  | "search"      // new or extended search
  | "refine"      // adjust constraints on current context
  | "compare"     // compare specific productIds
  | "explain"     // "why this one?", "what am I compromising?"
  | "select"      // pick a productId for quoting
  | "restart";    // abandon current intent

type AiAdvisory = {
  action: ConversationalAction;
  productIds?: string[];              // requested ids for compare/select
  proposedHard?: {                     // MUST be validated deterministically
    size?: "UK 6" | ... | "UK 11";
    colour?: "black" | "white" | "grey" | "navy" | "blue" | "red";
    useCase?: "road" | "trail" | "gym" | "casual";
    maxAmountMinor?: number;           // 0 < n <= 10_000_000
    mustBeReturnable?: boolean;
    deliverBy?: string;                // ISO date, validated
  };
  proposedSoft?: {
    fit?: "wide" | "narrow" | "standard";
    cushioning?: "max" | "balanced" | "minimal";
    distanceKm?: number;               // 1..50
  };
  removals?: Array<keyof ParsedIntent>; // corrections: "not black" → colour
  ambiguity?: string[];                 // genuinely ambiguous fields
  confidence: "high" | "medium" | "low";
};
```

Rules to enforce deterministically:
- Validators (bounded enums, ranges, ISO dates) approve every proposed hard
  constraint before it enters `PurchaseIntent`; LLM never mutates state.
- Original user evidence (per-turn parsed intent + raw message) is preserved
  for the audit trail; never overwritten silently.
- No credentials, payment data or raw customer PII in prompts.
- Any malformed/timeout/out-of-schema response ⇒ `action: "search"` fallback
  with `confidence: "low"`, identical to the current deterministic path.
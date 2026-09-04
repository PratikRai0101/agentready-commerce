# LLM verification run — 3-message bounded session (evidence record)

Single authorized session. No rerun performed; this file preserves the
completed run's evidence. Uncommitted per instruction.

## Run identity and bounds

| Field | Value |
|---|---|
| Application logical order | `ord_30c52aceaa9a` |
| User messages sent | 3 / 15 cap |
| Provider attempts (max possible) | ≤9 (3 messages × ≤3 single-shot calls, no retries) |
| Model (user-configured, local only) | `openai/gpt-oss-20b` via OpenAI-compatible endpoint |
| Official Groq price (console.groq.com/docs/models) | $0.075 / 1M input, $0.30 / 1M output |
| Calculated worst-case ceiling, this run shape | 7,695 in / 5,100 out tokens → **$0.0022** (below the $0.02 authorization) |
| Rails at pre/mid/post guards | `razorpay:mock`, `x402:mock` throughout |
| Payment initiated | None |
| HTTP 429 observed | None (no abort triggered) |

## Accepted LLM turns — 3/3, zero fallbacks

| Turn | Message | Kind / state | Audit source | Applied / rejected |
|---|---|---|---|---|
| 1 | "I need black shoes under ₹5,000." | clarify / CLARIFYING | `source=llm`, action=refine | 2 / 0 |
| 2 | "UK 9, road running, wide fit, max cushioning, must be returnable" | shortlist / QUOTED | `source=llm`, action=search | 5 / 0 |
| 3 | "Why this one?" | explain / QUOTED | `source=llm`, action=explain | 0 / 0 |

Grounded shortlist (turn 2, catalog-verbatim prices/roles): RunVista Max
Cushion ₹4,899.00 (bestOverall), RunVista Streak 4 ₹4,299.00
(cheaperAlternative), RunVista Stride Lite ₹3,499.00 (tradeoffChoice).
Explanation (turn 3) cites eligibility, score 89/100, and catalog strengths
only. Fallback reasons this run: none (no timeout/http/malformed/disabled).

## Token counts and cost — exact tokens UNAVAILABLE, cost is THEORETICAL CEILING only

- **Exact token counts: unavailable.** No measured per-call token totals exist
  for this run (see application-counter note below), and no dashboard export
  was retrievable from this environment.
- **The $0.0022 figure is a theoretical ceiling, not a measurement.** It is
  derived from code-enforced bounds (per-call `max_tokens` caps × maximum 9
  single-shot attempts) at official Groq list pricing — i.e., the most this
  run shape could possibly have cost, not what it cost. Treat actual spend as
  unknown until confirmed in the provider console.
- **Application-side counters: UNAVAILABLE for this run.** The accumulator
  added beforehand was module-level, and Next.js evaluates separate copies of
  `lib/llm.ts` per route bundle in one process, so `/api/status` read a
  pristine copy while `/api/respond` counted. Fixed prospectively only:
  counters now live on `globalThis` (`apps/web/lib/llm.ts`), pinned by a
  cross-instance regression test (`apps/web/test/llm-budget.test.ts`,
  "shares counters across module instances"). The fix was never exercised
  live; no rerun performed.
- **Provider-dashboard counts: not retrievable from this environment** (no
  console access; credentials never handled here). Fill from the console for
  this run's requests, then apply:
  `cost = prompt_tokens × 0.075/1M + completion_tokens × 0.30/1M`
  (reasoning tokens, if listed separately, bill as completion/output per Groq
  convention and belong in the second term).
- Dashboard fields to record: prompt tokens = ___, completion tokens = ___,
  reasoning tokens (if split out) = ___, billed cost = ___.

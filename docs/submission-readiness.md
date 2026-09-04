# Submission readiness checklist

Frozen storefront scope. Nothing below is committed, published, or merged.
Check each item off with the stated command or artifact immediately before
submission; do not carry forward stale claims.

## Verified (re-run on submission day)

- [ ] Unit suite green: `pnpm --filter @agentready/web test` (last measured: 411 passed / 1 skipped, 20 files, 2026-09-04)
- [ ] Typecheck clean: `pnpm lint`
- [ ] No whitespace errors: `git diff --check`
- [ ] Mock browser smoke: `PORT=31xx node apps/web/test/browser-smoke.mjs` against a mock-env server (last: 38/38 desktop+mobile)
- [ ] Discovery routes live: `GET /api/catalog` and `GET /.well-known/agentready` return 200 on a mock server with `protocolConformance: None claimed`
- [ ] Secrets hygiene: `apps/web/.env.local` ignored + untracked; no secret-value patterns in diffs or logs; `data/proof/` ignored

## Evidence on file (uncommitted working tree unless noted)

- [ ] `docs/evidence/razorpay-test-proof.md` (committed, sanitized): 3 Test Mode checkouts, 2 authenticated webhooks, 1 processed refund
- [ ] `data/proof/razorpay-test-proof.md` (local only, ignored): detailed record — confirm present, never commit
- [ ] `docs/evidence/llm-verification-3msg.md`: 3/3 accepted turns; exact tokens unavailable, $0.0022 is a theoretical ceiling
- [ ] `docs/devnet-settlement-evidence.md`: one harness settlement; app-path Devnet never live; replay offline-only
- [ ] `docs/evidence/mock-lifecycle-recovery.md`: PRESENT / MISSING (mock fulfil-fail → compensate covered by `mock-buyer-client.test.ts`; write the capture only from a real run)

## Still pending (blockers until done)

- [ ] Pitch video (5 min per `docs/demo-and-evaluation.md` script, mock UI, no live payments on camera)
- [ ] Public repository flip + secrets pre-flight (keys stay local; `data/proof/` stays ignored)
- [ ] Provider-console read for the LLM run (prompt/completion/reasoning totals → billed cost via official Groq rates)
- [ ] Any LLM or Devnet re-run needs fresh explicit approval (single-session rule)

## Standing non-claims (must survive into the submission)

- No UCP/AP2/MCP conformance; descriptor is project-specific by design.
- Conformance suite verifies declared invariants only — no security certification.
- UPI Reserve Pay out of scope without official access; no Vulcan usage claimed.
- Catalog is synthetic demo data for a fictional merchant.
- Test-mode evidence is local-only; clean clones run the mock rail by default.

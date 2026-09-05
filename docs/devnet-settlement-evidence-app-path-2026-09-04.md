# Devnet settlement evidence — application path (one-shot, no retry)

> One x402 v2 exact settlement submitted through the real Next route.
> Exactly one on-chain transfer verified read-only. No second submission,
> no retry, no Razorpay payment, no Mainnet activity.

Recorded 2026-09-04. Sanitized: public chain data and application
identifiers only. No signed payload, private key, keypair content,
credential, or secret is stored here.

## Request (application path)

| Field | Value |
|---|---|
| Route | `POST /api/resources/premium-fit-score` (real Next server, port 32110) |
| Session | `ord_ec64c3682612` (via `POST /api/session`) |
| Intent version | `0` |
| Request digest | `6826a0b9ad9a1e081c138d64b85cf38d84048604901cb506c8d5174e8b707e2c` |
| Payment identifier | `pay_appath_1788535423482` (fresh, never used before) |
| Operation id (DB) | `e63bdf78d994b7d41d7ef5cad8897c4438be966b6673147cc4e5997bb73cb022` |
| Quote | HTTP 402 + `PAYMENT-REQUIRED` (no submission) |
| Submissions | Exactly one `accept` POST with `PAYMENT-SIGNATURE` |

## Settlement (verified read-only from Solana RPC, finalized)

| Field | Value |
|---|---|
| x402 flow | v2 `exact` |
| Network | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Devnet) |
| Asset | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Devnet USDC) |
| Amount | `10000` atomic units (`0.010000 USDC`) |
| Payer | `4aCDfCtWrrVA74n8z8XDeKSHq2ddD95E68SHno5Y4Ap5` |
| Payee | `FF6Uj3ff6tp9smbCqfvJyBTrmef8ketsm3x8v1QPTrZ1` |
| Transaction signature | `5FQb8Jh7LTmwoecXpv7TGDos61oFqo66T74uYY6mA6cWuD2EaHTQ73FsY2EZ99Wsj7j3SknsT4WE8vDmGxtt1Vfk` |
| Explorer | [Devnet transaction](https://explorer.solana.com/tx/5FQb8Jh7LTmwoecXpv7TGDos61oFqo66T74uYY6mA6cWuD2EaHTQ73FsY2EZ99Wsj7j3SknsT4WE8vDmGxtt1Vfk?cluster=devnet) |
| Slot / confirmation | `493082743` / `finalized`; `meta.err` is `null` |
| Network fee | `10001` lamports |

Confirmed transferChecked instruction:

- Source token account `pvh2TYBKCVgjPuXXz1z7476xH6zKctsimM3SsZV6iBM` (owner: payer)
- Destination token account `DibQTwZMvbFYSdfUtGupXJugmK4UsBXBy4zbiAe92aNC` (owner: payee)
- Mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, amount `10000`
- Memo program: exact `agentcart:v1:6826a0b9ad9a1e081c138d64b85cf38d84048604901cb506c8d5174e8b707e2c`

## Balances (exactly one transfer, no second charge)

| Account | Before this run | After | Change |
|---|---|---:|---:|
| Payer USDC | `19.990000` | `19.980000` | `-0.010000` |
| Payee USDC | `20.010000` | `20.020000` | `+0.010000` |

## Application result — reconciled (no retry, no resubmission)

- The single `accept` call returned HTTP 500 (`internal_error`).
  No second call was made.
- Operator incident reconciliation completed via
  `node packages/payments/operator-cli.mjs reconcile-settled`
  (operator credential, strict TLS, read-only `getTransaction` inspection;
  no settlement submitted, no resource-route call):
  - Cited `--slot 493082743` matched the chain slot exactly.
  - On-chain validation passed: finalized, `meta.err` null, exact memo
    `agentcart:v1:6826a0b9…`, exactly one `transferChecked` of `10000`
    Devnet USDC from payer to payee.
  - Database attempt `e63bdf78…` transitioned `settling → settled`
    (trigger `operator-reconcile`), persisting the signature and full
    settlement evidence (`memoVerification`/`transferVerification`
    `verified`, `settlementResult` `reconciled`, explorer URL).
  - History is now 4 rows: `accept-intake`, `claim-blockhash`,
    `verify-passed`, `operator-reconcile`. Exactly one row exists for the
    payment identifier; table-wide status is now `settled: 1`.
- Re-queried payer signatures after reconciliation: latest is still
  `5FQb8Jh7…` — zero replacement submissions.
- Application audit for `ord_ec64c3682612` contains only
  `session.created`. The machine-resource route writes no audit event;
  the durable `x402_reconciliation_history` rows above are the audit
  trail for this path (same gap as the earlier harness run).
- Follow-up remediation is covered in the current code: the machine-resource
  route now records redacted `machine.spend_pending`,
  `machine.spend_manual_reconciliation`, `machine.spend_failed` or
  `machine.paid_resource` events, with request/payment/transaction references
  only. This historical order was not replayed to backfill the in-memory audit
  timeline, per the no-retry/no-route-call constraint.

## Safety record

- TLS `verify-full` with Supabase Root 2021 CA (`NODE_EXTRA_CA_CERTS`,
  set before Node started) for both `x402_app` and `x402_operator`;
  `rejectUnauthorized: true` everywhere; no bypass.
- `X402_SETTLEMENT_ENABLED` stayed `false` in `apps/web/.env.local`;
  `true` existed only as a process override for the stopped server.
- Razorpay rail untouched (test keys present, no `/api/pay/*` call).
- No Mainnet configuration or activity.
- No commit, push, or merge performed for this run.

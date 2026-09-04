# Devnet settlement evidence

> Devnet settlement verified; replay covered offline only.

Recorded on 2026-09-02. This is a sanitized record of one approved Solana
Devnet x402 v2 exact settlement. It contains public chain evidence only. No
private key, seed phrase, keypair JSON, environment contents or encoded signed
payload is stored here.

## Live settlement

| Field | Value |
|---|---|
| Payment identifier | `pay_live_replay_1788358877805` |
| Request digest | `fbbb0958f7c9057c5f54697fdfc4b4baf4986f1d3ff96b673f09b318b8575d99` |
| x402 flow | v2 `exact` |
| Network | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Devnet) |
| Asset | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Devnet USDC) |
| Amount | `10000` atomic units (`0.010000 USDC`) |
| Payer | `4aCDfCtWrrVA74n8z8XDeKSHq2ddD95E68SHno5Y4Ap5` |
| Payee | `FF6Uj3ff6tp9smbCqfvJyBTrmef8ketsm3x8v1QPTrZ1` |
| Facilitator fee payer | `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5` |
| Transaction signature | `9Z795iRrqkymKipM3XTY7q3gY7FZ2qvUFQKisnewPmhKH3opqzyVq2gmyPxrrJ8ez2KxSDHdXvJ8qeqkKKZi4JM` |
| Explorer | [Devnet transaction](https://explorer.solana.com/tx/9Z795iRrqkymKipM3XTY7q3gY7FZ2qvUFQKisnewPmhKH3opqzyVq2gmyPxrrJ8ez2KxSDHdXvJ8qeqkKKZi4JM?cluster=devnet) |
| Confirmation | `finalized`; `meta.err` is `null`; slot `492017649` |
| Network fee | `10001` lamports |

The confirmed transaction contains exactly the expected `transferChecked`
instruction:

- Source token account: `pvh2TYBKCVgjPuXXz1z7476xH6zKctsimM3SsZV6iBM`
- Destination token account: `DibQTwZMvbFYSdfUtGupXJugmK4UsBXBy4zbiAe92aNC`
- Mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Amount: `10000` atomic units
- Authority/payer: `4aCDfCtWrrVA74n8z8XDeKSHq2ddD95E68SHno5Y4Ap5`
- Recipient/payee: `FF6Uj3ff6tp9smbCqfvJyBTrmef8ketsm3x8v1QPTrZ1`

The Memo program instruction contains the exact request-bound memo:

```text
agentcart:v1:fbbb0958f7c9057c5f54697fdfc4b4baf4986f1d3ff96b673f09b318b8575d99
```

The live harness observed one facilitator `/verify` call and one `/settle`
call. The settlement returned HTTP 200 and a transaction signature. The first
application inspection ran before the transaction was queryable and reported
`memoVerification: unavailable` and `transferVerification: unavailable`.
Independent finalized RPC inspection later verified both fields above.

## Balance evidence

| Account | Before | After | Change |
|---|---:|---:|---:|
| Payer USDC | `20.000000` | `19.990000` | `-0.010000` |
| Payee USDC | `20.000000` | `20.010000` | `+0.010000` |
| Facilitator fee payer SOL | `4.523529806` | `4.523519805` | `-10001` lamports |
| Facilitator fee payer USDC | `0.781000` | `0.781000` | unchanged |
| Payer SOL | `0.000000000` | `0.000000000` | unchanged |
| Payee SOL | `0.000000000` | `0.000000000` | unchanged |

The final read-only balance query matched the recorded after values. No second
USDC movement was observed.

## Reconciliation and replay answer

The settled chain transaction can be reconciled without signing or settling
again: its finalized signature, exact transfer, memo, payer, payee, mint and
amount are independently queryable from Solana RPC.

The original application payment record from this run cannot currently be
replayed through the application's cached-replay path without signing or
settling again. The live run used a temporary direct `DevnetMachineResource`
harness rather than `prepareDevnetMachineSpend`, `runDevnetMachineSpend`, the
Next route, or `getServices`. As a result, it did not create a `Session` with
`machineSpendAttempt`, a `machineSpend` record, or an audit-ledger event.

The normal application path retains `paymentIdentifier`, `requestDigest`, the
trusted spending request and `signedAttempt` before HTTP submission, but those
records are currently process-local. The relevant `Map` instances in
`apps/web/lib/machine.ts`, `apps/web/lib/services.ts`, and
`DevnetMachineResource` are not durable storage.

## Lost process-local state

- The temporary resource's `processed`, `pending` and `indeterminate` maps were lost when the live test process exited after the initial evidence race.
- The exact base64url `encodedPayment` was not written to disk or to an application session record.
- The live harness did not persist a `Session.machineSpendAttempt`, `Session.machineSpend`, or audit event.
- The raw transaction can be retrieved from chain, but it is not a replacement for the missing application signed-attempt record.

The exact recovered signed transaction was checked with facilitator `/verify`
only after the process ended. It returned `isValid: false` with
`transaction_simulation_failed` and `BlockhashNotFound`, because the original
recent blockhash had expired. No `/settle` call was made during that check.
Creating a new valid payload would require signing again; calling settlement
again would be a new settlement attempt. Neither was done.

Replay coverage therefore remains offline only. Existing tests cover the
same-payload cached result and one-settlement behavior, including the latest
temporary-evidence reconciliation case. They do not claim a live replay for
this transaction.

## Pending review

The pending-reconciliation behavior (return pending, retain the attempt, settle
exactly once, reconcile the original on retry) is present in the working tree
(`packages/payments/src/devnet-machine.ts`: `completeSettlement`,
`rememberIndeterminate`, indeterminate retry path) and is now pinned by offline
stub tests with no external calls (`apps/web/test/x402-devnet.test.ts`,
"verification failure never settles (offline stubs)": failed verification →
402 with zero settle calls; settle-transport failure → manual with one settle
call; ambiguous settlement → pending with one settle call across retries).
This work is uncommitted per the no-commit instruction. Replay coverage remains
offline only as described above, and no new settlement was created for these
tests.

Razorpay code and configuration were not changed by the live run. No additional
payment will be created for this evidence record.

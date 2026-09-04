# Solana Devnet preflight

This runbook separates read-only checks from live actions. Do not run the
wallet-creation, funding, or live-test commands until the owner has explicitly
approved them in this conversation.

Never paste a private key, seed phrase, keypair JSON, `.env.local` contents, or
an environment dump into chat, tickets, logs, screenshots, or blockchain
metadata. The application accepts a path to a local Solana CLI keypair; it does
not need the private key in an environment variable.

## Integration values

The current Devnet implementation uses:

| Field | Value |
|---|---|
| x402 flow | v2 `exact` |
| Network | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana Devnet) |
| Token mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Devnet USDC) |
| Amount | `10000` atomic units = `0.010000 USDC` |
| Facilitator | `https://x402.org/facilitator` |
| Resource | `/api/resources/premium-fit-score` |

`X402_AMOUNT_MINOR` may override the amount. The live run must print and
confirm the effective value before proceeding.

## Read-only preflight

Run these checks without starting the application in Devnet mode:

1. Confirm that `apps/web/.env.local` exists, is ignored by Git, and has
   restrictive permissions. Do not print the file.

   ```bash
   test -f apps/web/.env.local
   git check-ignore -v -- apps/web/.env.local
   stat -f '%Sp %z' apps/web/.env.local
   ```

2. Query facilitator capabilities. This is a GET request and does not verify,
   settle, or submit a payment.

   ```bash
   curl --fail --silent --show-error \
     https://x402.org/facilitator/supported
   ```

   Confirm that the response advertises x402 v2, `exact`, the Devnet CAIP-2
   network above, and a Solana `feePayer`. The facilitator fee payer is not the
   merchant payee and must not be copied into `X402_PAYEE_PUBLIC_KEY`.

3. Check the RPC and token mint without a wallet or transaction.

   ```bash
   RPC_URL=https://api.devnet.solana.com
   curl --fail --silent --show-error "$RPC_URL" \
     -H 'Content-Type: application/json' \
     --data-raw '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   curl --fail --silent --show-error "$RPC_URL" \
     -H 'Content-Type: application/json' \
     --data-raw '{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]}'
   ```

   Confirm RPC health is `ok` and the mint has 6 decimals.

4. If a payer keypair already exists, inspect it without printing its contents.
   `solana address` emits only the public address. Do not run a command that
   prints the JSON file or seed phrase.

   ```bash
   solana address -k "$X402_PAYER_KEYPAIR_PATH"
   stat -f '%Sp %z' "$X402_PAYER_KEYPAIR_PATH"
   solana balance "$PAYER_PUBLIC_KEY" --url devnet
   spl-token accounts --owner "$PAYER_PUBLIC_KEY" --url devnet
   spl-token balance \
     4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
     --owner "$PAYER_PUBLIC_KEY" --url devnet
   ```

   The source associated token account must hold at least `10000` atomic
   units. The exact x402 charge is `0.010000 USDC`; SOL is not a substitute
   for USDC. The facilitator advertises a fee payer for network fees, but the
   final quote remains authoritative.

## Required configuration

After the read-only checks, the intended Devnet configuration is kept only in
the local, ignored `apps/web/.env.local`:

```dotenv
X402_MODE=devnet
X402_PAYER_KEYPAIR_PATH=/absolute/path/outside-this-repository/devnet-burner-keypair.json
X402_PAYEE_PUBLIC_KEY=<payee-public-address-only>
X402_FACILITATOR_URL=https://x402.org/facilitator
X402_SOLANA_RPC_URL=https://api.devnet.solana.com
X402_DEVNET_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
X402_AMOUNT_MINOR=10000
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

The payer keypair must be a dedicated Devnet-only burner. Solana CLI keypair
files are JSON arrays of 32 or 64 bytes. Keep the file outside the repository,
use filesystem mode `600`, and never send it to another person or service.
`X402_PAYEE_PUBLIC_KEY` must be the intended recipient's public address only.
The payee's associated USDC account must be ready before settlement.

The current repository check found no payer keypair path or payee address, and
the local mode is still `mock`. It also found that the `solana` and `spl-token`
CLIs are not installed. No wallet balance was queried because no payer address
is configured.

## Approval boundary

Stop after the read-only preflight. Approval must explicitly cover:

- Installing or using wallet tooling, if needed.
- Creating a new Devnet burner keypair.
- Funding the payer with Devnet SOL and/or Devnet USDC.
- Setting `X402_MODE=devnet` for the live run.
- Submitting one x402 payment and replaying the same signed attempt.

Approval to inspect configuration is not approval to fund or submit.

## Post-approval evidence plan

Only after explicit approval:

1. Create or use the dedicated burner and derive its public address locally.
   Keep any seed phrase in the local terminal or password manager; never paste
   it into chat.
2. Confirm the payer public address, payee public address, mint, network, and
   exact amount again. Fund only through an approved Devnet source.
3. Run the env-gated live test with `X402_LIVE_DEVNET_TEST=1`. The live path
   must produce a verified x402 v2 settlement for the premium resource.
4. Capture only safe evidence: payment identifier, transaction signature,
   Devnet Explorer URL, verified payer/payee/mint/amount, memo
   `agentcart:v1:{requestDigest}`, and the application settlement evidence.
5. Replay the same payment identifier, request digest, and signed payment.
   Confirm the application returns the cached result and that no second
   settlement submission occurs.

Razorpay Checkout, its credentials, and its verification path remain unchanged.

## Recorded settlement

The approved Devnet run is preserved in
[`devnet-settlement-evidence.md`](./devnet-settlement-evidence.md). It records
the finalized transaction and explicitly distinguishes live settlement from
offline-only replay coverage.

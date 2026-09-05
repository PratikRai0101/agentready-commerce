# Public demo preflight — safe demonstration mode (mocks only)

Date: 2026-09-05. Base: `main` at `3536fbd`. No deployment performed yet:
Vercel authentication is pending with the requester, so there is no public
URL. All checks below ran against a local production build (`next start`)
with the exact safe-demo posture intended for the public host.

## 1. Hosting preflight

- Existing provider: none. No `vercel.json`, Netlify, Railway, Fly, Docker,
  or other hosting config exists in the repo.
- Target (requester-confirmed): Vercel — smallest suitable target for this
  Next.js monorepo app (`apps/web`, `next build` clean, no DB required in
  mock mode).
- Prepared artifact (uncommitted): root `vercel.json` with framework
  `nextjs`, frozen `pnpm install`, `pnpm --filter @agentready/web build`,
  output `apps/web/.next`. Contains no secrets.
- Known demo limitation: sessions live in a per-instance in-memory store
  (`globalThis` singleton in `apps/web/lib/services.ts`). A low-traffic
  public demo is fine; if horizontally scaled, a visitor may rarely see an
  unknown-session error and should reload. No mitigation applied — changing
  session storage is out of scope for this task.

## 2. Environment posture for the public host (names only, no values)

Set in the Vercel project dashboard (never committed):

- `ENVELOPE_SIGNING_SECRET` — fresh random value per environment
  (generate locally, paste into dashboard; nothing generated or printed here).
- `RAZORPAY_KEY_ID` — empty (mock adapter; Test Mode only, never live keys).
- `RAZORPAY_KEY_SECRET` — empty (mock adapter).
- `RAZORPAY_WEBHOOK_SECRET` — placeholder; no webhook delivery configured.
- `X402_MODE` — `mock`.
- `X402_SETTLEMENT_ENABLED` — `false` (kill-switch on).
- `X402_LIVE_DEVNET_TEST` — `0` (codebase name; there is no plural
  `X402_LIVE_DEVNET_TESTS` variable).
- `LLM_API_KEY` — empty (fully deterministic fallback).
- `NEXT_PUBLIC_APP_URL` — public URL; set after first deploy, then redeploy.

Explicitly NOT set on the web host: `DATABASE_URL`, `X402_APP_DATABASE_URL`,
`X402_STORE_ENC_KEY`, `X402_PAYER_KEYPAIR_PATH`, `X402_PAYEE_PUBLIC_KEY`
(no operator credential, no chain keypair, no Mainnet configuration).

## 3. Local rehearsal evidence (sanitized, no secrets or raw ids)

Production server started locally with the posture above
(`AGENTREADY_RUN_NONCE=preflight-local`, disposable `mock_secret` /
`smoke-test-secret` placeholders only).

- `GET /api/status` → 200; `indicators: {razorpay: mock, x402: mock,
  llm: disabled}`; `rails: [razorpay_checkout isMock=true]`;
  `envelopeSigning: mock`; run nonce present and matching.
- `GET /.well-known/agentready` → 200; discovery doc with mock modes,
  catalog path, session/respond/quote/approve/pay/verify/audit routes.
- `GET /api/catalog` → 200; 6 products (Streak 4, Max Cushion, Stride Lite,
  Trail Rock, Gym Pace, Everyday).
- `GET /` → 200 (~8.8kB); composer present.
- `GET /ledger-prototype` → 200 (~58.7kB); MOCK banner present.
- Browser smoke, main storefront (desktop 1280x800 + mobile 390x844):
  44/44 passed — session, mock indicators, nonce match, shortlist, quote,
  approve, budget-edit invalidation with audit preserved, re-approve, mock
  initiation (`order_MOCK_*`), mock completion (`pay_MOCK_*`), fulfil
  receipt with total, drawer audit, zero external egress.
- Browser smoke, `/ledger-prototype` (desktop + mobile views): 20/20
  passed — MOCK banner, hero, mock badge, Pay disabled throughout, audit
  5→6→5, zero `/api/pay` calls, zero external egress.

Rehearsal server stopped after the run. No payment, settlement, Devnet
transaction, migration, or destructive operation was performed at any point.

## 5. Production deployment record (sanitized, no secrets or raw ids)

- Project: `agentready-commerce` (`pratikrai0101s-projects`), Root Directory
  `apps/web` with outside-root sources included (requester-set).
- Attempt history: (1) repo-root build failed in ~20s on Next.js framework
  detection (`next` lives in `apps/web`); Error state, never live.
  (2) after the Root Directory fix, the Next.js build succeeded but the
  deploy failed on Output Directory resolution (`apps/web/.next`
  double-resolved against the new root). (3) one-line config fix
  (`outputDirectory` → `.next`, resolving against Root Directory
  `apps/web`; committed `vercel.json` on `main` still carries the old
  value — follow-up PR pending) → **Ready**.
- Live deployment host: `agentready-commerce-cnomz9yd3-…vercel.app`;
  production alias: `https://agentready-commerce-pied.vercel.app`
  (verified public). The default project domain currently requires Vercel
  login (302 → SSO), so the `-pied` alias is the public demo URL.
- Env verification (`vercel env ls`, names only): six Production variables
  present — `ENVELOPE_SIGNING_SECRET`, `RAZORPAY_WEBHOOK_SECRET`,
  `X402_MODE`, `X402_SETTLEMENT_ENABLED`, `X402_LIVE_DEVNET_TEST`
  (singular), `NEXT_PUBLIC_APP_URL`. Values hidden, never read. Absent
  (safe defaults: mock adapter, deterministic LLM): `RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, `LLM_API_KEY`; no `DATABASE_URL` family, no
  keypair paths. No environment variable was changed by this task.
- Production endpoint checks (public alias): `/` 200, `/ledger-prototype`
  200, `/api/status` 200 (`razorpay: mock`, `x402: mock`, `llm: disabled`,
  mock adapter, mock envelope signing), `/.well-known/agentready` 200
  (mock modes), `/api/catalog` 200 (6 products).
- Public browser smoke: storefront 42/42 (desktop + mobile; nonce checks
  skipped — public host carries no run nonce by design), prototype 20/20;
  all ids `order_MOCK_*` / `pay_MOCK_*`, zero external egress.
- Deployment log inspection (sanitized): build-only lines, status Ready;
  single `@solana/kit` mention is dependency installation, not an RPC call;
  only external host referenced is a docs link; secret-pattern scan clean.
  No payment, settlement, Devnet/Mainnet transaction, migration,
  Razorpay/Solana API call, or production-mode activation performed.

## 4. Requester handoff (deployment still requires requester login)

1. `npm i -g vercel && vercel login`, then `vercel link` at the repo root.
2. In the Vercel dashboard, set exactly the variable names in §2.
3. `vercel --prod` (or `vercel deploy --prod`); set `NEXT_PUBLIC_APP_URL`
   to the issued URL and redeploy once.
4. Re-run read-only checks against the public URL: `/api/status`
   (indicators all mock/disabled), `/api/catalog` (6 products),
   `/.well-known/agentready`, `/` and `/ledger-prototype` smoke suites via
   `APP_URL=<public-url> pnpm --filter @agentready/web smoke:storefront`
   and `... smoke:prototype` (mock env, no payment submission).

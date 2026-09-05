// Reproducible browser smoke test — RunVista main storefront (desktop + mobile).
//
// Covers the current Two-column shop flow after the Decision Ledger split:
// ambiguous request → shortlist → select → approve → budget-edit
// invalidation (approval reset + audit preserved) → re-approve → mocked
// initiation (PAYMENT_PENDING) → mocked completion (payment verified) →
// fulfil via UI (FULFILLED receipt with total + verified payment id).
//
// MOCKS ONLY. No real payment: run the app with empty Razorpay credentials so
// the mock adapter serves /api/pay/* locally, and this script aborts any
// request to Razorpay/Solana hosts (failing the run if one is attempted).
// Run with X402_MODE=mock and X402_SETTLEMENT_ENABLED=false (settlement
// kill-switch on — no Devnet/Mainnet transaction is attempted).
//
// Prerequisites: `npx playwright install chromium` (once).
//
// Run:
//   RAZORPAY_KEY_ID="" RAZORPAY_KEY_SECRET="" \
//     RAZORPAY_WEBHOOK_SECRET="mock_secret" \
//     ENVELOPE_SIGNING_SECRET="smoke-test-secret" X402_MODE="mock" \
//     X402_SETTLEMENT_ENABLED="false" AGENTREADY_RUN_NONCE="<nonce>" \
//     pnpm dev --port 3101 &
//   APP_URL=http://localhost:3101 PORT=3101 AGENTREADY_RUN_NONCE="<nonce>" \
//     node test/browser-smoke.mjs
//
// Exit code is 0 when every check passes on both viewports.

import { chromium } from '@playwright/test';

const BASE = process.env.APP_URL || `http://localhost:${process.env.PORT || 3101}`;
const EXPECTED_NONCE = process.env.AGENTREADY_RUN_NONCE || null;
const results = [];

// Mirrors maskId() in apps/web/app/page.tsx: ids longer than 12 chars render
// as first6 + "…" + last4 (raw mock prefixes never appear verbatim in UI).
function maskId(id) {
  if (!id) return '';
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function sendMessage(page, text) {
  await page.locator('.composer-input').fill(text);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/respond') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
    page.locator('.composer-send').click(),
  ]);
  await page.locator('.composer-send').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function getHero(page) {
  const name = ((await page.locator('.product-card-name').first().textContent().catch(() => '')) || '').trim();
  const price = ((await page.locator('.product-card-price').first().textContent().catch(() => '')) || '').trim();
  return { name, price };
}

async function getBudgetLabel(page) {
  const labels = await page.locator('.intent-chip-label').allTextContents().catch(() => []);
  const hit = (labels || []).find((t) => t.includes('Max'));
  return hit ? hit.trim() : null;
}

async function fetchTimeline(page, orderId) {
  return page.evaluate(async (oid) => {
    const r = await fetch(`/api/audit?orderId=${oid}`);
    const j = await r.json();
    return j.events || [];
  }, orderId);
}

async function approveNow(page) {
  const btn = page.locator('button:has-text("Approve exact envelope hash")').first();
  if ((await btn.count()) === 0) return false;
  if (!(await btn.isVisible().catch(() => false))) return false;
  if (await btn.isDisabled().catch(() => true)) return false;
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/approve'), { timeout: 10000 }).catch(() => null),
    btn.click(),
  ]);
  await page.waitForTimeout(800);
  return true;
}

async function selectFirstProduct(page) {
  const btn = page.locator('.product-card-select').first();
  await btn.waitFor({ state: 'visible', timeout: 20000 });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/quote'), { timeout: 10000 }).catch(() => null),
    btn.click(),
  ]);
  await page.locator('button:has-text("Approve exact envelope hash")').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
}

// Budget edit via intent-chip UI with Enter — asserts the editor closes.
async function editBudget(page, newValue) {
  const labelBtn = page.locator('.intent-chip-label', { hasText: 'Max' }).first();
  if ((await labelBtn.count()) === 0) return false;
  await labelBtn.click();
  const input = page.locator('.intent-chip-input').first();
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill(newValue);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/intent-patch'), { timeout: 10000 }).catch(() => null),
    input.press('Enter'),
  ]);
  await page.waitForTimeout(1200);
  return true;
}

async function runViewport(label, viewport) {
  console.log(`\n===== ${label} (${viewport.width}x${viewport.height}) =====`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  let mockOrderId = '';
  let mockPaymentId = '';
  const blockedExternal = [];

  for (const pattern of [/.*razorpay\.com.*/, /.*checkout\.razorpay.*/, /.*(solana|helius).*/]) {
    await page.route(pattern, async (route) => {
      const url = route.request().url();
      if (url.includes('localhost') || url.includes('127.0.0.1')) return route.continue();
      blockedExternal.push(url);
      await route.abort('blockedbyclient');
    });
  }

  const sessionRespPromise = page
    .waitForResponse((r) => r.url().includes('/api/session') && r.request().method() === 'POST', { timeout: 20000 })
    .catch(() => null);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const sessionResp = await sessionRespPromise;
  let oid = null;
  try {
    oid = (await sessionResp?.json())?.orderId || null;
  } catch {}
  check(`${label}: session created`, !!oid, oid || 'no orderId');

  await page.locator('.composer-input').waitFor({ state: 'visible', timeout: 20000 });
  const status = await page.evaluate(async () => (await fetch('/api/status')).json()).catch(() => null);
  await page.waitForTimeout(500);

  check(
    `${label}: indicators mock (razorpay+x402)`,
    !!status && status.indicators?.razorpay === 'mock' && status.indicators?.x402 === 'mock',
    JSON.stringify(status?.indicators),
  );
  if (EXPECTED_NONCE) {
    check(`${label}: talking to launched server (run nonce)`, status?.runNonce === EXPECTED_NONCE, `nonce=${status?.runNonce}`);
  }
  check(
    `${label}: settlement kill-switch on (no live settlement)`,
    status?.indicators?.x402 === 'mock',
    `x402=${status?.indicators?.x402}`,
  );

  await sendMessage(page, 'I need black shoes under ₹5,000.');
  await sendMessage(page, 'UK 9');
  await sendMessage(page, 'road running');
  await page.locator('.product-card').first().waitFor({ state: 'visible', timeout: 20000 });
  const hero5000 = await getHero(page);
  check(`${label}: shortlist under ₹5,000`, !!hero5000.name, `${hero5000.name} ${hero5000.price}`);

  await selectFirstProduct(page);
  const reviewVisible = (await page.locator('text=Order review').count()) > 0;
  check(`${label}: quote prepared (order review visible)`, reviewVisible, '');
  const approved1 = await approveNow(page);
  const payBtn = page.locator('button:has-text("Pay with Razorpay")').first();
  const payVisible = (await payBtn.count()) > 0 && (await payBtn.isVisible().catch(() => false));
  check(`${label}: approve binds envelope (pay offered)`, approved1 && payVisible, '');
  const timeline1 = oid ? await fetchTimeline(page, oid) : [];
  check(
    `${label}: audit records approval`,
    timeline1.filter((e) => e.type === 'approval.granted').length >= 1,
    `events=${timeline1.length}`,
  );

  // Material edit: editor must close, recs update, approval resets.
  await editBudget(page, 'Max ₹3,000');
  const stillEditing = await page.locator('.intent-chip-input').count().catch(() => 0);
  const budget3000 = await getBudgetLabel(page);
  const hero3000 = await getHero(page);
  const approveGone = (await page.locator('button:has-text("Approve exact envelope hash")').count()) === 0;
  const timeline2 = oid ? await fetchTimeline(page, oid) : [];
  check(`${label}: editor closes after save`, stillEditing === 0 && !!budget3000 && budget3000.includes('3,000'), `inputs=${stillEditing} budget=${budget3000}`);
  check(`${label}: recommendations update (5000→3000)`, !!hero3000.name && hero3000.name !== hero5000.name, `${hero5000.name} → ${hero3000.name} ${hero3000.price}`);
  check(`${label}: approval resets after material edit`, approveGone, '');
  check(
    `${label}: audit preserves approval history + invalidation`,
    timeline2.length >= timeline1.length &&
      timeline2.filter((e) => e.type === 'approval.granted').length >= 1 &&
      timeline2.filter((e) => e.type === 'quote.invalidated').length >= 1,
    `events ${timeline1.length}→${timeline2.length}`,
  );

  // Re-approve and initiate mocked payment.
  await selectFirstProduct(page);
  const approved2 = await approveNow(page);
  check(`${label}: re-approve updated order`, approved2, '');
  const payBtn2 = page.locator('button:has-text("Pay with Razorpay")').first();
  const [initiateResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/pay/initiate'), { timeout: 10000 }).catch(() => null),
    payBtn2.click(),
  ]);
  try {
    mockOrderId = (await initiateResp?.json())?.attempt?.externalOrderId || '';
  } catch {}
  await page.waitForTimeout(800);
  const completeBtn = page.locator('button:has-text("Complete test payment")').first();
  const completeReady = (await completeBtn.count()) > 0 && (await completeBtn.isVisible().catch(() => false)) && !(await completeBtn.isDisabled().catch(() => true));
  check(`${label}: initiation is mock order`, mockOrderId.startsWith('order_MOCK_'), mockOrderId);
  check(`${label}: mock completion action exposed`, completeReady, '');

  // Complete mocked payment → payment verified panel.
  const verifyRespPromise = page.waitForResponse((r) => r.url().includes('/api/pay/verify'), { timeout: 10000 }).catch(() => null);
  const captureRespPromise = page.waitForResponse((r) => r.url().includes('/api/pay/mock-capture'), { timeout: 10000 }).catch(() => null);
  await completeBtn.click();
  const [captureResp] = await Promise.all([captureRespPromise, verifyRespPromise]);
  try {
    mockPaymentId = (await captureResp?.json())?.paymentId || '';
  } catch {}
  await page.locator('text=signature verified').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  const payPanelText = (((await page.locator('.content-col').first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ')).trim();
  const maskedOrder = maskId(mockOrderId);
  const maskedPay = maskId(mockPaymentId);
  check(
    `${label}: payment verified with mock refs`,
    /signature verified/i.test(payPanelText) && (!!maskedOrder ? payPanelText.includes(maskedOrder) : true) && (!!maskedPay ? payPanelText.includes(maskedPay) : true),
    payPanelText.slice(0, 160),
  );
  const fulfilBtn = page.locator('button:has-text("Fulfil order")').first();
  const fulfilReady = (await fulfilBtn.count()) > 0 && (await fulfilBtn.isVisible().catch(() => false));
  check(`${label}: fulfil action exposed after verification`, fulfilReady, '');

  // Fulfil via UI → FULFILLED receipt with total + verified payment.
  const receiptTotalBefore = (payPanelText.match(/₹[\d,]+\.\d{2}/) || [])[0] || '';
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/fulfil'), { timeout: 10000 }).catch(() => null),
    fulfilBtn.click(),
  ]);
  await page.locator('text=Your order is on its way').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  const receiptText = (((await page.locator('.content-col').first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ')).trim();
  const receiptTotal = (receiptText.match(/₹[\d,]+\.\d{2}/) || [])[0] || '';
  check(
    `${label}: receipt shows fulfilled + total + verified payment`,
    /Your order is on its way/.test(receiptText) && !!receiptTotal && /Verified/.test(receiptText) && (!!maskedPay ? receiptText.includes(maskedPay) : true),
    receiptText.slice(0, 170),
  );
  const composerGone = (await page.locator('.composer-input').count()) === 0;
  check(`${label}: composer hidden on receipt (no post-receipt chat)`, composerGone, `total=${receiptTotal || receiptTotalBefore}`);

  // Audit timeline via Trust Drawer UI.
  await page.locator('.trust-badge').first().click().catch(() => {});
  await page.locator('.drawer.open').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  const drawerRows = await page.locator('.timeline-row').count().catch(() => 0);
  check(`${label}: audit timeline visible in drawer`, drawerRows > 0, `rows=${drawerRows}`);
  await page.locator('.drawer-close').first().click().catch(() => {});

  check(`${label}: mock ids only`, mockOrderId.startsWith('order_MOCK_') && mockPaymentId.startsWith('pay_MOCK_'), `${mockOrderId} ${mockPaymentId}`);
  check(`${label}: no real Razorpay/external egress`, blockedExternal.length === 0, blockedExternal.length ? blockedExternal.slice(0, 3).join(', ') : '0 external calls');

  await context.close();
  await browser.close();
}

await runViewport('desktop', { width: 1280, height: 800 });
await runViewport('mobile', { width: 390, height: 844 });

const failed = results.filter((r) => !r.ok);
console.log(`\n===== SUMMARY: ${results.length - failed.length}/${results.length} passed =====`);
if (failed.length) {
  console.log('Failures:');
  for (const f of failed) console.log(` - ${f.name}`);
  process.exit(1);
}

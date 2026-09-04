// Reproducible browser smoke test — RunVista storefront (desktop + mobile).
//
// Covers: ambiguous request → shortlist → approve → budget-edit auto-close →
// approval reset + Pay disabled + audit preserved → re-approve → mocked
// initiation (PAYMENT_PENDING branch) → mocked completion (visible verified
// receipt) → fulfil → follow-up chat leaves the settled receipt unchanged.
//
// MOCKS ONLY. No real payment: run the app with empty Razorpay credentials so
// the mock adapter serves /api/pay/* locally, and this script aborts any
// request to Razorpay/Solana hosts (failing the run if one is attempted).
// X402 stays in mock mode (do not set X402_MODE=devnet).
//
// Prerequisites: `npx playwright install chromium` (once).
//
// Run:
//   RAZORPAY_KEY_ID="" RAZORPAY_KEY_SECRET="" \
//     RAZORPAY_WEBHOOK_SECRET="mock_secret" \
//     ENVELOPE_SIGNING_SECRET="smoke-test-secret" X402_MODE="mock" \
//     pnpm dev --port 3101 &
//   PORT=3101 node test/browser-smoke.mjs
//
// Exit code is 0 when every check passes on both viewports.

import { chromium } from '@playwright/test';

const BASE = process.env.APP_URL || `http://localhost:${process.env.PORT || 3101}`;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function sendMessage(page, text) {
  await page.locator('.ledger-composer-input').fill(text);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/respond') && r.request().method() === 'POST', { timeout: 10000 }).catch(() => null),
    page.locator('.ledger-composer-send').click(),
  ]);
  await page.waitForTimeout(900);
}

async function getHero(page) {
  const name = ((await page.locator('.ledger-hero-name').first().textContent().catch(() => '')) || '').trim();
  const price = ((await page.locator('.ledger-hero-price').first().textContent().catch(() => '')) || '').trim();
  return { name, price };
}

async function getBudgetLabel(page) {
  const labels = await page.locator('.ledger-chip .ledger-chip-label').allTextContents().catch(() => []);
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

async function getOrderId(page) {
  const toggle = page.locator('.ledger-tech-toggle').first();
  if ((await toggle.count()) > 0) {
    const expanded = await toggle.getAttribute('aria-expanded').catch(() => null);
    if (expanded !== 'true') {
      await toggle.click().catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  const monos = await page.locator('.ledger-tech .ledger-mono').allTextContents().catch(() => []);
  for (const t of monos) {
    const m = t.match(/ord_[a-z0-9]+/);
    if (m) return m[0];
  }
  return null;
}

async function getOrderPill(page) {
  return ((await page.locator('.ledger-order-pill').first().textContent().catch(() => '')) || '').trim();
}

async function payPanel(page) {
  const box = page.locator('.ledger-pay').first();
  const text = (((await box.textContent().catch(() => '')) || '').replace(/\s+/g, ' ')).trim();
  const buttons = box.locator('button');
  const n = await buttons.count().catch(() => 0);
  const enabledLabels = [];
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    if (await b.isVisible().catch(() => false) && !(await b.isDisabled().catch(() => true))) {
      enabledLabels.push(((await b.textContent().catch(() => '')) || '').trim());
    }
  }
  return { text, enabledLabels };
}

async function approveNow(page) {
  const btn = page.locator('#order-review .ledger-approve-btn');
  if ((await btn.count()) === 0) return false;
  if (!(await btn.first().isVisible().catch(() => false))) return false;
  if (await btn.first().isDisabled().catch(() => true)) return false;
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/approve'), { timeout: 8000 }).catch(() => null),
    btn.first().click(),
  ]);
  await page.waitForTimeout(800);
  return true;
}

async function selectHero(page) {
  const btn = page.locator('.ledger-hero-actions .ledger-btn-primary').first();
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/quote'), { timeout: 10000 }).catch(() => null),
    btn.click(),
  ]);
  await page.waitForTimeout(1000);
}

// Budget edit via chip UI with Enter only — asserts the editor auto-closes.
async function editBudget(page, newValue) {
  const labelBtn = page.locator('.ledger-chip .ledger-chip-label', { hasText: 'Max' }).first();
  if ((await labelBtn.count()) === 0) return false;
  await labelBtn.click();
  const input = page.locator('.ledger-chip-input').first();
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

  const mockIds = { order: '', payment: '' };
  const blockedExternal = [];

  // Observe (never stub) payment APIs — the mock adapter serves them locally.
  await page.route('**/api/pay/initiate', async (route) => {
    const resp = await route.fetch();
    try {
      mockIds.order = (await resp.json()).attempt?.externalOrderId || '';
    } catch {}
    await route.fulfill({ response: resp });
  });
  await page.route('**/api/pay/mock-capture', async (route) => {
    const resp = await route.fetch();
    try {
      mockIds.payment = (await resp.json()).paymentId || '';
    } catch {}
    await route.fulfill({ response: resp });
  });
  for (const pattern of [/.*razorpay\.com.*/, /.*checkout\.razorpay.*/, /.*(solana|helius).*/]) {
    await page.route(pattern, async (route) => {
      const url = route.request().url();
      if (url.includes('localhost')) return route.continue();
      blockedExternal.push(url);
      await route.abort('blockedbyclient');
    });
  }

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('.ledger-composer-input').waitFor({ state: 'visible', timeout: 20000 });
  const status = await page.evaluate(async () => (await fetch('/api/status')).json()).catch(() => null);
  await page.waitForTimeout(800);

  const mockBadge = await page.locator('.ledger-mock-badge').first().textContent().catch(() => '');
  check(`${label}: app renders in Mock mode`, /mock/i.test(mockBadge || ''), `badge=${(mockBadge || '').trim()}`);
  check(`${label}: indicators mock (razorpay+x402)`, !!status && status.indicators?.razorpay === 'mock' && status.indicators?.x402 === 'mock', JSON.stringify(status?.indicators));

  await sendMessage(page, 'I need black shoes under ₹5,000.');
  await sendMessage(page, 'UK 9');
  await sendMessage(page, 'road running');
  await page.locator('.ledger-hero-name').first().waitFor({ state: 'visible', timeout: 15000 });
  const hero5000 = await getHero(page);
  check(`${label}: shortlist under ₹5,000`, !!hero5000.name, `${hero5000.name} ${hero5000.price}`);

  await selectHero(page);
  await page.locator('#order-review').waitFor({ state: 'visible', timeout: 10000 });
  const oid = await getOrderId(page);
  const approved1 = await approveNow(page);
  const pillApproved = await getOrderPill(page);
  check(`${label}: approve binds envelope`, approved1 && /approved/i.test(pillApproved), `pill=${pillApproved} order=${oid}`);
  const timeline1 = oid ? await fetchTimeline(page, oid) : [];

  // Material edit: editor must auto-close, recs update, approval resets.
  await editBudget(page, 'Max ₹3,000');
  const stillEditing = await page.locator('.ledger-chip-input').count().catch(() => 0);
  const budget3000 = await getBudgetLabel(page);
  const hero3000 = await getHero(page);
  const pillAfterEdit = await getOrderPill(page);
  const payAfterEdit = await payPanel(page);
  const timeline2 = oid ? await fetchTimeline(page, oid) : [];
  check(`${label}: editor auto-closes after save`, stillEditing === 0 && !!budget3000 && budget3000.includes('3,000'), `inputs=${stillEditing} budget=${budget3000}`);
  check(`${label}: recommendations update (5000→3000)`, !!hero3000.name && hero3000.name !== hero5000.name, `${hero5000.name} → ${hero3000.name} ${hero3000.price}`);
  check(`${label}: approval resets + Pay disabled`, !/● Approved/.test(pillAfterEdit) && /blocked/i.test(payAfterEdit.text), `pill=${pillAfterEdit}`);
  check(`${label}: audit preserves approval history`, timeline2.length >= timeline1.length && timeline2.filter((e) => e.type === 'approval.granted').length >= 1 && timeline2.filter((e) => e.type === 'quote.invalidated').length >= 1, `events ${timeline1.length}→${timeline2.length}`);

  // Re-approve and initiate mocked payment.
  await selectHero(page);
  const approved2 = await approveNow(page);
  check(`${label}: re-approve updated order`, approved2 && /approved/i.test(await getOrderPill(page)), await getOrderPill(page));
  await page.locator('.ledger-pay button:has-text("Pay with Razorpay")').first().click();
  await page.waitForResponse((r) => r.url().includes('/api/pay/initiate'), { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(1000);
  const payPending = await payPanel(page);
  const completeBtn = page.locator('.ledger-pay button:has-text("Complete test payment")').first();
  const completeReady = (await completeBtn.count()) > 0 && (await completeBtn.isVisible().catch(() => false)) && !(await completeBtn.isDisabled().catch(() => true));
  check(`${label}: initiation is mock order`, mockIds.order.startsWith('order_MOCK_'), mockIds.order);
  check(`${label}: PAYMENT_PENDING shows pending, not blocked`, /pending/i.test(payPending.text) && !/blocked/i.test(payPending.text), payPending.text.slice(0, 110));
  check(`${label}: mock completion action exposed`, completeReady, `pill=${await getOrderPill(page)}`);

  // Complete mocked payment → visible verified receipt.
  await completeBtn.click();
  await page.waitForResponse((r) => r.url().includes('/api/pay/verify'), { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(1200);
  const payIdPrefix = (mockIds.payment || '').slice(0, 8);
  const orderPrefix = (mockIds.order || '').slice(0, 8);
  const payVerified = await payPanel(page);
  const totalStr = (payVerified.text.match(/₹[\d,]+/) || [])[0] || '';
  check(`${label}: receipt shows verified payment + total + refs`, /Payment verified/.test(payVerified.text) && !!totalStr && /INR/.test(payVerified.text) && payVerified.text.includes(payIdPrefix) && payVerified.text.includes(orderPrefix) && /signature verified/i.test(payVerified.text) && /Fulfilment:\s*Paid — awaiting fulfilment/.test(payVerified.text), payVerified.text.slice(0, 170));
  check(`${label}: no approval prompt or payment offer after verification`, !/awaiting approval/i.test(payVerified.text) && payVerified.enabledLabels.length === 0, `enabled=${JSON.stringify(payVerified.enabledLabels)}`);

  // Fulfil (mock API — no UI fulfil button exists), then follow-up chat.
  const fulfilRes = await page.evaluate(async (id) => {
    const r = await fetch('/api/fulfil', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: id, fail: false }) });
    return { status: r.status, body: await r.json() };
  }, oid);
  check(`${label}: mock fulfil completes`, fulfilRes.status === 200 && fulfilRes.body?.state === 'FULFILLED', `state=${fulfilRes.body?.state}`);
  await sendMessage(page, 'Thanks!');
  await sendMessage(page, 'Do you have anything in blue?');
  const receiptAfter = await payPanel(page);
  const totalAfter = (receiptAfter.text.match(/₹[\d,]+/) || [])[0] || '';
  check(`${label}: settled receipt persists across chat`, totalAfter === totalStr && !!totalStr && receiptAfter.text.includes(payIdPrefix) && receiptAfter.text.includes(orderPrefix) && /Fulfilment:\s*Fulfilled/.test(receiptAfter.text), `total ${totalStr}→${totalAfter}`);
  check(`${label}: receipt state stable`, /FULFILLED/.test(await getOrderPill(page)) && !/awaiting approval/i.test(receiptAfter.text) && receiptAfter.enabledLabels.length === 0, `pill=${await getOrderPill(page)}`);

  check(`${label}: mock ids only`, mockIds.order.startsWith('order_MOCK_') && mockIds.payment.startsWith('pay_MOCK_'), `${mockIds.order} ${mockIds.payment}`);
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

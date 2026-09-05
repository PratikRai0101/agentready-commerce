// Reproducible browser smoke test — frozen Decision Ledger prototype.
// Route: /ledger-prototype (isolated, UI-only, MOCK-only).
//
// Covers: MOCK banner + payments-disabled badge → hero shortlist → mock
// approve (audit 5→6, Approved pill) → chip edit invalidation (audit back
// to 5, approval reset, rebuilding state) → Pay stays disabled throughout.
//
// No /api calls are made by this route (mock timers only). This script fails
// if any /api/pay/* request is observed or if any Razorpay/Solana host is
// contacted. No settlement, no payment, no credentials.
//
// Run against a local server:
//   APP_URL=http://localhost:3101 node test/ledger-prototype-smoke.mjs
// Use ?view=desktop for 1280x800 and ?view=mobile for 390x844.

import { chromium } from '@playwright/test';

const BASE = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3101}`).replace(/\/$/, '');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function runViewport(label, viewport, viewParam) {
  console.log(`\n===== ${label} (${viewport.width}x${viewport.height}, view=${viewParam}) =====`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  const payApiCalls = [];
  const otherApiCalls = [];
  const blockedExternal = [];

  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/pay/')) payApiCalls.push(url);
    else otherApiCalls.push(url);
    return route.continue();
  });
  for (const pattern of [/.*razorpay\.com.*/, /.*checkout\.razorpay.*/, /.*(solana|helius).*/]) {
    await page.route(pattern, async (route) => {
      const url = route.request().url();
      if (url.includes('localhost') || url.includes('127.0.0.1')) return route.continue();
      blockedExternal.push(url);
      await route.abort('blockedbyclient');
    });
  }

  await page.goto(`${BASE}/ledger-prototype?view=${viewParam}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.proto-banner').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(500);

  const bannerPill = ((await page.locator('.proto-banner-pill').first().textContent().catch(() => '')) || '').trim();
  const badgeWarn = ((await page.locator('.proto-badge-warn').first().textContent().catch(() => '')) || '').trim();
  check(`${label}: MOCK banner + payments disabled`, /MOCK/i.test(bannerPill) && /payments disabled/i.test(badgeWarn), `${bannerPill} / ${badgeWarn}`);

  const heroName = ((await page.locator('.ledger-hero-name').first().textContent().catch(() => '')) || '').trim();
  const heroPrice = ((await page.locator('.ledger-hero-price').first().textContent().catch(() => '')) || '').trim();
  check(`${label}: hero shortlist rendered`, /RunVista Max Cushion/.test(heroName) && /₹4,899/.test(heroPrice), `${heroName} ${heroPrice}`);

  const mockBadge = ((await page.locator('.ledger-mock-badge').first().textContent().catch(() => '')) || '').trim();
  check(`${label}: mock badge`, /mock/i.test(mockBadge), mockBadge);

  const payBtn = page.locator('.ledger-pay button:has-text("Pay with Razorpay")').first();
  const payDisabled = (await payBtn.count()) > 0 && (await payBtn.isDisabled().catch(() => false));
  const payTitle = (await payBtn.getAttribute('title').catch(() => '')) || '';
  // Frozen desktop variant carries title="Prototype — no payment submission";
  // the frozen mobile variant omits the title. The invariant is disabled.
  const payTitleOk = payTitle === '' || /Prototype — no payment submission/.test(payTitle);
  check(`${label}: Pay disabled in prototype`, payDisabled && payTitleOk, `title=${payTitle}`);

  const auditBefore = ((await page.locator('.ledger-box-count').first().textContent().catch(() => '')) || '').trim();
  check(`${label}: audit starts at 5 events`, /5 events/.test(auditBefore), auditBefore);

  const approveBtn = page.locator('#order-review .ledger-approve-btn').first();
  await approveBtn.waitFor({ state: 'visible', timeout: 10000 });
  await approveBtn.click();
  await page.waitForTimeout(600);
  const pillApproved = ((await page.locator('.ledger-order-pill').first().textContent().catch(() => '')) || '').trim();
  const auditAfter = ((await page.locator('.ledger-box-count').first().textContent().catch(() => '')) || '').trim();
  check(`${label}: mock approve → Approved + 6 events`, /Approved/.test(pillApproved) && /6 events/.test(auditAfter), `${pillApproved} / ${auditAfter}`);

  const payStillDisabled = await payBtn.isDisabled().catch(() => false);
  check(`${label}: Pay stays disabled after approve`, payStillDisabled, '');

  // Chip edit → invalidation: approval resets, audit back to 5.
  const chipLabel = page.locator('.ledger-chip-label', { hasText: 'Max' }).first();
  await chipLabel.click();
  const chipInput = page.locator('.ledger-chip-input').first();
  await chipInput.waitFor({ state: 'visible', timeout: 5000 });
  await chipInput.fill('Max ₹3,000');
  await chipInput.press('Enter');
  await page.waitForTimeout(1300);
  const stillEditing = await page.locator('.ledger-chip-input').count().catch(() => 0);
  const pillAfterEdit = ((await page.locator('.ledger-order-pill').first().textContent().catch(() => '')) || '').trim();
  const auditAfterEdit = ((await page.locator('.ledger-box-count').first().textContent().catch(() => '')) || '').trim();
  check(`${label}: chip edit invalidates approval (audit 5)`, stillEditing === 0 && !/● Approved/.test(pillAfterEdit) && /5 events/.test(auditAfterEdit), `${pillAfterEdit} / ${auditAfterEdit}`);

  check(`${label}: no /api/pay calls from prototype`, payApiCalls.length === 0, payApiCalls.length ? payApiCalls.slice(0, 3).join(', ') : '0 pay calls');
  check(`${label}: no real Razorpay/external egress`, blockedExternal.length === 0, blockedExternal.length ? blockedExternal.slice(0, 3).join(', ') : '0 external calls');

  await context.close();
  await browser.close();
}

await runViewport('prototype-desktop', { width: 1280, height: 800 }, 'desktop');
await runViewport('prototype-mobile', { width: 390, height: 844 }, 'mobile');

const failed = results.filter((r) => !r.ok);
console.log(`\n===== SUMMARY: ${results.length - failed.length}/${results.length} passed =====`);
if (failed.length) {
  console.log('Failures:');
  for (const f of failed) console.log(` - ${f.name}`);
  process.exit(1);
}

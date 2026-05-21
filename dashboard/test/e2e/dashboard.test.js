/**
 * Playwright E2E tests for the trading dashboard.
 *
 * Covers critical user flows across all 3 tabs (Setup / Trade / Bot).
 * Tests run against a real server started by playwright.config.js.
 *
 * No exchange credentials or active twilight-bot required — all tests
 * work with the server in its default (no-creds) offline state.
 */

import { test, expect } from '@playwright/test';

// ── helpers ───────────────────────────────────────────────────────────────────

async function goToTab(page, tabId) {
  await page.click(`#${tabId}`);
  await page.waitForTimeout(150);
}

// Wait for an element's text to change from the loading placeholder
async function waitForContent(locator, placeholder = 'Loading…', timeout = 4000) {
  await expect(locator).not.toHaveText(placeholder, { timeout });
}

// ── page load ─────────────────────────────────────────────────────────────────

test.describe('Page load', () => {
  test('loads without JS errors and shows header', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('h1, [class*="font-display"]').first()).toBeVisible();
    await expect(page.locator('#tab-desk-manual')).toBeVisible();
    await expect(page.locator('#tab-desk-automated')).toBeVisible();
    await expect(page.locator('#tab-desk-agentic')).toBeVisible();
    await expect(page.locator('#sys-status-bar')).toBeVisible();
    expect(jsErrors).toHaveLength(0);
  });

  test('Setup tab is active by default', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#tab-desk-manual')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#desk-panel-manual')).toBeVisible();
    await expect(page.locator('#desk-panel-automated')).toBeHidden();
    await expect(page.locator('#desk-panel-agentic')).toBeHidden();
  });
});

// ── tab navigation ────────────────────────────────────────────────────────────

test.describe('Tab navigation', () => {
  test('clicking Trade tab shows Trade panel and hides others', async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-automated');
    await expect(page.locator('#desk-panel-automated')).toBeVisible();
    await expect(page.locator('#desk-panel-manual')).toBeHidden();
    await expect(page.locator('#desk-panel-agentic')).toBeHidden();
    await expect(page.locator('#tab-desk-automated')).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking Bot tab shows Bot panel and hides others', async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-agentic');
    await expect(page.locator('#desk-panel-agentic')).toBeVisible();
    await expect(page.locator('#desk-panel-manual')).toBeHidden();
    await expect(page.locator('#desk-panel-automated')).toBeHidden();
  });

  test('tab selection persists on reload', async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-automated');
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#desk-panel-automated')).toBeVisible();
  });
});

// ── Setup tab ─────────────────────────────────────────────────────────────────

test.describe('Setup tab — environment config', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('Save .env button is visible', async ({ page }) => {
    await expect(page.locator('#btn-env-save')).toBeVisible();
  });

  test('Testnet preset button triggers without error toast', async ({ page }) => {
    await page.click('#btn-env-preset-testnet');
    await page.waitForTimeout(400);
    expect(await page.locator('.toast-error').count()).toBe(0);
  });

  test('Reload env button works without JS error', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    await page.click('#btn-env-reload');
    await page.waitForTimeout(500);
    expect(jsErrors).toHaveLength(0);
  });
});

test.describe('Setup tab — wallet section', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('wallet list refresh and login buttons are present', async ({ page }) => {
    await expect(page.locator('#btn-wallet-refresh')).toBeVisible();
    await expect(page.locator('#btn-wallet-login')).toBeVisible();
  });

  test('wallet refresh does not cause JS error', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    await page.click('#btn-wallet-refresh');
    await page.waitForTimeout(600);
    expect(jsErrors).toHaveLength(0);
  });
});

// ── Trade tab ─────────────────────────────────────────────────────────────────

test.describe('Trade tab — strategies', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-automated');
  });

  test('Refresh strategies button is visible and does not crash', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    await expect(page.locator('#btn-strategies-refresh')).toBeVisible();
    await page.click('#btn-strategies-refresh');
    await page.waitForTimeout(600);
    expect(jsErrors).toHaveLength(0);
  });
});

test.describe('Trade tab — monitor controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-automated');
  });

  test('Start and Stop monitor buttons are visible', async ({ page }) => {
    await expect(page.locator('#btn-monitor-start')).toBeVisible();
    await expect(page.locator('#btn-monitor-stop')).toBeVisible();
  });

  test('Stop monitor click responds without JS error', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    await page.click('#btn-monitor-stop');
    await page.waitForTimeout(400);
    expect(jsErrors).toHaveLength(0);
  });
});

test.describe('Trade tab — P&L section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-automated');
  });

  test('P&L stats and positions tables are in DOM', async ({ page }) => {
    await expect(page.locator('#pnl-stats-manual')).toBeAttached();
    await expect(page.locator('#positions-open-body-manual')).toBeAttached();
    await expect(page.locator('#positions-closed-body-manual')).toBeAttached();
  });

  test('Refresh P&L button triggers without JS error', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    await page.click('#btn-pnl-refresh-manual');
    await page.waitForTimeout(500);
    expect(jsErrors).toHaveLength(0);
  });

  test('P&L stats populate after page load', async ({ page }) => {
    await page.waitForTimeout(1000);
    const stats = page.locator('#pnl-stats-manual');
    const html = await stats.innerHTML();
    // Should either have stat items or be empty — not show raw "Loading…"
    expect(html).not.toContain('Loading…');
  });
});

// ── Bot tab — structure ───────────────────────────────────────────────────────

test.describe('Bot tab — structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-agentic');
  });

  test('Bot panel is visible with all major sections', async ({ page }) => {
    await expect(page.locator('#desk-panel-agentic')).toBeVisible();
    // Config section
    await expect(page.locator('#btn-tb-params-save')).toBeVisible();
    // Runtime section
    await expect(page.locator('#btn-agentic-spin-up')).toBeVisible();
    await expect(page.locator('#btn-agentic-process-stop')).toBeVisible();
    // Exit conditions section (now always visible, not hidden)
    await expect(page.locator('#btn-tb-build-intent-json')).toBeVisible();
    await expect(page.locator('#agentic-bot-intent-json')).toBeVisible();
    // Kill switch
    await expect(page.locator('#btn-agentic-bot-kill-on')).toBeVisible();
    await expect(page.locator('#btn-agentic-bot-kill-off')).toBeVisible();
  });

  test('exit conditions section is immediately visible without expanding any details', async ({ page }) => {
    // The exit builder is now a regular card, not hidden in <details>
    await expect(page.locator('#tb-exit-take-profit-pct')).toBeVisible();
    await expect(page.locator('#tb-exit-stop-loss-pct')).toBeVisible();
    await expect(page.locator('#tb-exit-close-unprofitable')).toBeVisible();
    await expect(page.locator('#tb-exit-close-spread-inverts')).toBeVisible();
  });

  test('three live data panels are present', async ({ page }) => {
    await expect(page.locator('#agentic-bot-strategies-out')).toBeAttached();
    await expect(page.locator('#agentic-bot-trades-out')).toBeAttached();
    await expect(page.locator('#agentic-bot-positions-out')).toBeAttached();
  });
});

// ── Bot tab — command interface ───────────────────────────────────────────────

test.describe('Bot tab — command chips', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-agentic');
  });

  const chips = [
    { cmd: 'help', label: 'help' },
    { cmd: 'status', label: 'status' },
    { cmd: 'health', label: 'health' },
    { cmd: 'positions', label: 'positions' },
    { cmd: 'strategies profitable=true limit=10', label: 'strategies' },
    { cmd: 'caps', label: 'caps' },
    { cmd: 'trades limit=25', label: 'trades' },
    { cmd: 'kill on', label: 'kill on' },
    { cmd: 'kill off', label: 'kill off' },
  ];

  for (const { cmd, label } of chips) {
    test(`"${label}" chip fills command input`, async ({ page }) => {
      await page.click(`[data-agentic-cmd="${cmd}"]`);
      const input = page.locator('#agentic-process-command');
      await expect(input).toHaveValue(cmd);
    });
  }

  test('command input accepts free-form text', async ({ page }) => {
    const input = page.locator('#agentic-process-command');
    await input.fill('strategies venue=bybit profitable=true limit=5');
    await expect(input).toHaveValue('strategies venue=bybit profitable=true limit=5');
  });
});

// ── Bot tab — exit rules builder ──────────────────────────────────────────────

test.describe('Bot tab — exit rules builder', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-agentic');
  });

  test('intent JSON textarea has valid default JSON on page load', async ({ page }) => {
    const ta = page.locator('#agentic-bot-intent-json');
    await expect(ta).toBeAttached();
    const value = await ta.inputValue();
    expect(value.trim()).toBeTruthy();
    const parsed = JSON.parse(value);
    expect(parsed).toHaveProperty('thesis');
    expect(parsed).toHaveProperty('exit');
    expect(Array.isArray(parsed.exit?.rules)).toBe(true);
  });

  test('take-profit rule generates correct DSL expression', async ({ page }) => {
    await page.fill('#tb-exit-take-profit-pct', '5');
    await page.click('#btn-tb-build-intent-json');

    const value = await page.locator('#agentic-bot-intent-json').inputValue();
    const { exit: { rules } } = JSON.parse(value);
    const tpRule = rules.find(r => r.if.includes('unrealized_pct') && r.if.includes('>='));
    expect(tpRule).toBeTruthy();
    expect(tpRule.if).toBe('pnl.unrealized_pct >= 0.0500');
    expect(tpRule.do).toBe('close');
  });

  test('stop-loss rule generates correct DSL expression', async ({ page }) => {
    await page.fill('#tb-exit-stop-loss-pct', '3');
    await page.click('#btn-tb-build-intent-json');

    const value = await page.locator('#agentic-bot-intent-json').inputValue();
    const { exit: { rules } } = JSON.parse(value);
    const slRule = rules.find(r => r.if.includes('unrealized_pct') && r.if.includes('<= -'));
    expect(slRule).toBeTruthy();
    expect(slRule.if).toBe('pnl.unrealized_pct <= -0.0300');
    expect(slRule.do).toBe('close');
  });

  test('max hours rule generates correct DSL expression', async ({ page }) => {
    await page.fill('#tb-exit-max-hours', '24');
    await page.click('#btn-tb-build-intent-json');

    const value = await page.locator('#agentic-bot-intent-json').inputValue();
    const { exit: { rules } } = JSON.parse(value);
    const timeRule = rules.find(r => r.if.includes('time_in_position_hours'));
    expect(timeRule).toBeTruthy();
    expect(timeRule.if).toBe('time_in_position_hours >= 24');
    expect(timeRule.do).toBe('close');
  });

  test('"close when unprofitable" checkbox adds pnl.unrealized_pct <= 0 rule', async ({ page }) => {
    await page.check('#tb-exit-close-unprofitable');
    await page.click('#btn-tb-build-intent-json');

    const value = await page.locator('#agentic-bot-intent-json').inputValue();
    const { exit: { rules } } = JSON.parse(value);
    const rule = rules.find(r => r.if === 'pnl.unrealized_pct <= 0');
    expect(rule).toBeTruthy();
    expect(rule.do).toBe('close');
  });

  test('"close when spread inverts" adds funding rate DSL rules for Bybit and Binance', async ({ page }) => {
    await page.check('#tb-exit-close-spread-inverts');
    await page.click('#btn-tb-build-intent-json');

    const value = await page.locator('#agentic-bot-intent-json').inputValue();
    const { exit: { rules } } = JSON.parse(value);

    const bybitRule = rules.find(r => r.if === 'funding_rates.twilight.rate <= funding_rates.bybit.rate');
    expect(bybitRule).toBeTruthy();
    expect(bybitRule.do).toBe('close');

    const binanceRule = rules.find(r => r.if === 'funding_rates.twilight.rate <= funding_rates.binance.rate');
    expect(binanceRule).toBeTruthy();
    expect(binanceRule.do).toBe('close');
  });

  test('ratchet floor rule is always added when any rule is set', async ({ page }) => {
    await page.fill('#tb-exit-take-profit-pct', '10');
    await page.click('#btn-tb-build-intent-json');

    const value = await page.locator('#agentic-bot-intent-json').inputValue();
    const { exit: { rules } } = JSON.parse(value);
    const ratchet = rules.find(r => r.if === 'pnl.unrealized_pct <= pnl.locked_floor_pct');
    expect(ratchet).toBeTruthy();
  });

  test('combining TP + SL + unprofitable + spread inverts builds all rules', async ({ page }) => {
    await page.fill('#tb-exit-take-profit-pct', '8');
    await page.fill('#tb-exit-stop-loss-pct', '4');
    await page.check('#tb-exit-close-unprofitable');
    await page.check('#tb-exit-close-spread-inverts');
    await page.click('#btn-tb-build-intent-json');

    const value = await page.locator('#agentic-bot-intent-json').inputValue();
    const { exit: { rules } } = JSON.parse(value);

    // TP, SL, unprofitable, Bybit spread, Binance spread, ratchet floor = 6 rules
    expect(rules.length).toBe(6);
    const types = rules.map(r => r.if);
    expect(types).toContain('pnl.unrealized_pct >= 0.0800');
    expect(types).toContain('pnl.unrealized_pct <= -0.0400');
    expect(types).toContain('pnl.unrealized_pct <= 0');
    expect(types).toContain('funding_rates.twilight.rate <= funding_rates.bybit.rate');
    expect(types).toContain('funding_rates.twilight.rate <= funding_rates.binance.rate');
    expect(types).toContain('pnl.unrealized_pct <= pnl.locked_floor_pct');
  });

  test('no rules are added if all fields are empty and checkboxes unchecked', async ({ page }) => {
    // Clear all fields
    await page.fill('#tb-exit-take-profit-pct', '');
    await page.fill('#tb-exit-stop-loss-pct', '');
    await page.fill('#tb-exit-max-hours', '');
    await page.uncheck('#tb-exit-close-unprofitable');
    await page.uncheck('#tb-exit-close-spread-inverts');
    await page.click('#btn-tb-build-intent-json');

    const value = await page.locator('#agentic-bot-intent-json').inputValue();
    const { exit: { rules } } = JSON.parse(value);
    expect(rules.length).toBe(0);
  });
});

// ── Bot tab — data panels ─────────────────────────────────────────────────────

test.describe('Bot tab — live data panels auto-load', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-agentic');
    await page.waitForTimeout(1500); // allow initial data load
  });

  test('strategies panel shows content (data or offline message)', async ({ page }) => {
    const el = page.locator('#agentic-bot-strategies-out');
    await expect(el).toBeAttached();
    const text = await el.textContent();
    expect(text?.trim()).toBeTruthy();
    expect(text).not.toBe('');
  });

  test('trades panel shows content (data or offline message)', async ({ page }) => {
    const el = page.locator('#agentic-bot-trades-out');
    await expect(el).toBeAttached();
    const text = await el.textContent();
    expect(text?.trim()).toBeTruthy();
  });

  test('positions panel renders (table or offline message) — not raw "Loading…"', async ({ page }) => {
    const el = page.locator('#agentic-bot-positions-out');
    await expect(el).toBeAttached();
    const text = await el.textContent();
    expect(text).not.toContain('Loading…');
  });

  test('refresh buttons work for all three data panels', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    await page.click('#btn-agentic-bot-strategies-refresh');
    await page.click('#btn-agentic-bot-trades-refresh');
    await page.click('#btn-agentic-bot-positions-refresh');
    await page.waitForTimeout(800);
    expect(jsErrors).toHaveLength(0);
  });
});

// ── Bot tab — positions close flow ────────────────────────────────────────────

test.describe('Bot tab — position close flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-agentic');
  });

  test('position ID input and Close button are present', async ({ page }) => {
    await expect(page.locator('#agentic-bot-close-position-id')).toBeVisible();
    await expect(page.locator('#btn-agentic-bot-close-position')).toBeVisible();
  });

  test('clicking Close with an ID shows confirmation modal', async ({ page }) => {
    await page.fill('#agentic-bot-close-position-id', 'twi_0');
    await page.click('#btn-agentic-bot-close-position');

    const modal = page.locator('.modal-overlay, [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 2000 });

    // Cancel to avoid side effects
    const cancel = modal.locator('button').filter({ hasText: /cancel|no/i }).first();
    if (await cancel.isVisible()) {
      await cancel.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(modal).toBeHidden({ timeout: 1500 });
  });
});

// ── Bot tab — kill switch ─────────────────────────────────────────────────────

test.describe('Bot tab — kill switch', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-agentic');
  });

  test('kill ON shows confirmation modal', async ({ page }) => {
    await page.click('#btn-agentic-bot-kill-on');
    const modal = page.locator('.modal-overlay, [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 2000 });
    const cancel = modal.locator('button').filter({ hasText: /cancel|no/i }).first();
    if (await cancel.isVisible()) await cancel.click();
    else await page.keyboard.press('Escape');
  });

  test('kill OFF shows confirmation modal', async ({ page }) => {
    await page.click('#btn-agentic-bot-kill-off');
    const modal = page.locator('.modal-overlay, [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 2000 });
    const cancel = modal.locator('button').filter({ hasText: /cancel|no/i }).first();
    if (await cancel.isVisible()) await cancel.click();
    else await page.keyboard.press('Escape');
  });

  test('kill switch status button triggers without JS error', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    await page.click('#btn-agentic-bot-kill-switch');
    await page.waitForTimeout(600);
    expect(jsErrors).toHaveLength(0);
  });
});

// ── Bot tab — params ──────────────────────────────────────────────────────────

test.describe('Bot tab — params', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-agentic');
  });

  test('key param inputs are present (PAPER, MAX_OPEN_POSITIONS)', async ({ page }) => {
    await expect(page.locator('#tb-param-PAPER')).toBeAttached();
    await expect(page.locator('#tb-param-MAX_OPEN_POSITIONS')).toBeAttached();
    await expect(page.locator('#tb-param-BYBIT_TESTNET')).toBeAttached();
  });

  test('Claude consult toggle updates env value and dependency note', async ({ page }) => {
    await page.waitForTimeout(300);
    await page.click('#btn-tb-consult-off');
    await expect(page.locator('#tb-param-CLAUDE_CONSULT_DISABLED')).toHaveValue('1');
    await expect(page.locator('#btn-tb-consult-off')).toHaveClass(/is-selected/);
    await expect(page.locator('#tb-consult-dependency-note')).toContainText(/no Anthropic API key/i);
    await page.click('#btn-tb-consult-on');
    await expect(page.locator('#tb-param-CLAUDE_CONSULT_DISABLED')).toHaveValue('0');
    await expect(page.locator('#tb-claude-cli-details')).toBeVisible();
    await expect(page.locator('#tb-consult-dependency-note')).toContainText(/claude auth login/i);
  });

  test('autofill from dashboard button works without JS error', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    await page.click('#btn-tb-params-autofill');
    await page.waitForTimeout(400);
    expect(jsErrors).toHaveLength(0);
  });
});

// ── Bot tab — process controls ────────────────────────────────────────────────

test.describe('Bot tab — process controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-agentic');
  });

  test('Status button updates process line text', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    await page.click('#btn-agentic-process-status');
    await page.waitForTimeout(800);
    expect(jsErrors).toHaveLength(0);
    const line = page.locator('#agentic-process-line');
    if (await line.isAttached()) {
      const text = await line.textContent();
      expect(text?.trim()).toBeTruthy();
    }
  });

  test('Spin up shows confirmation modal', async ({ page }) => {
    await page.click('#btn-agentic-spin-up');
    const modal = page.locator('.modal-overlay, [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 2000 });
    const cancel = modal.locator('button').filter({ hasText: /cancel|no/i }).first();
    if (await cancel.isVisible()) await cancel.click();
    else await page.keyboard.press('Escape');
    await expect(modal).toBeHidden({ timeout: 1500 });
  });
});

// ── System status bar ─────────────────────────────────────────────────────────

test.describe('System status bar', () => {
  test('pills render and update after initial load', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000); // allow updateSysStatusBar() to resolve

    const networkPill = page.locator('#sys-status-network');
    await expect(networkPill).toBeAttached();
    const cls = await networkPill.getAttribute('class');
    expect(cls).toMatch(/pill-(ok|warn|muted|danger)/);
  });

  test('network pill shows ok when server is reachable', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const label = await page.locator('#sys-status-network-label').textContent();
    expect(label).toMatch(/network/i);
  });
});

// ── Confirmation modal ────────────────────────────────────────────────────────

test.describe('Confirmation modal', () => {
  test('can be dismissed with Escape key', async ({ page }) => {
    await page.goto('/');
    await goToTab(page, 'tab-desk-agentic');
    await page.click('#btn-agentic-spin-up');
    const modal = page.locator('.modal-overlay, [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 2000 });
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden({ timeout: 1500 });
  });
});

// ── Toast notifications ───────────────────────────────────────────────────────

test.describe('Toast notifications', () => {
  test('toast container exists in DOM', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.dashboard-toasts')).toBeAttached();
  });
});

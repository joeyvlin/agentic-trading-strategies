import { readAgentSettings } from './agent-settings.mjs';
import { getPositionPnlSummary, unrealizedUsdForOpen } from './position-ledger.mjs';
import { executeFullPositionClose } from './position-close-service.mjs';

/** Baseline USD for % loss/profit vs stored trade size (fallbacks for older ledger rows). */
export function initialNotionalBaselineUsd(open) {
  const n = Number(open.notionalUsd);
  if (Number.isFinite(n) && n > 0) return n;
  const exp = Number(open.exposureUsd);
  if (Number.isFinite(exp) && exp > 0) return exp;
  const tw = Number(open.twilightSizeUsd) || 0;
  const cx = Number(open.cexNotionalUsd) || 0;
  const sum = tw + cx;
  if (sum > 0) return sum;
  return 0;
}

function parseRulesFromSettings() {
  let s;
  try {
    s = readAgentSettings();
  } catch {
    return { lossPct: null, profitPct: null, maxHoldMinutes: null };
  }
  const pc = s.positionAutoClose || {};
  const lossPct = Number(pc.lossPctOfInitialNotional);
  const profitPct = Number(pc.profitPctOfInitialNotional);
  const maxMins = Number(pc.maxHoldMinutes);
  return {
    lossPct: Number.isFinite(lossPct) && lossPct > 0 ? lossPct : null,
    profitPct: Number.isFinite(profitPct) && profitPct > 0 ? profitPct : null,
    maxHoldMinutes: Number.isFinite(maxMins) && maxMins > 0 ? maxMins : null,
  };
}

/**
 * @param {object} open — ledger open row (+ unrealizedPnlUsd when from summary)
 * @param {number} unrealizedUsd
 * @param {{ lossPct: number|null, profitPct: number|null, maxHoldMinutes: number|null }} rules
 * @returns {string[]} human-readable reasons (empty = no close)
 */
export function autoCloseReasonsForOpen(open, unrealizedUsd, rules) {
  const reasons = [];
  const u = Number(unrealizedUsd) || 0;
  const base = initialNotionalBaselineUsd(open);

  if (rules.lossPct != null && base > 0 && u < 0) {
    const pct = (-u / base) * 100;
    if (pct >= rules.lossPct) {
      reasons.push(`loss ${pct.toFixed(2)}% of initial notional ≥ ${rules.lossPct}%`);
    }
  }
  if (rules.profitPct != null && base > 0 && u > 0) {
    const pct = (u / base) * 100;
    if (pct >= rules.profitPct) {
      reasons.push(`profit ${pct.toFixed(2)}% of initial notional ≥ ${rules.profitPct}%`);
    }
  }
  if (rules.maxHoldMinutes != null) {
    const t = Date.parse(open.openedAt || '');
    if (Number.isFinite(t)) {
      const elapsedMin = (Date.now() - t) / 60000;
      if (elapsedMin >= rules.maxHoldMinutes) {
        reasons.push(`open ${elapsedMin.toFixed(1)} min ≥ ${rules.maxHoldMinutes} min`);
      }
    }
  }
  return reasons;
}

/**
 * Evaluates YAML `positionAutoClose` against all open ledger rows; closes via the same path as the UI.
 * @returns {Promise<{ skipped?: boolean, checked: number, closed: { tradeId: string, reasons: string[] }[], errors: { tradeId: string, error: string }[] }>}
 */
export async function runPositionAutoClosePass() {
  const rules = parseRulesFromSettings();
  if (rules.lossPct == null && rules.profitPct == null && rules.maxHoldMinutes == null) {
    return { skipped: true, checked: 0, closed: [], errors: [] };
  }

  const ledger = await getPositionPnlSummary();
  const opens = ledger.openPositions || [];
  const btc = Number(ledger.currentBtcPrice) || 0;
  const closed = [];
  const errors = [];

  for (const open of opens) {
    const u =
      open.unrealizedPnlUsd != null && Number.isFinite(Number(open.unrealizedPnlUsd))
        ? Number(open.unrealizedPnlUsd)
        : unrealizedUsdForOpen(open, btc);
    const reasons = autoCloseReasonsForOpen(open, u, rules);
    if (!reasons.length) continue;

    try {
      const out = await executeFullPositionClose(open.tradeId, {});
      if (out.ok) closed.push({ tradeId: open.tradeId, reasons });
      else errors.push({ tradeId: open.tradeId, error: out.error || 'close failed' });
    } catch (e) {
      errors.push({ tradeId: open.tradeId, error: e?.message || String(e) });
    }
  }

  return { checked: opens.length, closed, errors };
}

/**
 * Derive venue and notionals from Strategy API rows (see twilight-strategy-tester api/lib/strategies.js).
 */

/** USD notional on the CEX leg (Strategy API uses `bybitSize` when `isBybitStrategy`). */
export function cexSizeUsd(strategy) {
  if (!strategy) return 0;
  if (strategy.isBybitStrategy) {
    const y = Number(strategy.bybitSize);
    if (Number.isFinite(y) && y > 0) return y;
  }
  return Number(strategy.binanceSize) || 0;
}

/** Long/short on the CEX leg (`bybitPosition` vs `binancePosition`). */
export function cexPositionSide(strategy) {
  if (!strategy) return null;
  if (strategy.isBybitStrategy) {
    const y = strategy.bybitPosition;
    if (y != null && String(y).trim() !== '' && String(y).toLowerCase() !== 'null') return y;
  }
  return strategy.binancePosition;
}

export function cexVenue(strategy) {
  if (strategy.isBybitStrategy) return 'bybit';
  const hasBinance =
    strategy.binancePosition &&
    String(strategy.binancePosition).toLowerCase() !== 'null' &&
    Number(strategy.binanceSize) > 0;
  if (hasBinance) return 'binance';
  return null;
}

export function estimateVenueNotionals(strategy) {
  const tw = Number(strategy.twilightSize) || 0;
  const venue = cexVenue(strategy);
  const cex = venue === 'bybit' ? cexSizeUsd(strategy) : venue === 'binance' ? Number(strategy.binanceSize) || 0 : 0;
  return {
    twilight: tw,
    binance: venue === 'binance' ? cex : 0,
    bybit: venue === 'bybit' ? cex : 0,
    total: tw + cex,
  };
}

/**
 * Scale twilightSize and CEX leg notionals (binanceSize and/or bybitSize) so total USD matches targetTotalUsd.
 * If template total is 0 or target invalid, returns a shallow copy of strategy unchanged.
 */
export function scaleStrategyToTargetTotalNotional(strategy, targetTotalUsd) {
  const target = Number(targetTotalUsd);
  if (!Number.isFinite(target) || target <= 0) {
    return { ...strategy };
  }
  const n = estimateVenueNotionals(strategy);
  if (n.total <= 0) {
    return { ...strategy };
  }
  const scale = target / n.total;
  return {
    ...strategy,
    twilightSize: (Number(strategy.twilightSize) || 0) * scale,
    binanceSize: (Number(strategy.binanceSize) || 0) * scale,
    bybitSize: (Number(strategy.bybitSize) || 0) * scale,
  };
}

export function pickTopStrategy(strategies, { maxApyFirst = true } = {}) {
  const list = Array.isArray(strategies) ? [...strategies] : [];
  if (maxApyFirst) {
    list.sort((a, b) => (Number(b.apy) || 0) - (Number(a.apy) || 0));
  }
  return list[0] || null;
}

function normRiskToken(s) {
  return String(s || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

/**
 * Client-side filters on Strategy API rows (CEX venue, optional risk allowlist).
 * @param {object[]} strategies
 * @param {Record<string, unknown>} filters from agent.monitor.yaml strategyFilters
 * @param {{ info?: Function }} [logger]
 */
export function filterStrategiesForMonitor(strategies, filters, logger) {
  let list = [...(strategies || [])];
  const venue = String(filters.cexVenue || 'any').toLowerCase();
  if (venue === 'binance') {
    const before = list.length;
    list = list.filter((s) => cexVenue(s) === 'binance');
    if (before !== list.length) logger?.info?.(`[FILTER] cexVenue=binance: ${before} → ${list.length} strategies`);
  } else if (venue === 'bybit') {
    const before = list.length;
    list = list.filter((s) => cexVenue(s) === 'bybit');
    if (before !== list.length) logger?.info?.(`[FILTER] cexVenue=bybit: ${before} → ${list.length} strategies`);
  }

  const allowRaw = filters.riskAllowlist;
  if (allowRaw != null && String(allowRaw).trim() !== '') {
    const allow = String(allowRaw)
      .split(/[,;]+/)
      .map((x) => normRiskToken(x))
      .filter(Boolean);
    if (allow.length) {
      const allowSet = new Set(allow);
      const before = list.length;
      list = list.filter((s) => {
        const r = normRiskToken(s.risk ?? s.riskLevel ?? '');
        return allowSet.has(r);
      });
      if (before !== list.length) {
        logger?.info?.(`[FILTER] riskAllowlist [${allow.join(', ')}]: ${before} → ${list.length} strategies`);
      }
    }
  }

  return list;
}

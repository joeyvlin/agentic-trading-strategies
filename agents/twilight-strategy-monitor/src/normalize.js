/**
 * Derive venue and notionals from Strategy API rows (see twilight-strategy-tester api/lib/strategies.js).
 */

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
  const bin = Number(strategy.binanceSize) || 0;
  const venue = cexVenue(strategy);
  return {
    twilight: tw,
    binance: venue === 'binance' ? bin : 0,
    bybit: venue === 'bybit' ? bin : 0,
    total: tw + bin,
  };
}

export function pickTopStrategy(strategies, { maxApyFirst = true } = {}) {
  const list = Array.isArray(strategies) ? [...strategies] : [];
  if (maxApyFirst) {
    list.sort((a, b) => (Number(b.apy) || 0) - (Number(a.apy) || 0));
  }
  return list[0] || null;
}

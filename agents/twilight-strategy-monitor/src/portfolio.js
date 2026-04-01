/**
 * Tracks open logical trades and daily P&amp;L for risk checks.
 */

export function createPortfolioState() {
  return {
    logicalTrades: [],
    dailyLossUsd: 0,
    dayKey: utcDayKey(),
  };
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function rolloverDayIfNeeded(state) {
  const k = utcDayKey();
  if (k !== state.dayKey) {
    state.dayKey = k;
    state.dailyLossUsd = 0;
  }
}

export function totalOpenNotional(state) {
  return state.logicalTrades.reduce((s, t) => s + (t.totalNotionalUsd || 0), 0);
}

export function venueOpenNotional(state, venue) {
  return state.logicalTrades.reduce((s, t) => s + (t.venues?.[venue] || 0), 0);
}

export function addLogicalTrade(state, trade) {
  state.logicalTrades.push(trade);
}

export function recordLoss(state, usd) {
  rolloverDayIfNeeded(state);
  state.dailyLossUsd += Math.max(0, usd);
}

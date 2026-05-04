import { estimateVenueNotionals } from './normalize.js';
import { rolloverDayIfNeeded, totalOpenNotional, venueOpenNotional } from './portfolio.js';

export function evaluateRisk({ strategy, risk, portfolio, logger }) {
  rolloverDayIfNeeded(portfolio);

  const n = estimateVenueNotionals(strategy);
  const reasons = [];

  if (portfolio.dailyLossUsd >= risk.maxDailyLossUsd) {
    reasons.push(
      `daily loss ${portfolio.dailyLossUsd.toFixed(2)} >= max ${risk.maxDailyLossUsd}`
    );
  }

  if (portfolio.logicalTrades.length >= risk.maxConcurrentLogicalTrades) {
    reasons.push(
      `concurrent trades ${portfolio.logicalTrades.length} >= ${risk.maxConcurrentLogicalTrades}`
    );
  }

  const newTotal = totalOpenNotional(portfolio) + n.total;
  if (newTotal > risk.maxTotalNotionalUsd) {
    reasons.push(
      `total notional ${newTotal.toFixed(2)} would exceed ${risk.maxTotalNotionalUsd}`
    );
  }

  const perStratCap = risk.maxNotionalPerStrategyUsd;
  if (Number.isFinite(perStratCap) && perStratCap > 0 && n.total > perStratCap) {
    reasons.push(
      `strategy template notional ${n.total.toFixed(2)} exceeds max per strategy ${perStratCap}`
    );
  }

  for (const v of ['twilight', 'binance', 'bybit']) {
    const cap = risk.maxNotionalPerVenueUsd[v];
    const open = venueOpenNotional(portfolio, v);
    const add = n[v];
    if (open + add > cap) {
      reasons.push(
        `venue ${v}: open ${open.toFixed(2)} + new ${add.toFixed(2)} > cap ${cap}`
      );
    }
  }

  if (reasons.length) {
    logger?.debug?.(`Risk reject: ${reasons.join('; ')}`);
    return { ok: false, reasons };
  }
  return { ok: true, notionals: n };
}

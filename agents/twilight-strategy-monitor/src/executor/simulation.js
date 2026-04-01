import { randomUUID } from 'crypto';
import { cexVenue } from '../normalize.js';

/**
 * Simulation: no exchange or relayer calls. Records a logical trade for portfolio tracking.
 */
export async function executeSimulation({ strategy, notionals, market, logger }) {
  const id = randomUUID();
  const venue = cexVenue(strategy);

  logger.info(`[SIM] Would execute logical trade ${id}`, {
    strategyId: strategy.id,
    name: strategy.name,
    apy: strategy.apy,
    twilight: {
      side: strategy.twilightPosition,
      sizeUsd: strategy.twilightSize,
      lev: strategy.twilightLeverage,
    },
    cex: venue
      ? {
          venue,
          side: strategy.binancePosition,
          sizeUsd: strategy.binanceSize,
          lev: strategy.binanceLeverage,
        }
      : null,
    notionals,
    btcPrice: market?.prices?.twilight ?? market?.btcPrice,
  });

  return {
    tradeId: id,
    mode: 'simulation',
    totalNotionalUsd: notionals.total,
    venues: {
      twilight: notionals.twilight,
      binance: notionals.binance,
      bybit: notionals.bybit,
    },
    raw: { strategy },
  };
}

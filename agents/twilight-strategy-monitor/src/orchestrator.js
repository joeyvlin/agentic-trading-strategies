import { fetchStrategies, fetchMarket } from './strategyClient.js';
import { pickTopStrategy } from './normalize.js';
import { evaluateRisk } from './riskEngine.js';
import { addLogicalTrade } from './portfolio.js';
import { executeSimulation } from './executor/simulation.js';
import { executeReal } from './executor/real.js';

export async function runOneCycle({ config, portfolio, logger }) {
  const key = config.strategyApiKey;
  if (!key) {
    logger.warn('STRATEGY_API_KEY is empty — Strategy API may return 401. Set it in .env');
  }

  const market = await fetchMarket(config.strategyApiBase, key, logger);
  const data = await fetchStrategies(
    config.strategyApiBase,
    key,
    config.strategyFilters,
    logger
  );

  const strategies = data.strategies || [];
  if (strategies.length === 0) {
    logger.info('No strategies returned after filters.');
    return { skipped: true, reason: 'no_strategies' };
  }

  const strategy = pickTopStrategy(strategies);
  logger.info(`Top strategy: #${strategy.id} ${strategy.name} APY=${strategy.apy}`);

  const risk = evaluateRisk({
    strategy,
    risk: config.risk,
    portfolio,
    logger,
  });

  if (!risk.ok) {
    logger.info(`Risk blocked: ${risk.reasons.join('; ')}`);
    return { skipped: true, reason: 'risk', details: risk.reasons };
  }

  const notionals = risk.notionals;
  const exec =
    config.executionMode === 'real' ? executeReal : executeSimulation;

  const trade = await exec({ strategy, notionals, market, logger });

  const apyNum = Number(strategy.apy) || 0;
  const notional = Number(trade.totalNotionalUsd) || 0;
  /** Rough daily USD yield if APY were constant (for dashboard / simulation tracking). */
  const estimatedDailyUsd = (apyNum / 100 / 365) * notional;

  addLogicalTrade(portfolio, {
    id: trade.tradeId,
    at: new Date().toISOString(),
    strategyId: strategy.id,
    strategyName: strategy.name,
    category: strategy.category,
    apy: strategy.apy,
    totalNotionalUsd: trade.totalNotionalUsd,
    venues: trade.venues,
    mode: trade.mode,
    estimatedDailyUsd,
  });

  return {
    skipped: false,
    strategy,
    trade,
    transaction: {
      tradeId: trade.tradeId,
      at: new Date().toISOString(),
      strategyId: strategy.id,
      strategyName: strategy.name,
      category: strategy.category,
      apy: strategy.apy,
      totalNotionalUsd: trade.totalNotionalUsd,
      venues: trade.venues,
      mode: trade.mode,
      estimatedDailyUsd,
    },
  };
}

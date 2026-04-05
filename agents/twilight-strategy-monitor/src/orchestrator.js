import { fetchStrategies, fetchMarket, fetchStrategyById } from './strategyClient.js';
import { pickTopStrategy, scaleStrategyToTargetTotalNotional } from './normalize.js';
import { evaluateRisk } from './riskEngine.js';
import { addLogicalTrade } from './portfolio.js';
import { executeSimulation } from './executor/simulation.js';
import { executeReal } from './executor/real.js';

function entryBtcPrice(market) {
  return (
    Number(market?.btcPrice ?? market?.prices?.twilight ?? market?.prices?.binanceFutures) || 0
  );
}

async function executeChosenStrategy({ strategy, config, portfolio, market, logger }) {
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
  const exec = config.executionMode === 'real' ? executeReal : executeSimulation;

  const trade = await exec({ strategy, notionals, market, logger });

  const apyNum = Number(strategy.apy) || 0;
  const notional = Number(trade.totalNotionalUsd) || 0;
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

  const marketSnapshot = {
    btcPrice: entryBtcPrice(market),
    at: new Date().toISOString(),
  };

  return {
    skipped: false,
    strategy,
    trade,
    marketSnapshot,
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

  return executeChosenStrategy({ strategy, config, portfolio, market, logger });
}

/**
 * Run one cycle for a specific Strategy API strategy id (no filter list).
 * @param {object} [opts]
 * @param {number} [opts.targetTotalNotionalUsd] If set, scale twilight/CEX notionals to this USD total before risk/exec.
 */
export async function runOneCycleForStrategy({
  strategyId,
  config,
  portfolio,
  logger,
  targetTotalNotionalUsd,
}) {
  const key = config.strategyApiKey;
  if (!key) {
    logger.warn('STRATEGY_API_KEY is empty — Strategy API may return 401. Set it in .env');
  }

  const market = await fetchMarket(config.strategyApiBase, key, logger);
  let strategy;
  try {
    strategy = await fetchStrategyById(config.strategyApiBase, key, strategyId, logger);
  } catch (e) {
    logger.error(`Failed to load strategy ${strategyId}: ${e.message}`);
    return { skipped: true, reason: 'strategy_fetch_error', details: [e.message] };
  }

  if (!strategy || strategy.id == null) {
    return { skipped: true, reason: 'strategy_not_found', details: [`id ${strategyId}`] };
  }

  if (targetTotalNotionalUsd != null && targetTotalNotionalUsd !== '') {
    const t = Number(targetTotalNotionalUsd);
    if (Number.isFinite(t) && t > 0) {
      const before = strategy;
      strategy = scaleStrategyToTargetTotalNotional(strategy, t);
      logger.info(
        `Manual run scaled notionals to $${t.toFixed(2)} total (template was twilight ${before.twilightSize} + cex ${before.binanceSize})`
      );
    }
  }

  logger.info(`Manual run: #${strategy.id} ${strategy.name} APY=${strategy.apy}`);
  return executeChosenStrategy({ strategy, config, portfolio, market, logger });
}

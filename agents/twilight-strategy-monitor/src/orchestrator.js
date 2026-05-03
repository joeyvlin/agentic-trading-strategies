import { fetchStrategies, fetchMarket, fetchStrategyById } from './strategyClient.js';
import { cexVenue, pickTopStrategy, scaleStrategyToTargetTotalNotional } from './normalize.js';
import { evaluateRisk } from './riskEngine.js';
import { addLogicalTrade } from './portfolio.js';
import { executeSimulation } from './executor/simulation.js';
import { executeReal } from './executor/real.js';

function entryBtcPrice(market) {
  return (
    Number(market?.btcPrice ?? market?.prices?.twilight ?? market?.prices?.binanceFutures) || 0
  );
}

/** JSON-safe summary for dashboard persistence (venue ids, previews — not full ccxt objects). */
function buildExecutionSummary(trade) {
  if (!trade) return null;
  if (trade.mode === 'simulation') {
    return {
      kind: 'simulation',
      note: 'Simulated — no live venue orders',
    };
  }
  const strategy = trade.raw?.strategy;
  const raw = trade.raw?.results;
  const summary = {
    kind: 'real',
    tradeId: trade.tradeId,
    twilight: null,
    cex: null,
  };
  if (raw?.twilight) {
    const acct =
      raw.twilightAccountIndex != null && raw.twilightAccountIndex !== ''
        ? Number(raw.twilightAccountIndex)
        : Number(process.env.TWILIGHT_ACCOUNT_INDEX ?? 0) || 0;
    summary.twilight = {
      completed: true,
      accountIndex: Number.isFinite(acct) ? acct : 0,
      stdoutPreview: String(raw.twilight.stdout || '').slice(0, 2500),
      stderrPreview: String(raw.twilight.stderr || '').slice(0, 1000),
    };
  } else if (
    strategy &&
    strategy.twilightPosition &&
    String(strategy.twilightPosition).toLowerCase() !== 'null' &&
    Number(strategy.twilightSize) > 0
  ) {
    summary.twilight = {
      completed: false,
      reason:
        raw?.results?.twilightSkippedReason ||
        'Twilight leg not executed (allow real trading or ALLOW_TWILIGHT_CLI_EXECUTION, relayer + wallet)',
    };
  }
  if (raw?.cex?.order) {
    const venue = cexVenue(strategy) || 'cex';
    const o = raw.cex.order;
    const openSide = String(o.side || '').toLowerCase();
    const filledAmt = Number(o.filled) || Number(o.amount) || 0;
    const flattenSide = openSide === 'buy' ? 'sell' : 'buy';
    summary.cex = {
      completed: true,
      venue,
      orderId: o.id != null ? String(o.id) : '',
      symbol: raw.cex.symbol || o.symbol,
      side: o.side,
      status: o.status,
      price: o.average ?? o.price,
      amount: o.amount,
      filled: o.filled,
      flattenSide,
      flattenAmount: filledAmt,
    };
  } else if (strategy && cexVenue(strategy)) {
    summary.cex = {
      completed: false,
      venue: cexVenue(strategy),
      reason: 'CEX leg missing or failed before order',
    };
  }
  return summary;
}

async function executeChosenStrategy({ strategy, config, portfolio, market, logger, relayerEnv }) {
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

  const trade = await exec({
    strategy,
    notionals,
    market,
    logger,
    relayerEnv,
    relayerCwd: config.repoRoot,
  });

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
      execution: buildExecutionSummary(trade),
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
  relayerEnv,
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
  return executeChosenStrategy({ strategy, config, portfolio, market, logger, relayerEnv });
}

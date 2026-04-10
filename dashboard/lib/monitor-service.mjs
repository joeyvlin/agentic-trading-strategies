import { loadEnv, loadAgentConfig } from '../../agents/twilight-strategy-monitor/src/config.js';
import { createLogger } from '../../agents/twilight-strategy-monitor/src/logger.js';
import {
  createPortfolioState,
  totalOpenNotional,
} from '../../agents/twilight-strategy-monitor/src/portfolio.js';
import { runOneCycle, runOneCycleForStrategy } from '../../agents/twilight-strategy-monitor/src/orchestrator.js';
import {
  appendTransaction,
  loadPortfolioSnapshot,
  loadTransactions,
  savePortfolioSnapshot,
} from './persistence.mjs';
import { appendOpenPosition } from './position-ledger.mjs';

const MAX_LOGS = 200;

function applySnapshot(portfolio, snap) {
  if (!snap || !Array.isArray(snap.logicalTrades)) return;
  portfolio.logicalTrades = snap.logicalTrades;
  portfolio.dailyLossUsd = Number(snap.dailyLossUsd) || 0;
  portfolio.dayKey = snap.dayKey || portfolio.dayKey;
}

export function createMonitorService() {
  loadEnv();

  const logBuffer = [];
  const logger = createLogger(process.env.LOG_LEVEL || 'info');
  const origInfo = logger.info.bind(logger);
  const origWarn = logger.warn.bind(logger);
  const origErr = logger.error.bind(logger);

  function pushLog(level, args) {
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logBuffer.push({ t: new Date().toISOString(), level, msg });
    if (logBuffer.length > MAX_LOGS) logBuffer.splice(0, logBuffer.length - MAX_LOGS);
  }

  logger.info = (...a) => {
    pushLog('info', a);
    origInfo(...a);
  };
  logger.warn = (...a) => {
    pushLog('warn', a);
    origWarn(...a);
  };
  logger.error = (...a) => {
    pushLog('error', a);
    origErr(...a);
  };

  let portfolio = createPortfolioState();
  applySnapshot(portfolio, loadPortfolioSnapshot());

  let timer = null;
  let running = false;
  let pollIntervalMs = 60000;
  let lastCycle = null;
  let lastError = null;
  let startedAt = null;

  async function tick(executionModeOverride) {
    lastError = null;
    try {
      const config = loadAgentConfig(logger, {
        executionMode: executionModeOverride,
      });
      pollIntervalMs = config.pollIntervalMs;
      const result = await runOneCycle({ config, portfolio, logger });
      lastCycle = {
        at: new Date().toISOString(),
        skipped: !!result.skipped,
        reason: result.reason,
        details: result.details,
        strategy: result.strategy
          ? { id: result.strategy.id, name: result.strategy.name, apy: result.strategy.apy }
          : null,
        transaction: result.transaction || null,
      };

      if (result.transaction) {
        appendTransaction(result.transaction);
        savePortfolioSnapshot(portfolio);
        if (result.strategy && result.marketSnapshot) {
          appendOpenPosition({
            transaction: result.transaction,
            strategy: result.strategy,
            marketSnapshot: result.marketSnapshot,
          });
        }
      }
      return result;
    } catch (e) {
      lastError = e.message || String(e);
      logger.error(lastError, e);
      throw e;
    }
  }

  return {
    getLogs: () => [...logBuffer].reverse(),

    getStatus: () => ({
      running,
      startedAt,
      pollIntervalMs,
      lastCycle,
      lastError,
      openNotionalUsd: totalOpenNotional(portfolio),
      logicalTradeCount: portfolio.logicalTrades.length,
    }),

    getPortfolio: () => portfolio,

    loadPersistedTransactions: () => loadTransactions(),

    getPnlSummary: () => {
      const txs = loadTransactions();
      const sumEstimatedDaily = txs.reduce(
        (s, t) => s + (Number(t.estimatedDailyUsd) || 0),
        0
      );
      return {
        transactionCount: txs.length,
        sumEstimatedDailyUsd: sumEstimatedDaily,
        openNotionalUsd: totalOpenNotional(portfolio),
        portfolioTrades: portfolio.logicalTrades.length,
      };
    },

    start: async () => {
      if (running) return { ok: false, message: 'Already running' };
      const config = loadAgentConfig(logger);
      if (config.executionMode === 'real' && process.env.CONFIRM_REAL_TRADING !== 'YES') {
        return {
          ok: false,
          message:
            'Real mode requires allowing real trading: enable it in Twilight wallet (step 1) or set CONFIRM_REAL_TRADING=YES in .env.',
        };
      }
      pollIntervalMs = config.pollIntervalMs;
      running = true;
      startedAt = new Date().toISOString();

      try {
        const run = () => tick().catch(() => {});
        await run();
        if (pollIntervalMs > 0) {
          timer = setInterval(run, pollIntervalMs);
        } else {
          running = false;
          startedAt = null;
        }
      } catch (e) {
        running = false;
        startedAt = null;
        throw e;
      }
      return { ok: true };
    },

    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      running = false;
      startedAt = null;
      return { ok: true };
    },

    runSimulationOnce: () => tick('simulation'),

    /** One cycle using current yaml execution.mode and env AGENT_MODE. */
    runOnce: () => tick(),

    /**
     * Execute a single Strategy API strategy by id (same risk/exec as monitor).
     * @param {number|string} strategyId
     * @param {'simulation'|'real'|undefined} executionModeOverride
     * @param {number|string|{ targetTotalNotionalUsd?: number, relayerEnv?: Record<string,string> }} [third]
     *        Legacy: pass target USD as third arg. Prefer `{ targetTotalNotionalUsd, relayerEnv }` for wallet from UI.
     */
    runStrategyOnce: async (strategyId, executionModeOverride, third) => {
      lastError = null;
      const config = loadAgentConfig(logger, { executionMode: executionModeOverride });
      if (config.executionMode === 'real' && process.env.CONFIRM_REAL_TRADING !== 'YES') {
        throw new Error(
          'Real mode requires allowing real trading: enable it in Twilight wallet (step 1) or set CONFIRM_REAL_TRADING=YES in .env.'
        );
      }
      let targetTotalNotionalUsd;
      let relayerEnv;
      if (third != null && typeof third === 'object' && !Array.isArray(third)) {
        targetTotalNotionalUsd = third.targetTotalNotionalUsd;
        relayerEnv = third.relayerEnv;
      } else {
        targetTotalNotionalUsd = third;
      }
      const result = await runOneCycleForStrategy({
        strategyId,
        config,
        portfolio,
        logger,
        targetTotalNotionalUsd,
        relayerEnv,
      });
      lastCycle = {
        at: new Date().toISOString(),
        skipped: !!result.skipped,
        reason: result.reason,
        details: result.details,
        strategy: result.strategy
          ? { id: result.strategy.id, name: result.strategy.name, apy: result.strategy.apy }
          : null,
        transaction: result.transaction || null,
      };

      if (result.transaction) {
        appendTransaction(result.transaction);
        savePortfolioSnapshot(portfolio);
        if (result.strategy && result.marketSnapshot) {
          appendOpenPosition({
            transaction: result.transaction,
            strategy: result.strategy,
            marketSnapshot: result.marketSnapshot,
          });
        }
      }
      return result;
    },

    resetPortfolio: () => {
      portfolio = createPortfolioState();
      savePortfolioSnapshot(portfolio);
      return { ok: true };
    },
  };
}

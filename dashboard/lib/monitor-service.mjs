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
import { appendOpenPosition, getOpenStrategyIds } from './position-ledger.mjs';
import { loadExchangeKeys } from './exchange-keys-store.mjs';

const MAX_LOGS = 200;

/**
 * Copy CEX keys from `data/exchange-keys.json` into `process.env` when vars are unset.
 * Ensures real runs from the dashboard see the same keys as the desk (avoids repo-root drift vs agent-only `cexFileCreds`).
 */
export function applyDashboardExchangeKeysToEnv() {
  let raw;
  try {
    raw = loadExchangeKeys();
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object') return;
  const b = raw.binance;
  const y = raw.bybit;
  if (!(process.env.BINANCE_API_KEY || '').trim() && b?.apiKey?.trim() && b?.apiSecret?.trim()) {
    process.env.BINANCE_API_KEY = b.apiKey.trim();
    process.env.BINANCE_API_SECRET = b.apiSecret.trim();
    if (b.useTestnet) process.env.BINANCE_USE_TESTNET = '1';
  }
  if (!(process.env.BYBIT_API_KEY || '').trim() && y?.apiKey?.trim() && y?.apiSecret?.trim()) {
    process.env.BYBIT_API_KEY = y.apiKey.trim();
    process.env.BYBIT_API_SECRET = y.apiSecret.trim();
    if (y.useTestnet) process.env.BYBIT_USE_TESTNET = '1';
  }
}

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
  /** True only after `stop()` — skips auto-recovery restarts. */
  let userStopRequested = false;
  let pollIntervalMs = 60000;
  let lastCycle = null;
  let lastError = null;
  let lastErrorStack = null;
  let startedAt = null;
  let tickInFlight = false;
  let timerIntervalMs = null;
  let recoveryTimeout = null;
  let recoveryInProgress = false;
  /** True while a post-failure timer restart is scheduled or running (avoids double setInterval on start). */
  let pendingMonitorRecovery = false;

  const monitorRestartBackoffMs = Math.max(
    3000,
    Number(process.env.MONITOR_RESTART_BACKOFF_MS) || 15000
  );

  async function tick(executionModeOverride) {
    lastError = null;
    lastErrorStack = null;
    try {
      applyDashboardExchangeKeysToEnv();
      const config = loadAgentConfig(logger, {
        executionMode: executionModeOverride,
      });
      pollIntervalMs = config.pollIntervalMs;
      const result = await runOneCycle({
        config,
        portfolio,
        logger,
        blockedStrategyIds: getOpenStrategyIds(),
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
    } catch (e) {
      lastError = e.message || String(e);
      lastErrorStack = typeof e?.stack === 'string' ? e.stack : '';
      const detail = lastErrorStack ? `${lastError}\n\n${lastErrorStack}` : lastError;
      logger.error(detail, e);
      throw e;
    }
  }

  function clearRecoverySchedule() {
    if (recoveryTimeout) {
      clearTimeout(recoveryTimeout);
      recoveryTimeout = null;
    }
    pendingMonitorRecovery = false;
  }

  function setMonitorInterval() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    timerIntervalMs = null;
    if (!running || userStopRequested || pollIntervalMs <= 0) return;
    const run = () => {
      void runMonitorPollCycle();
    };
    timer = setInterval(run, pollIntervalMs);
    timerIntervalMs = pollIntervalMs;
  }

  /**
   * If a poll cycle threw while the user still wants the monitor on, drop the old interval and start a fresh one
   * after a short backoff (debounced). Does nothing after `stop()`.
   */
  function scheduleMonitorRestartAfterFailure(reason) {
    if (userStopRequested || !running || recoveryInProgress) return;
    clearRecoverySchedule();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    timerIntervalMs = null;
    pendingMonitorRecovery = true;
    logger.warn(
      `[monitor] Poll cycle failed; will restart monitor timer after ${monitorRestartBackoffMs}ms unless stopped. (${reason})`
    );
    recoveryTimeout = setTimeout(() => {
      recoveryTimeout = null;
      if (userStopRequested || !running) {
        pendingMonitorRecovery = false;
        return;
      }
      recoveryInProgress = true;
      try {
        let cfg;
        try {
          cfg = loadAgentConfig(logger);
          pollIntervalMs = cfg.pollIntervalMs;
        } catch (e) {
          logger.error(`[monitor] Recovery: could not reload config: ${e?.message || e}`);
          pollIntervalMs = pollIntervalMs || 60000;
        }
        if (pollIntervalMs <= 0) {
          running = false;
          startedAt = null;
          pendingMonitorRecovery = false;
          logger.warn('[monitor] Recovery aborted: pollIntervalMs is 0 (single-shot mode).');
          return;
        }
        setMonitorInterval();
        pendingMonitorRecovery = false;
        logger.info('[monitor] Timer restarted after failure; running immediate poll.');
        void runMonitorPollCycle();
      } catch (e) {
        logger.error(`[monitor] Recovery failed: ${e?.message || e}`);
        pendingMonitorRecovery = false;
      } finally {
        recoveryInProgress = false;
      }
    }, monitorRestartBackoffMs);
  }

  async function runMonitorPollCycle() {
    if (!running || userStopRequested) return;
    if (tickInFlight) {
      logger.warn('[monitor] Skipping tick: previous cycle still in progress.');
      return;
    }
    tickInFlight = true;
    try {
      await tick();
      if (
        running &&
        !userStopRequested &&
        !pendingMonitorRecovery &&
        pollIntervalMs > 0 &&
        timer &&
        timerIntervalMs != null &&
        pollIntervalMs !== timerIntervalMs
      ) {
        logger.info(
          `[monitor] pollIntervalMs updated (${timerIntervalMs} -> ${pollIntervalMs}); restarting timer with new interval.`
        );
        setMonitorInterval();
      }
    } catch (e) {
      const msg = e?.message || String(e);
      scheduleMonitorRestartAfterFailure(msg);
    } finally {
      tickInFlight = false;
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
      lastErrorStack,
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
      userStopRequested = false;
      clearRecoverySchedule();
      pollIntervalMs = config.pollIntervalMs;
      running = true;
      startedAt = new Date().toISOString();

      try {
        await runMonitorPollCycle();
        if (pollIntervalMs > 0 && !timer && !pendingMonitorRecovery) {
          setMonitorInterval();
        }
        if (pollIntervalMs <= 0) {
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
      userStopRequested = true;
      clearRecoverySchedule();
      recoveryInProgress = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      timerIntervalMs = null;
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
      lastErrorStack = null;
      applyDashboardExchangeKeysToEnv();
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

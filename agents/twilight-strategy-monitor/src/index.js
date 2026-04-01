#!/usr/bin/env node
/**
 * Twilight Strategy Monitor — CLI entry.
 *
 * Usage:
 *   npm run start:sim
 *   npm run start:real
 *   node src/index.js --once
 */

import { loadEnv, loadAgentConfig } from './config.js';
import { createLogger } from './logger.js';
import { createPortfolioState } from './portfolio.js';
import { runOneCycle } from './orchestrator.js';

function parseArgs(argv) {
  const once = argv.includes('--once');
  return { once };
}

async function main() {
  loadEnv();
  const logLevel = process.env.LOG_LEVEL || 'info';
  const logger = createLogger(logLevel);
  const { once } = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = loadAgentConfig(logger);
  } catch (e) {
    logger.error(e.message);
    process.exit(1);
  }

  if (config.executionMode === 'real' && process.env.CONFIRM_REAL_TRADING !== 'YES') {
    logger.error(
      'Real execution blocked: set CONFIRM_REAL_TRADING=YES in the environment to acknowledge live trading risk.'
    );
    process.exit(1);
  }

  logger.info('Starting twilight-strategy-monitor', {
    mode: config.executionMode,
    apiBase: config.strategyApiBase,
    pollIntervalMs: config.pollIntervalMs,
    once,
  });

  const portfolio = createPortfolioState();

  const run = async () => {
    try {
      await runOneCycle({ config, portfolio, logger });
    } catch (err) {
      logger.error(err.message, err);
    }
  };

  await run();

  if (once || config.pollIntervalMs <= 0) {
    process.exit(0);
  }

  setInterval(run, config.pollIntervalMs);
}

main();

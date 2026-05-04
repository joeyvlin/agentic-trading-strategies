import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot() {
  let dir = path.resolve(__dirname, '..');
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'configs'))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '../..');
}

/** If the shell exports STRATEGY_* empty, dotenv will not override — backfill from repo `.env`. */
const BACKFILL_FROM_FILE = ['STRATEGY_API_KEY', 'STRATEGY_API_BASE_URL'];

export function loadEnv() {
  const root = findRepoRoot();
  const envPath = path.join(root, '.env');
  dotenv.config({ path: envPath });
  dotenv.config();
  if (!fs.existsSync(envPath)) return;
  try {
    const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    for (const name of BACKFILL_FROM_FILE) {
      const fromFile = parsed[name];
      if (fromFile == null || String(fromFile).trim() === '') continue;
      const cur = process.env[name];
      if (cur == null || String(cur).trim() === '') {
        process.env[name] = String(fromFile).trim();
      }
    }
  } catch {
    /* ignore parse/read errors */
  }
}

export function loadAgentConfig(logger, options = {}) {
  const root = findRepoRoot();
  const fromEnv = process.env.AGENT_CONFIG_PATH;
  const defaultPath = path.join(root, 'configs', 'agent.monitor.yaml');
  const configPath = fromEnv || defaultPath;

  if (!fs.existsSync(configPath)) {
    logger.warn(
      `No config at ${configPath}. Copy configs/agent.monitor.example.yaml to configs/agent.monitor.yaml`
    );
    throw new Error(`Missing config: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const doc = yaml.load(raw);
  const mode =
    options.executionMode ||
    process.env.AGENT_MODE ||
    doc.execution?.mode ||
    'simulation';
  if (mode !== 'simulation' && mode !== 'real') {
    throw new Error(`AGENT_MODE must be simulation or real, got: ${mode}`);
  }

  const perStrat = Number(doc.risk?.maxNotionalPerStrategyUsd);
  return {
    configPath,
    repoRoot: root,
    pollIntervalMs: Number(doc.pollIntervalMs ?? 60000),
    strategyFilters: doc.strategyFilters || {},
    risk: {
      maxTotalNotionalUsd: Number(doc.risk?.maxTotalNotionalUsd ?? 50),
      maxNotionalPerStrategyUsd:
        Number.isFinite(perStrat) && perStrat > 0 ? perStrat : Number.POSITIVE_INFINITY,
      maxNotionalPerVenueUsd: {
        twilight: Number(doc.risk?.maxNotionalPerVenueUsd?.twilight ?? 50),
        binance: Number(doc.risk?.maxNotionalPerVenueUsd?.binance ?? 50),
        bybit: Number(doc.risk?.maxNotionalPerVenueUsd?.bybit ?? 50),
      },
      maxConcurrentLogicalTrades: Number(doc.risk?.maxConcurrentLogicalTrades ?? 5),
      maxDailyLossUsd: Number(doc.risk?.maxDailyLossUsd ?? 20),
    },
    automation: {
      autoPickZkOsAccount: doc.automation?.autoPickZkOsAccount !== false,
      persistTwilightIndexAfterRotate: doc.automation?.persistTwilightIndexAfterRotate !== false,
      openTradeMaxZkAttempts: (() => {
        const n = Number(doc.automation?.openTradeMaxZkAttempts);
        return Number.isFinite(n) && n >= 1 ? Math.min(5, Math.floor(n)) : 3;
      })(),
    },
    executionMode: mode,
    strategyApiBase: process.env.STRATEGY_API_BASE_URL || 'https://strategy.lunarpunk.xyz',
    strategyApiKey: process.env.STRATEGY_API_KEY || '',
  };
}

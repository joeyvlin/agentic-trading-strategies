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

export function loadEnv() {
  const root = findRepoRoot();
  dotenv.config({ path: path.join(root, '.env') });
  dotenv.config();
}

export function loadAgentConfig(logger) {
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
  const mode = process.env.AGENT_MODE || doc.execution?.mode || 'simulation';
  if (mode !== 'simulation' && mode !== 'real') {
    throw new Error(`AGENT_MODE must be simulation or real, got: ${mode}`);
  }

  return {
    configPath,
    repoRoot: root,
    pollIntervalMs: Number(doc.pollIntervalMs ?? 60000),
    strategyFilters: doc.strategyFilters || {},
    risk: {
      maxTotalNotionalUsd: Number(doc.risk?.maxTotalNotionalUsd ?? 50_000),
      maxNotionalPerVenueUsd: {
        twilight: Number(doc.risk?.maxNotionalPerVenueUsd?.twilight ?? 25_000),
        binance: Number(doc.risk?.maxNotionalPerVenueUsd?.binance ?? 25_000),
        bybit: Number(doc.risk?.maxNotionalPerVenueUsd?.bybit ?? 25_000),
      },
      maxConcurrentLogicalTrades: Number(doc.risk?.maxConcurrentLogicalTrades ?? 3),
      maxDailyLossUsd: Number(doc.risk?.maxDailyLossUsd ?? 5000),
    },
    executionMode: mode,
    strategyApiBase: process.env.STRATEGY_API_BASE_URL || 'http://134.199.214.129:3000',
    strategyApiKey: process.env.STRATEGY_API_KEY || '',
  };
}

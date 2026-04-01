import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getRepoRoot() {
  let dir = path.resolve(__dirname, '..', '..');
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'configs'))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '..', '..');
}

const dataDir = () => path.join(getRepoRoot(), 'data');
const transactionsPath = () => path.join(dataDir(), 'transactions.json');
const portfolioPath = () => path.join(dataDir(), 'portfolio.json');

function ensureDataDir() {
  const d = dataDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function atomicWrite(file, content) {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export function loadTransactions() {
  const p = transactionsPath();
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

export function appendTransaction(record) {
  const list = loadTransactions();
  list.unshift({
    ...record,
    savedAt: new Date().toISOString(),
  });
  atomicWrite(transactionsPath(), JSON.stringify(list, null, 2));
}

export function loadPortfolioSnapshot() {
  const p = portfolioPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function savePortfolioSnapshot(portfolio) {
  atomicWrite(
    portfolioPath(),
    JSON.stringify(
      {
        logicalTrades: portfolio.logicalTrades,
        dailyLossUsd: portfolio.dailyLossUsd,
        dayKey: portfolio.dayKey,
      },
      null,
      2
    )
  );
}

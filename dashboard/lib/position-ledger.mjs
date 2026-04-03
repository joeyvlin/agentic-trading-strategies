import fs from 'fs';
import path from 'path';
import { getStrategyApiEnv } from './env-store.mjs';
import { getRepoRoot } from './persistence.mjs';
import { fetchMarket } from '../../agents/twilight-strategy-monitor/src/strategyClient.js';

function ledgerPath() {
  return path.join(getRepoRoot(), 'data', 'positions.json');
}

function ensureDir() {
  const d = path.join(getRepoRoot(), 'data');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadLedger() {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return { open: [], closed: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      open: Array.isArray(j.open) ? j.open : [],
      closed: Array.isArray(j.closed) ? j.closed : [],
    };
  } catch {
    return { open: [], closed: [] };
  }
}

function atomicWrite(obj) {
  ensureDir();
  const p = ledgerPath();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * Unrealized PnL (USD) for Twilight directional leg — mark-to-market vs entry BTC.
 * Uses margin/size snapshot at open; illustrative for hedged books.
 */
export function unrealizedUsdForOpen(open, currentBtc) {
  const e = Number(open.entryBtcPrice);
  const p = Number(currentBtc);
  if (!e || !p || e <= 0) return 0;
  const move = (p - e) / e;
  const exp = Number(open.exposureUsd) || 0;
  const pos = String(open.twilightPosition || '').toUpperCase();
  if (pos === 'SHORT') return -move * exp;
  if (pos === 'LONG') return move * exp;
  return 0;
}

export function appendOpenPosition({ transaction, strategy, marketSnapshot }) {
  if (!transaction?.tradeId || !strategy) return;
  const data = loadLedger();
  if (data.open.some((x) => x.tradeId === transaction.tradeId)) return;

  const exposureUsd =
    Number(strategy.twilightMarginUSD) ||
    Number(strategy.totalMargin) ||
    Number(strategy.twilightSize) ||
    0;

  data.open.unshift({
    tradeId: transaction.tradeId,
    openedAt: transaction.at || new Date().toISOString(),
    strategyId: strategy.id,
    strategyName: strategy.name,
    mode: transaction.mode,
    twilightPosition: strategy.twilightPosition || null,
    entryBtcPrice: Number(marketSnapshot?.btcPrice) || 0,
    exposureUsd,
    notionalUsd: Number(transaction.totalNotionalUsd) || 0,
    venues: transaction.venues || {},
  });
  atomicWrite(data);
}

export function closePosition(tradeId, realizedPnlUsd) {
  const data = loadLedger();
  const idx = data.open.findIndex((x) => x.tradeId === tradeId);
  if (idx < 0) return { ok: false, error: 'Open position not found' };
  const [row] = data.open.splice(idx, 1);
  data.closed.unshift({
    ...row,
    closedAt: new Date().toISOString(),
    realizedPnlUsd: Number(realizedPnlUsd) || 0,
  });
  atomicWrite(data);
  return { ok: true };
}

export async function getPositionPnlSummary() {
  const data = loadLedger();
  const { base: baseUrl, key } = getStrategyApiEnv();
  let currentBtc = 0;
  try {
    if (key) {
      const m = await fetchMarket(baseUrl, key);
      currentBtc = Number(m?.btcPrice ?? m?.prices?.twilight) || 0;
    }
  } catch {
    /* unrealized stays 0 if market unavailable */
  }

  let unrealizedTotal = 0;
  const openWithUnreal = data.open.map((o) => {
    const u = key ? unrealizedUsdForOpen(o, currentBtc) : 0;
    unrealizedTotal += u;
    return { ...o, unrealizedPnlUsd: u };
  });

  const realizedTotal = data.closed.reduce((s, c) => s + (Number(c.realizedPnlUsd) || 0), 0);

  return {
    currentBtcPrice: currentBtc,
    realizedPnlUsd: realizedTotal,
    unrealizedPnlUsd: unrealizedTotal,
    openPositions: openWithUnreal,
    closedPositions: data.closed,
    openCount: data.open.length,
    closedCount: data.closed.length,
    pnlNote:
      'Realized PnL is from positions you mark closed with an entered amount. Unrealized uses a simple BTC mark vs entry on the Twilight leg (see exposure snapshot).',
  };
}

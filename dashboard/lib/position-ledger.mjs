import fs from 'fs';
import path from 'path';
import { getStrategyApiEnv } from './env-store.mjs';
import { getRepoRoot } from './persistence.mjs';
import { fetchMarket } from '../../agents/twilight-strategy-monitor/src/strategyClient.js';
import { cexPositionSide, cexSizeUsd, cexVenue } from '../../agents/twilight-strategy-monitor/src/normalize.js';

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

export function getOpenPosition(tradeId) {
  const data = loadLedger();
  return data.open.find((x) => x.tradeId === tradeId) || null;
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

  const twilightSizeUsd = Number(strategy.twilightSize) || 0;
  const twilightLev = strategy.twilightLeverage;
  const venue = cexVenue(strategy);
  const cexPos = cexPositionSide(strategy);
  const cexUsd = cexSizeUsd(strategy);

  const ex = transaction.execution || {};
  let twilightAccountIndex = null;
  if (ex.twilight?.completed && ex.twilight.accountIndex != null) {
    const n = Number(ex.twilight.accountIndex);
    twilightAccountIndex = Number.isFinite(n) ? n : null;
  }
  let cexFlatten = null;
  if (
    ex.cex?.completed &&
    ex.cex.flattenSide &&
    ex.cex.symbol &&
    ex.cex.venue &&
    Number(ex.cex.flattenAmount) > 0
  ) {
    cexFlatten = {
      venue: String(ex.cex.venue).toLowerCase(),
      symbol: ex.cex.symbol,
      side: String(ex.cex.flattenSide).toLowerCase(),
      amount: Number(ex.cex.flattenAmount),
    };
  }

  data.open.unshift({
    tradeId: transaction.tradeId,
    openedAt: transaction.at || new Date().toISOString(),
    strategyId: strategy.id,
    strategyName: strategy.name,
    mode: transaction.mode,
    twilightPosition: strategy.twilightPosition || null,
    twilightLeverage: twilightLev != null && twilightLev !== '' ? Number(twilightLev) : null,
    twilightSizeUsd,
    cexVenue: venue,
    cexPosition: cexPos != null ? String(cexPos) : null,
    cexNotionalUsd: cexUsd,
    entryBtcPrice: Number(marketSnapshot?.btcPrice) || 0,
    exposureUsd,
    notionalUsd: Number(transaction.totalNotionalUsd) || 0,
    venues: transaction.venues || {},
    twilightAccountIndex,
    cexFlatten,
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
      'Close sends real venue exits when this row was opened in real mode (Twilight market close via relayer when that leg executed, then CEX reduce-only when the hedge leg executed). Simulation rows only update the ledger. Real closes need wallet + password in step 1, RELAYER_ALLOW_DASHBOARD_ORDERS=YES for Twilight, and CEX keys for the hedge. Leave optional realized $ blank to record Twilight-leg mark-to-market at close time.',
  };
}

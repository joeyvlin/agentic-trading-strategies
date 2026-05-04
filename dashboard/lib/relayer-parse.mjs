/**
 * Parse human-oriented relayer-cli stdout for dashboard use.
 */

export function parseTwilightAddressFromBalanceStdout(stdout) {
  const m = String(stdout).match(/Address:\s*(\S+)/);
  return m ? m[1] : null;
}

/**
 * Parses `wallet list` table output (wallet list ignores JSON flag).
 */
/**
 * Best-effort parse of spendable on-chain sats from `wallet balance --json` (or plain text) stdout.
 * Relayer JSON shapes vary by version; we try named keys then recursive numeric hints.
 */
/**
 * NYKS line (Twilight token) — not spendable as BTC for `zkaccount fund`.
 */
export function parseNyksBalanceFromWalletBalanceText(stdout) {
  const m = String(stdout || '').match(/^\s*NYKS:\s*(\d+)/im);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function parseSpendableSatsFromWalletBalance(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  // Text output (even with --json): "SATS: N" is on-chain BTC for zkaccount fund — do not use NYKS here.
  const satsLine = raw.match(/^\s*SATS:\s*(\d+)/im);
  if (satsLine) {
    const n = Number(satsLine[1]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
  try {
    const j = JSON.parse(raw);
    const fromObj = extractSatsFromBalanceJson(j);
    if (fromObj != null) return fromObj;
  } catch {
    /* not JSON */
  }
  const text = raw.replace(/,/g, '');
  const patterns = [
    /spendable[:\s]+(\d+)/i,
    /available[:\s]+(\d+)\s*sats/i,
    /(\d+)\s*sats/i,
    /"spendable_sats"\s*:\s*(\d+)/i,
    /"balance_sats"\s*:\s*(\d+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
  }
  // Do not treat NYKS: as BTC sats (would break ZkOS fund UI when SATS: 0).
  return null;
}

/**
 * Best-effort pending / unconfirmed BTC (sats) not yet counted as spendable — if the relayer exposes it.
 */
export function parsePendingSatsFromWalletBalance(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    const fromObj = extractPendingFromBalanceJson(j);
    if (fromObj != null) return fromObj;
  } catch {
    /* not JSON */
  }
  const m =
    raw.match(/pending[^0-9]*(\d+)/i) ||
    raw.match(/unconfirmed[^0-9]*(\d+)/i) ||
    raw.match(/mempool[^0-9]*(\d+)/i);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
  return null;
}

function extractPendingFromBalanceJson(obj, depth = 0) {
  if (depth > 10 || obj == null) return null;
  if (typeof obj !== 'object') return null;

  const preferredKeys = [
    'pending_sats',
    'pendingSats',
    'unconfirmed_sats',
    'unconfirmedSats',
    'mempool_sats',
    'mempoolSats',
    'pending_btc_sats',
  ];
  if (!Array.isArray(obj)) {
    for (const k of preferredKeys) {
      if (obj[k] != null) {
        const n = Number(obj[k]);
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (/pending|unconfirmed|mempool/i.test(k) && v != null && typeof v !== 'object') {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
      }
    }
  }
  const values = Array.isArray(obj) ? obj : Object.values(obj);
  for (const v of values) {
    if (v != null && typeof v === 'object') {
      const inner = extractPendingFromBalanceJson(v, depth + 1);
      if (inner != null) return inner;
    }
  }
  return null;
}

function extractSatsFromBalanceJson(obj, depth = 0) {
  if (depth > 10 || obj == null) return null;
  if (typeof obj !== 'object') return null;

  const preferredKeys = [
    'spendable_sats',
    'spendableSats',
    'available_sats',
    'availableSats',
    'balance_sats',
    'balanceSats',
    'confirmed_sats',
    'sats',
    'amount_sats',
  ];
  if (!Array.isArray(obj)) {
    for (const k of preferredKeys) {
      if (obj[k] != null) {
        const n = Number(obj[k]);
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (/sat|spendable|available|balance|amount/i.test(k) && v != null && typeof v !== 'object') {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
      }
    }
  }
  const values = Array.isArray(obj) ? obj : Object.values(obj);
  for (const v of values) {
    if (v != null && typeof v === 'object') {
      const inner = extractSatsFromBalanceJson(v, depth + 1);
      if (inner != null) return inner;
    }
  }
  return null;
}

export { parseZkOsAccountIndicesFromAccountsStdout } from '../../agents/twilight-strategy-monitor/src/zkOsAccounts.js';

export function parseWalletListStdout(stdout) {
  const lines = String(stdout).split('\n');
  let pastSep = false;
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^[-]{10,}/.test(t)) {
      pastSep = true;
      continue;
    }
    if (!pastSep) continue;
    const trimmed = line.trimEnd();
    const parts = trimmed.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [walletId, createdAt] = parts;
    if (walletId === 'WALLET ID' || walletId.startsWith('Total:')) continue;
    out.push({ walletId, createdAt });
  }
  return out;
}

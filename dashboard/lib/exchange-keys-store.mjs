import fs from 'fs';
import path from 'path';
import { getRepoRoot } from './persistence.mjs';

function keysPath() {
  return path.join(getRepoRoot(), 'data', 'exchange-keys.json');
}

function ensureDir() {
  const dir = path.join(getRepoRoot(), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function maskKey(secret) {
  if (!secret || typeof secret !== 'string') return '';
  const s = secret.trim();
  if (s.length <= 6) return '***';
  return `…${s.slice(-4)}`;
}

/**
 * @returns {{ binance: object, bybit: object } | null}
 */
export function loadExchangeKeys() {
  const p = keysPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function maskedExchangeKeysForClient() {
  const raw = loadExchangeKeys();
  if (!raw) {
    return {
      binance: { configured: false },
      bybit: { configured: false },
    };
  }
  const bin = raw.binance || {};
  const by = raw.bybit || {};
  return {
    binance: {
      configured: !!(bin.apiKey && bin.apiSecret),
      apiKeySuffix: maskKey(bin.apiKey),
      useTestnet: !!bin.useTestnet,
    },
    bybit: {
      configured: !!(by.apiKey && by.apiSecret),
      apiKeySuffix: maskKey(by.apiKey),
      useTestnet: !!by.useTestnet,
    },
  };
}

function mergeVenue(prevV, bodyV) {
  const p = prevV || { apiKey: '', apiSecret: '', useTestnet: false };
  if (!bodyV || typeof bodyV !== 'object') {
    return { apiKey: p.apiKey || '', apiSecret: p.apiSecret || '', useTestnet: !!p.useTestnet };
  }
  return {
    apiKey: typeof bodyV.apiKey === 'string' ? bodyV.apiKey : p.apiKey || '',
    apiSecret: typeof bodyV.apiSecret === 'string' ? bodyV.apiSecret : p.apiSecret || '',
    useTestnet:
      typeof bodyV.useTestnet === 'boolean' ? bodyV.useTestnet : !!p.useTestnet,
  };
}

/**
 * @param {{ binance?: object, bybit?: object }} body
 */
export function saveExchangeKeys(body) {
  ensureDir();
  const prev = loadExchangeKeys() || {};
  const next = {
    binance: mergeVenue(prev.binance, body?.binance),
    bybit: mergeVenue(prev.bybit, body?.bybit),
  };
  const p = keysPath();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* ignore on Windows */
  }
  return maskedExchangeKeysForClient();
}

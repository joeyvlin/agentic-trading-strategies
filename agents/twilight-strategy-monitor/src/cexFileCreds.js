import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function findRepoRoot() {
  let dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'configs'))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function loadDashboardExchangeKeys() {
  try {
    const p = path.join(findRepoRoot(), 'data', 'exchange-keys.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * Resolve Binance futures API creds: `.env` first, then dashboard `data/exchange-keys.json`.
 * @returns {{ apiKey: string, secret: string, useTestnet: boolean } | null}
 */
export function resolveBinanceCredsForReal() {
  const apiKey = (process.env.BINANCE_API_KEY || '').trim();
  const secret = (process.env.BINANCE_API_SECRET || '').trim();
  if (apiKey && secret) {
    return { apiKey, secret, useTestnet: process.env.BINANCE_USE_TESTNET === '1' };
  }
  const file = loadDashboardExchangeKeys()?.binance;
  if (file?.apiKey?.trim() && file?.apiSecret?.trim()) {
    return {
      apiKey: file.apiKey.trim(),
      secret: file.apiSecret.trim(),
      useTestnet: !!file.useTestnet,
    };
  }
  return null;
}

/**
 * Resolve Bybit API creds: `.env` first, then dashboard `data/exchange-keys.json`.
 * @returns {{ apiKey: string, secret: string, useTestnet: boolean } | null}
 */
export function resolveBybitCredsForReal() {
  const apiKey = (process.env.BYBIT_API_KEY || '').trim();
  const secret = (process.env.BYBIT_API_SECRET || '').trim();
  if (apiKey && secret) {
    return { apiKey, secret, useTestnet: process.env.BYBIT_USE_TESTNET === '1' };
  }
  const file = loadDashboardExchangeKeys()?.bybit;
  if (file?.apiKey?.trim() && file?.apiSecret?.trim()) {
    return {
      apiKey: file.apiKey.trim(),
      secret: file.apiSecret.trim(),
      useTestnet: !!file.useTestnet,
    };
  }
  return null;
}

import ccxt from 'ccxt';
import { resolveBinanceCredsForReal, resolveBybitCredsForReal } from '../../agents/twilight-strategy-monitor/src/cexFileCreds.js';

async function createCcxExchange(venue) {
  if (venue === 'binance') {
    const creds = resolveBinanceCredsForReal();
    if (!creds) {
      throw new Error(
        'Binance futures API key and secret are required. Save keys in CEX keys (step 4) or set BINANCE_API_KEY / BINANCE_API_SECRET.'
      );
    }
    const ex = new ccxt.binanceusdm({
      apiKey: creds.apiKey,
      secret: creds.secret,
      enableRateLimit: true,
      options: { defaultType: 'future' },
    });
    if (creds.useTestnet) ex.setSandboxMode(true);
    return ex;
  }
  if (venue === 'bybit') {
    const creds = resolveBybitCredsForReal();
    if (!creds) {
      throw new Error(
        'Bybit API key and secret are required. Save keys in CEX keys (step 4) or set BYBIT_API_KEY / BYBIT_API_SECRET.'
      );
    }
    const ex = new ccxt.bybit({
      apiKey: creds.apiKey,
      secret: creds.secret,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    if (creds.useTestnet) ex.setSandboxMode(true);
    return ex;
  }
  throw new Error(`Unsupported CEX venue: ${venue}`);
}

/**
 * Market order to flatten an open hedge leg (reduce-only).
 * @param {{ venue: 'binance'|'bybit', symbol: string, side: 'buy'|'sell', amount: number }} p
 */
export async function flattenCexPosition(p) {
  const venue = String(p.venue || '').toLowerCase();
  const symbol = String(p.symbol || '').trim();
  const side = String(p.side || '').toLowerCase();
  const amount = Number(p.amount);
  if (!symbol) throw new Error('CEX flatten: symbol is required');
  if (side !== 'buy' && side !== 'sell') throw new Error('CEX flatten: side must be buy or sell');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('CEX flatten: amount must be a positive number');

  const ex = await createCcxExchange(venue);
  await ex.loadMarkets();
  const amt = ex.amountToPrecision(symbol, amount);
  const params = { reduceOnly: true };
  const order = await ex.createOrder(symbol, 'market', side, Number(amt), undefined, params);
  return { order, symbol, venue, side, amount: Number(amt) };
}

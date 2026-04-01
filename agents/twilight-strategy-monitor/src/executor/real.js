import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import ccxt from 'ccxt';
import { cexVenue, estimateVenueNotionals } from '../normalize.js';

function btcPriceFromMarket(market, venue) {
  const p = market?.prices;
  if (!p) return Number(market?.btcPrice) || 0;
  if (venue === 'bybit') return Number(p.bybit) || Number(p.twilight) || 0;
  return Number(p.binanceFutures) || Number(p.twilight) || 0;
}

async function createCcxExchange(venue) {
  if (venue === 'binance') {
    const apiKey = process.env.BINANCE_API_KEY || '';
    const secret = process.env.BINANCE_API_SECRET || '';
    if (!apiKey || !secret) {
      throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET are required for real Binance execution');
    }
    const ex = new ccxt.binanceusdm({
      apiKey,
      secret,
      enableRateLimit: true,
      options: { defaultType: 'future' },
    });
    if (process.env.BINANCE_USE_TESTNET === '1') {
      ex.setSandboxMode(true);
    }
    return ex;
  }
  if (venue === 'bybit') {
    const apiKey = process.env.BYBIT_API_KEY || '';
    const secret = process.env.BYBIT_API_SECRET || '';
    if (!apiKey || !secret) {
      throw new Error('BYBIT_API_KEY and BYBIT_API_SECRET are required for real Bybit execution');
    }
    const ex = new ccxt.bybit({
      apiKey,
      secret,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    if (process.env.BYBIT_USE_TESTNET === '1') {
      ex.setSandboxMode(true);
    }
    return ex;
  }
  throw new Error(`Unsupported CEX venue: ${venue}`);
}

/**
 * Place a single market order on the CEX leg (Binance USDM or Bybit inverse perp).
 * Amount is derived from USD notional / price.
 */
async function placeCexMarketOrder({ venue, positionSide, sizeUsd, market, logger }) {
  const price = btcPriceFromMarket(market, venue);
  if (!price || price <= 0) throw new Error('Could not resolve BTC price from /api/market');

  const ex = await createCcxExchange(venue);
  await ex.loadMarkets();

  const side =
    String(positionSide).toUpperCase() === 'LONG' ? 'buy' : 'sell';
  const amountBtc = sizeUsd / price;

  let symbol;
  let amount = amountBtc;
  if (venue === 'binance') {
    symbol = 'BTC/USDT:USDT';
    const marketInfo = ex.market(symbol);
    amount = ex.amountToPrecision(symbol, amountBtc);
  } else {
    symbol = 'BTC/USD:BTC';
    amount = ex.amountToPrecision(symbol, amountBtc);
  }

  logger.info(`[REAL] CEX ${venue} ${side} ${symbol} amount=${amount} (≈$${sizeUsd} @ $${price})`);

  const order = await ex.createOrder(symbol, 'market', side, amount);
  return { order, symbol, price, amountBtc: Number(amount) };
}

function runRelayerCli(args, logger) {
  const bin = process.env.TWILIGHT_RELAYER_CLI || 'relayer-cli';
  return new Promise((resolve, reject) => {
    logger.info(`[REAL] spawning: ${bin} ${args.join(' ')}`);
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`relayer-cli exited ${code}: ${err || out}`));
      } else {
        resolve({ stdout: out, stderr: err });
      }
    });
    child.on('error', reject);
  });
}

/**
 * Real execution: optional Twilight via relayer-cli; CEX via ccxt when configured.
 * Twilight CLI is off unless ALLOW_TWILIGHT_CLI_EXECUTION=1.
 */
export async function executeReal({ strategy, notionals, market, logger }) {
  const id = randomUUID();
  const venue = cexVenue(strategy);
  const price = Math.round(btcPriceFromMarket(market, venue || 'binance'));

  const twilightLeg =
    strategy.twilightPosition &&
    String(strategy.twilightPosition).toLowerCase() !== 'null' &&
    Number(strategy.twilightSize) > 0;

  const results = { tradeId: id, mode: 'real', twilight: null, cex: null };

  if (twilightLeg && process.env.ALLOW_TWILIGHT_CLI_EXECUTION === '1') {
    const accountIndex = process.env.TWILIGHT_ACCOUNT_INDEX || '0';
    const side = String(strategy.twilightPosition).toLowerCase();
    const lev = String(strategy.twilightLeverage);
    const args = [
      'order',
      'open-trade',
      '--account-index',
      accountIndex,
      '--side',
      side,
      '--entry-price',
      String(price),
      '--leverage',
      lev,
      '--order-type',
      'MARKET',
      '--no-wait',
    ];
    results.twilight = await runRelayerCli(args, logger);
  } else if (twilightLeg) {
    logger.warn(
      '[REAL] Twilight leg skipped (set ALLOW_TWILIGHT_CLI_EXECUTION=1 and configure TWILIGHT_RELAYER_CLI / wallet env).'
    );
  }

  if (venue) {
    results.cex = await placeCexMarketOrder({
      venue,
      positionSide: strategy.binancePosition,
      sizeUsd: Number(strategy.binanceSize),
      market,
      logger,
    });
  }

  logger.info(`[REAL] logical trade ${id} completed`, {
    notionals,
    results: {
      twilight: results.twilight ? 'ok' : 'skipped',
      cex: results.cex ? 'ok' : 'none',
    },
  });

  return {
    tradeId: id,
    mode: 'real',
    totalNotionalUsd: notionals.total,
    venues: {
      twilight: notionals.twilight,
      binance: notionals.binance,
      bybit: notionals.bybit,
    },
    raw: { strategy, results },
  };
}

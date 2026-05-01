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

function mergedRelayerEnv(relayerEnv) {
  return relayerEnv && typeof relayerEnv === 'object'
    ? { ...process.env, ...relayerEnv }
    : { ...process.env };
}

/** Argv for logging only (never log passphrase). */
function argvForLog(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--password' && i + 1 < argv.length) {
      out.push('--password', '[redacted]');
      i++;
    } else {
      out.push(argv[i]);
    }
  }
  return out.join(' ');
}

/**
 * Parse `relayer-cli wallet accounts --json` stdout into numeric ZkOS account indices.
 * Handles plain-text "No ZkOS accounts found", JSON arrays, and common object shapes.
 * @param {string} stdout
 * @returns {number[]}
 */
function parseZkOsAccountIndicesFromAccountsStdout(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return [];
  if (/no zkos accounts found/i.test(s)) return [];

  const collectFromObject = (row) => {
    if (row == null || typeof row !== 'object') return null;
    const raw =
      row.account_index ?? row.accountIndex ?? row.index ?? row.zk_account_index;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) {
      return j.map(collectFromObject).filter((n) => n != null);
    }
    if (j && typeof j === 'object') {
      for (const key of ['accounts', 'zkosAccounts', 'zkAccounts', 'data']) {
        const arr = j[key];
        if (Array.isArray(arr)) {
          return arr.map(collectFromObject).filter((n) => n != null);
        }
      }
      const one = collectFromObject(j);
      if (one != null) return [one];
    }
  } catch {
    /* fall through to heuristics */
  }

  const found = new Set();
  const re = /(?:account_index|accountIndex|index)\s*[:=]\s*(\d+)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) found.add(n);
  }
  // Fallback for table/plain-text rows:
  // INDEX    BALANCE ...
  // 0        48750   ...
  // 1        15375   ...
  for (const line of s.split('\n')) {
    const row = /^\s*(\d+)\s+/.exec(line);
    if (!row) continue;
    const n = Number(row[1]);
    if (Number.isFinite(n)) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

function formatRelayerCliError(code, stderr, stdout) {
  const errText = String(stderr || '').trim();
  const outText = String(stdout || '').trim();
  const combined = `${errText}\n${outText}`;
  let msg = `relayer-cli exited ${code}: ${errText || outText || '(no output)'}`;
  if (/No encrypted wallet|encrypted wallet\/password found/i.test(combined)) {
    msg +=
      '\n\nHint: if `wallet list` shows this id, the passphrase is usually wrong, or relayer was using a different working directory than the dashboard (fixed in recent server code: open-trade now uses repo root as cwd). Re-enter the password in Twilight wallet (step 1) and retry.';
  }
  if (/Account with index \d+ does not exist/i.test(combined)) {
    msg +=
      '\n\nHint: that ZkOS account index is not created yet. List indices (`relayer-cli wallet accounts --wallet-id … --password …` or the dashboard), fund the account if needed (`zkaccount fund`), then set TWILIGHT_ACCOUNT_INDEX to an existing index (default is 0).';
  }
  return msg;
}

/** Merge request/session wallet into env for relayer (no .env required). */
function runRelayerCli(args, logger, relayerEnv = {}, spawnOpts = {}) {
  const bin = process.env.TWILIGHT_RELAYER_CLI || 'relayer-cli';
  const env = mergedRelayerEnv(relayerEnv);
  const cwd = spawnOpts.cwd;
  return new Promise((resolve, reject) => {
    logger.info(`[REAL] spawning: ${bin} ${argvForLog(args)}${cwd ? ` (cwd=${cwd})` : ''}`);
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      ...(cwd ? { cwd } : {}),
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
        reject(new Error(formatRelayerCliError(code, err, out)));
      } else {
        resolve({ stdout: out, stderr: err });
      }
    });
    child.on('error', reject);
  });
}

function twilightCliExplicitlyDisabled() {
  return process.env.ALLOW_TWILIGHT_CLI_EXECUTION === '0';
}

/**
 * Run Twilight relayer when explicitly allowed, or when real trading is already confirmed
 * (CONFIRM_REAL_TRADING=YES). Opt out with ALLOW_TWILIGHT_CLI_EXECUTION=0.
 */
function shouldRunTwilightCli() {
  if (twilightCliExplicitlyDisabled()) return false;
  if (process.env.ALLOW_TWILIGHT_CLI_EXECUTION === '1') return true;
  return process.env.CONFIRM_REAL_TRADING === 'YES';
}

/**
 * Real execution: optional Twilight via relayer-cli; CEX via ccxt when configured.
 * @param {{ strategy: object, notionals: object, market: object, logger: object, relayerEnv?: Record<string,string>, relayerCwd?: string }} opts
 */
export async function executeReal({ strategy, notionals, market, logger, relayerEnv, relayerCwd }) {
  const id = randomUUID();
  const venue = cexVenue(strategy);
  const price = Math.round(btcPriceFromMarket(market, venue || 'binance'));

  const twilightLeg =
    strategy.twilightPosition &&
    String(strategy.twilightPosition).toLowerCase() !== 'null' &&
    Number(strategy.twilightSize) > 0;

  const results = { tradeId: id, mode: 'real', twilight: null, cex: null, twilightSkippedReason: null };

  if (twilightLeg && shouldRunTwilightCli()) {
    const accountIndex = process.env.TWILIGHT_ACCOUNT_INDEX || '0';
    const side = String(strategy.twilightPosition).toLowerCase();
    const lev = String(strategy.twilightLeverage);
    const env = mergedRelayerEnv(relayerEnv);
    const walletId = String(env.NYKS_WALLET_ID || '').trim();
    const password = String(env.NYKS_WALLET_PASSPHRASE || '');
    if (!walletId || !password) {
      throw new Error(
        'Twilight order needs wallet id and passphrase in a non-interactive run. Fill wallet + password in Twilight wallet (step 1) when you click Real, or set NYKS_WALLET_ID and NYKS_WALLET_PASSPHRASE in the environment.'
      );
    }
    const idxNum = Number(accountIndex);
    const listArgs = [
      'wallet',
      'accounts',
      '--wallet-id',
      walletId,
      '--password',
      password,
      '--json',
    ];
    let listed;
    try {
      listed = await runRelayerCli(listArgs, logger, relayerEnv, { cwd: relayerCwd });
    } catch (e) {
      throw new Error(
        `[ZKOS_PREFLIGHT] Could not list ZkOS accounts before real trade: ${e?.message || String(e)}\n` +
          'Fix: run “List ZkOS accounts” in the dashboard (step 3b) or `relayer-cli wallet accounts --wallet-id … --password … --json`, then fund if empty (`zkaccount fund`).'
      );
    }
    const indices = parseZkOsAccountIndicesFromAccountsStdout(listed.stdout);
    const want = Number.isFinite(idxNum) ? idxNum : 0;
    if (!indices.includes(want)) {
      const have = indices.length ? indices.join(', ') : '(none — wallet has no ZkOS accounts yet)';
      throw new Error(
        `[ZKOS_PREFLIGHT] Real run blocked — ZkOS account index ${want} is not available for wallet "${walletId}". ` +
          `Known indices: ${have}.\n` +
          '“No ZkOS accounts found” means you still need a first fund: use ZkOS (step 3b) → Fund account with spendable on-chain sats, then set TWILIGHT_ACCOUNT_INDEX to an index that exists (often 0 after first fund).'
      );
    }
    // Pass credentials on argv so relayer does not try to read a TTY (headless spawn has no /dev/tty → errno 6 on macOS).
    // Omit --no-wait: some relayer-cli builds do not support it.
    const args = [
      'order',
      'open-trade',
      '--wallet-id',
      walletId,
      '--password',
      password,
      '--account-index',
      String(accountIndex),
      '--side',
      side,
      '--entry-price',
      String(price),
      '--leverage',
      lev,
      '--order-type',
      'MARKET',
    ];
    results.twilight = await runRelayerCli(args, logger, relayerEnv, {
      cwd: relayerCwd,
    });
  } else if (twilightLeg) {
    const reason = twilightCliExplicitlyDisabled()
      ? 'Twilight leg skipped (ALLOW_TWILIGHT_CLI_EXECUTION=0).'
      : 'Twilight leg skipped: enable “Allow real trading” (CONFIRM_REAL_TRADING=YES), or set ALLOW_TWILIGHT_CLI_EXECUTION=1, and configure relayer + wallet.';
    results.twilightSkippedReason = reason;
    logger.warn(`[REAL] ${reason}`);
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

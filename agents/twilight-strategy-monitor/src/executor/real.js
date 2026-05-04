import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import ccxt from 'ccxt';
import { resolveBinanceCredsForReal, resolveBybitCredsForReal } from '../cexFileCreds.js';
import { cexVenue, estimateVenueNotionals, cexPositionSide, cexSizeUsd } from '../normalize.js';
import {
  pickZkOsIndexForOpenTrade,
  parseZkOsAccountRows,
  parseZkOsAccountIndicesFromAccountsStdout,
  pickNextCoinZkOsIndexAfterFailure,
  shouldRetryTwilightOpenAfterZkRefresh,
} from '../zkOsAccounts.js';

function btcPriceFromMarket(market, venue) {
  const p = market?.prices;
  if (!p) return Number(market?.btcPrice) || 0;
  if (venue === 'bybit') return Number(p.bybit) || Number(p.twilight) || 0;
  return Number(p.binanceFutures) || Number(p.twilight) || 0;
}

async function createCcxExchange(venue) {
  if (venue === 'binance') {
    const creds = resolveBinanceCredsForReal();
    if (!creds) {
      throw new Error(
        'Binance futures API key and secret are required for real execution. Set BINANCE_API_KEY / BINANCE_API_SECRET in .env, or save keys under CEX keys in the dashboard (data/exchange-keys.json).'
      );
    }
    const ex = new ccxt.binanceusdm({
      apiKey: creds.apiKey,
      secret: creds.secret,
      enableRateLimit: true,
      options: { defaultType: 'future' },
    });
    if (creds.useTestnet) {
      ex.setSandboxMode(true);
    }
    return ex;
  }
  if (venue === 'bybit') {
    const creds = resolveBybitCredsForReal();
    if (!creds) {
      throw new Error(
        'Bybit API key and secret are required for real execution. Set BYBIT_API_KEY / BYBIT_API_SECRET in .env, or save keys under CEX keys in the dashboard (data/exchange-keys.json).'
      );
    }
    const ex = new ccxt.bybit({
      apiKey: creds.apiKey,
      secret: creds.secret,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    if (creds.useTestnet) {
      ex.setSandboxMode(true);
    }
    return ex;
  }
  throw new Error(`Unsupported CEX venue: ${venue}`);
}

/**
 * Place a single market order on the CEX leg (Binance USDM or Bybit inverse perp).
 * Binance: amount is base BTC (notional USD / price). Bybit BTC/USD inverse: ccxt amount is
 * integer contracts where 1 contract ≈ $1 USD notional (not BTC).
 */
async function placeCexMarketOrder({ venue, positionSide, sizeUsd, market, logger }) {
  const price = btcPriceFromMarket(market, venue);
  if (!price || price <= 0) throw new Error('Could not resolve BTC price from /api/market');

  const ex = await createCcxExchange(venue);
  await ex.loadMarkets();

  const side =
    String(positionSide).toUpperCase() === 'LONG' ? 'buy' : 'sell';
  const notionUsd = Number(sizeUsd);
  if (!Number.isFinite(notionUsd) || notionUsd <= 0) {
    throw new Error(`Invalid CEX leg notional: ${sizeUsd}`);
  }

  let symbol;
  let amount;
  let amountBtcEquiv = notionUsd / price;

  if (venue === 'binance') {
    symbol = 'BTC/USDT:USDT';
    amount = ex.amountToPrecision(symbol, amountBtcEquiv);
  } else {
    symbol = 'BTC/USD:BTC';
    const marketInfo = ex.market(symbol);
    const minContracts = Number(marketInfo.limits?.amount?.min ?? 1);
    // amountToPrecision on this market rounds toward zero; values < minContracts throw inside ccxt.
    if (notionUsd < minContracts) {
      throw new Error(
        `[CEX_MIN_NOTIONAL] Bybit inverse leg is $${notionUsd.toFixed(2)}; minimum order size is ${minContracts} contract(s) (~$${minContracts}). ` +
          'Increase target total notional or use a template with a larger share on the Bybit leg.'
      );
    }
    amount = ex.amountToPrecision(symbol, notionUsd);
    const n = Number(amount);
    if (!Number.isFinite(n) || n < minContracts) {
      throw new Error(
        `[CEX_MIN_NOTIONAL] Bybit inverse order size ${amount} contracts is below minimum ${minContracts} (from $${notionUsd.toFixed(2)} notional). ` +
          'Increase target total notional so the CEX leg is at least ~$1 after scaling.'
      );
    }
  }

  logger.info(`[REAL] CEX ${venue} ${side} ${symbol} amount=${amount} (≈$${notionUsd} @ $${price})`);

  const order = await ex.createOrder(symbol, 'market', side, amount);
  return {
    order,
    symbol,
    price,
    amountBtc: venue === 'binance' ? Number(amount) : amountBtcEquiv,
    ...(venue === 'bybit' ? { bybitContracts: Number(amount) } : {}),
  };
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
 * @param {{ strategy: object, notionals: object, market: object, logger: object, relayerEnv?: Record<string,string>, relayerCwd?: string, automation?: { autoPickZkOsAccount?: boolean, openTradeMaxZkAttempts?: number } }} opts
 */
export async function executeReal({
  strategy,
  notionals,
  market,
  logger,
  relayerEnv,
  relayerCwd,
  automation = {},
}) {
  const id = randomUUID();
  const venue = cexVenue(strategy);
  const price = Math.round(btcPriceFromMarket(market, venue || 'binance'));

  const twilightLeg =
    strategy.twilightPosition &&
    String(strategy.twilightPosition).toLowerCase() !== 'null' &&
    Number(strategy.twilightSize) > 0;

  const results = {
    tradeId: id,
    mode: 'real',
    twilight: null,
    cex: null,
    twilightSkippedReason: null,
    twilightAccountIndex: null,
  };

  if (twilightLeg && shouldRunTwilightCli()) {
    const env = mergedRelayerEnv(relayerEnv);
    const defaultIdx =
      env.TWILIGHT_ACCOUNT_INDEX != null && String(env.TWILIGHT_ACCOUNT_INDEX).trim() !== ''
        ? String(env.TWILIGHT_ACCOUNT_INDEX).trim()
        : '0';
    const side = String(strategy.twilightPosition).toLowerCase();
    const lev = String(strategy.twilightLeverage);
    const walletId = String(env.NYKS_WALLET_ID || '').trim();
    const password = String(env.NYKS_WALLET_PASSPHRASE || '');
    if (!walletId || !password) {
      throw new Error(
        'Twilight order needs wallet id and passphrase in a non-interactive run. Fill wallet + password in Twilight wallet (step 1) when you click Real, or set NYKS_WALLET_ID and NYKS_WALLET_PASSPHRASE in the environment.'
      );
    }
    const idxNum = Number(defaultIdx);
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
    if (!indices.length) {
      throw new Error(
        `[ZKOS_PREFLIGHT] No ZkOS account indices parsed for wallet "${walletId}". ` +
          'Fund a first ZkOS account (zkaccount fund) or confirm `wallet accounts --json` returns account rows.'
      );
    }
    const autoPick = automation.autoPickZkOsAccount !== false;
    let accountIndex = defaultIdx;
    if (autoPick) {
      const picked = pickZkOsIndexForOpenTrade(listed.stdout, defaultIdx, { logger });
      accountIndex = picked.index;
      const pNum = Number(accountIndex);
      if (!indices.includes(pNum)) {
        throw new Error(
          `[ZKOS_PREFLIGHT] Auto-picked index ${accountIndex} is not in parsed index list [${indices.join(', ')}]. ` +
            'Relayer JSON shape may be unsupported — check wallet accounts output or disable automation.autoPickZkOsAccount.'
        );
      }
    } else {
      if (!indices.includes(want)) {
        const have = indices.length ? indices.join(', ') : '(none — wallet has no ZkOS accounts yet)';
        throw new Error(
          `[ZKOS_PREFLIGHT] Real run blocked — ZkOS account index ${want} is not available for wallet "${walletId}". ` +
            `Known indices: ${have}.\n` +
            '“No ZkOS accounts found” means you still need a first fund: use ZkOS (step 3b) → Fund account with spendable on-chain sats, then set TWILIGHT_ACCOUNT_INDEX to an index that exists (often 0 after first fund).'
        );
      }
      const row = parseZkOsAccountRows(listed.stdout).find((r) => r.index === want);
      const ioType = row?.ioType ?? null;
      if (ioType && /^memo$/i.test(ioType)) {
        throw new Error(
          `[ZKOS_PREFLIGHT] ZkOS account index ${want} has io_type **Memo** (locked while an order / memo state is active). ` +
            'Open-trade requires a **Coin** (idle) account, or enable auto-pick in configs/agent.monitor.yaml (automation.autoPickZkOsAccount).'
        );
      }
    }
    const maxAttempts = Math.min(
      5,
      Math.max(1, Number.isFinite(Number(automation.openTradeMaxZkAttempts)) ? Math.floor(Number(automation.openTradeMaxZkAttempts)) : 3)
    );
    const triedOpen = new Set();
    let listedForOpen = listed;
    let openAttempt = 0;
    const errorsByIndex = [];

    for (; openAttempt < maxAttempts; openAttempt++) {
      if (openAttempt > 0) {
        if (!autoPick) break;
        try {
          listedForOpen = await runRelayerCli(listArgs, logger, relayerEnv, { cwd: relayerCwd });
        } catch (e) {
          throw new Error(
            `[ZKOS_RETRY] Re-list accounts before retry failed: ${e?.message || String(e)}`
          );
        }
        const next = pickNextCoinZkOsIndexAfterFailure(listedForOpen.stdout, triedOpen, { logger });
        accountIndex = next.index;
      }

      const pNum = Number(accountIndex);
      const indicesNow = parseZkOsAccountIndicesFromAccountsStdout(listedForOpen.stdout);
      if (!indicesNow.includes(pNum)) {
        throw new Error(
          `[ZKOS_PREFLIGHT] Index ${accountIndex} not in parsed list [${indicesNow.join(', ')}] after list refresh.`
        );
      }

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
        '--json',
      ];
      try {
        results.twilight = await runRelayerCli(args, logger, relayerEnv, {
          cwd: relayerCwd,
        });
        results.twilightAccountIndex = Number(accountIndex);
        if (openAttempt > 0) {
          results.twilightOpenRetryCount = openAttempt;
          logger.info(`[ZKOS_RETRY] open-trade succeeded on attempt ${openAttempt + 1} (index ${accountIndex}).`);
        }
        break;
      } catch (e) {
        const msg = e?.message || String(e);
        errorsByIndex.push({ index: accountIndex, message: msg });
        triedOpen.add(pNum);
        const canRetry =
          autoPick &&
          openAttempt < maxAttempts - 1 &&
          shouldRetryTwilightOpenAfterZkRefresh(msg);
        if (!canRetry) {
          const chain = errorsByIndex.map((x) => `index ${x.index}: ${x.message}`).join('\n---\n');
          throw new Error(
            `${msg}\n\n[ZKOS_RETRY] Gave up after ${openAttempt + 1} attempt(s) on Twilight open-trade.\n${chain}`
          );
        }
        logger.warn(`[ZKOS_RETRY] open-trade attempt ${openAttempt + 1}/${maxAttempts} failed on index ${accountIndex}: ${msg}`);
      }
    }
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
      positionSide: cexPositionSide(strategy),
      sizeUsd: cexSizeUsd(strategy),
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

import ccxt from 'ccxt';
import { runRelayerCli, sanitizeString } from './relayer-cli.mjs';
import { loadExchangeKeys } from './exchange-keys-store.mjs';
import { getRepoRoot, loadTransactions } from './persistence.mjs';
import { getPositionPnlSummary } from './position-ledger.mjs';

/** Prefer .env (agent executor); fall back to dashboard CEX keys file (`data/exchange-keys.json`). */
function getBinanceCreds() {
  const ek = process.env.BINANCE_API_KEY?.trim();
  const es = process.env.BINANCE_API_SECRET?.trim();
  if (ek && es) {
    return {
      apiKey: ek,
      secret: es,
      useTestnet: process.env.BINANCE_USE_TESTNET === '1',
    };
  }
  const file = loadExchangeKeys()?.binance;
  if (file?.apiKey?.trim() && file?.apiSecret?.trim()) {
    return {
      apiKey: file.apiKey.trim(),
      secret: file.apiSecret.trim(),
      useTestnet: !!file.useTestnet,
    };
  }
  return null;
}

/** Prefer .env; fall back to `data/exchange-keys.json`. */
function getBybitCreds() {
  const ek = process.env.BYBIT_API_KEY?.trim();
  const es = process.env.BYBIT_API_SECRET?.trim();
  if (ek && es) {
    return {
      apiKey: ek,
      secret: es,
      useTestnet: process.env.BYBIT_USE_TESTNET === '1',
    };
  }
  const file = loadExchangeKeys()?.bybit;
  if (file?.apiKey?.trim() && file?.apiSecret?.trim()) {
    return {
      apiKey: file.apiKey.trim(),
      secret: file.apiSecret.trim(),
      useTestnet: !!file.useTestnet,
    };
  }
  return null;
}

async function fetchBinancePositions() {
  const creds = getBinanceCreds();
  if (!creds) {
    return {
      ok: false,
      reason:
        'No Binance futures keys: set BINANCE_API_KEY / BINANCE_API_SECRET in .env or save keys under CEX keys in the dashboard.',
    };
  }
  try {
    const ex = new ccxt.binanceusdm({
      apiKey: creds.apiKey,
      secret: creds.secret,
      enableRateLimit: true,
      options: { defaultType: 'future' },
    });
    if (creds.useTestnet) {
      ex.setSandboxMode(true);
    }
    await ex.loadMarkets();
    const positions = await ex.fetchPositions();
    const rows = (positions || [])
      .filter((p) => {
        const n = Math.abs(Number(p.notional || 0));
        const c = Math.abs(Number(p.contracts || 0));
        return n > 1e-8 || c > 1e-8;
      })
      .map((p) => ({
        symbol: p.symbol,
        side: p.side,
        contracts: p.contracts,
        notional: p.notional,
        unrealizedPnl: p.unrealizedPnl,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        leverage: p.leverage,
      }));
    return { ok: true, venue: 'binance', positions: rows };
  } catch (e) {
    const msg = e.message || String(e);
    const hint = /-2015/.test(msg)
      ? 'On Binance: enable Futures for this API key (not spot-only), allow “Read” (positions), match mainnet vs testnet (BINANCE_USE_TESTNET / dashboard testnet toggle), and if the key uses IP restriction, add this machine’s public IP.'
      : undefined;
    return { ok: false, error: msg, ...(hint && { hint }) };
  }
}

async function fetchBybitPositions() {
  const creds = getBybitCreds();
  if (!creds) {
    return {
      ok: false,
      reason:
        'No Bybit keys: set BYBIT_API_KEY / BYBIT_API_SECRET in .env or save keys under CEX keys in the dashboard.',
    };
  }
  try {
    const ex = new ccxt.bybit({
      apiKey: creds.apiKey,
      secret: creds.secret,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    if (creds.useTestnet) {
      ex.setSandboxMode(true);
    }
    await ex.loadMarkets();
    const positions = await ex.fetchPositions();
    const rows = (positions || [])
      .filter((p) => {
        const n = Math.abs(Number(p.notional || 0));
        const c = Math.abs(Number(p.contracts || 0));
        return n > 1e-8 || c > 1e-8;
      })
      .map((p) => ({
        symbol: p.symbol,
        side: p.side,
        contracts: p.contracts,
        notional: p.notional,
        unrealizedPnl: p.unrealizedPnl,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        leverage: p.leverage,
      }));
    return { ok: true, venue: 'bybit', positions: rows };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function fetchTwilightAccountSummary(options = {}) {
  const envWid = process.env.NYKS_WALLET_ID?.trim();
  const wid = sanitizeString(options.walletId ?? '') || envWid;
  if (!wid) {
    return {
      ok: false,
      reason:
        'Twilight account summary needs a wallet: set NYKS_WALLET_ID in repo .env, or select a wallet in the Wallet section (trade desk sends it automatically).',
      hint: 'relayer-cli: wallet_id is required (or run wallet unlock in a session that shares relayer state).',
    };
  }
  const idx = process.env.TWILIGHT_ACCOUNT_INDEX || '0';
  try {
    // Newer relayer-cli requires `--wallet-id` (or NYKS_WALLET_ID / unlock). CLI builds also differ on account flags.
    const attempts = [
      ['order', 'account-summary', '--wallet-id', wid, String(idx), '--json'],
      ['order', 'account-summary', '--wallet-id', wid, '--account-index', String(idx), '--json'],
      ['order', 'account-summary', '--wallet-id', wid, '--account', String(idx), '--json'],
      ['order', 'account-summary', '--wallet-id', wid, '--json'],
    ];
    let last = null;
    for (const argv of attempts) {
      const r = await runRelayerCli(argv, { cwd: getRepoRoot(), timeoutMs: 120000 });
      last = r;
      if (r.ok) {
        let parsed = null;
        try {
          parsed = JSON.parse(r.stdout || '{}');
        } catch {
          parsed = { raw: String(r.stdout || '').slice(0, 2000) };
        }
        return { ok: true, accountIndex: idx, summary: parsed, argvUsed: argv.join(' ') };
      }
      const err = String(r.stderr || '');
      if (!/unexpected argument|found\n\nUsage:/i.test(err)) {
        break;
      }
    }
    return {
      ok: false,
      accountIndex: idx,
      stderr: last?.stderr,
      stdoutPreview: String(last?.stdout || '').slice(0, 800),
      hint: 'relayer-cli account-summary flags differ by version; check: relayer-cli order account-summary --help',
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/**
 * Aggregated view for the trade desk: agent log, ledger, live Binance / Bybit / Twilight.
 */
export async function getTradeDeskSnapshot(opts = {}) {
  const agentTransactions = loadTransactions();
  const pnl = await getPositionPnlSummary();
  const [binanceLive, bybitLive, twilightLive] = await Promise.all([
    fetchBinancePositions(),
    fetchBybitPositions(),
    fetchTwilightAccountSummary({ walletId: opts.walletId }),
  ]);
  return {
    agentTransactions,
    openPositions: pnl.openPositions,
    closedPositions: (pnl.closedPositions || []).slice(0, 80),
    realizedPnlUsd: pnl.realizedPnlUsd,
    unrealizedPnlUsd: pnl.unrealizedPnlUsd,
    currentBtcPrice: pnl.currentBtcPrice,
    binanceLive,
    bybitLive,
    twilightLive,
  };
}

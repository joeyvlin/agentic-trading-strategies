import { getRelayerBinary, runRelayerCli, sanitizeString } from './relayer-cli.mjs';
import { getRepoRoot } from './persistence.mjs';
import {
  parseNyksBalanceFromWalletBalanceText,
  parsePendingSatsFromWalletBalance,
  parseSpendableSatsFromWalletBalance,
  parseTwilightAddressFromBalanceStdout,
  parseWalletListStdout,
} from './relayer-parse.mjs';
import { requestNyksTokens, requestTestSats } from './twilight-faucet.mjs';

/** @returns {'testnet'|'mainnet'|null} */
function normalizedNetworkType() {
  const n = sanitizeString(process.env.NETWORK_TYPE || '').toLowerCase();
  if (n === 'testnet' || n === 'mainnet') return n;
  return null;
}

function creds(body) {
  const walletId = sanitizeString(body?.walletId ?? body?.wallet_id ?? '') || process.env.NYKS_WALLET_ID;
  const pwBody = typeof body?.password === 'string' ? body.password.trim() : '';
  const password = pwBody || process.env.NYKS_WALLET_PASSPHRASE;
  return { walletId, password };
}

function requireWalletCreds(walletId, password) {
  if (!walletId) {
    return 'walletId is required (or set NYKS_WALLET_ID in .env)';
  }
  if (!password) {
    return 'password is required (or set NYKS_WALLET_PASSPHRASE in .env)';
  }
  return null;
}

function requireOrdersAllowed() {
  if (process.env.RELAYER_ALLOW_DASHBOARD_ORDERS !== 'YES') {
    return 'Set RELAYER_ALLOW_DASHBOARD_ORDERS=YES in .env to enable open/close/cancel trade from the dashboard.';
  }
  return null;
}

function requireZkAllowed() {
  if (process.env.RELAYER_ALLOW_DASHBOARD_ZK !== 'YES') {
    return 'Set RELAYER_ALLOW_DASHBOARD_ZK=YES in .env to enable ZkOS fund and transfer from the dashboard.';
  }
  return null;
}

/** Unlock helpers: allow with ZkOS gate OR orders gate (inspector users often enable Zk only). */
function requireOrdersOrZkAllowed() {
  if (process.env.RELAYER_ALLOW_DASHBOARD_ORDERS === 'YES' || process.env.RELAYER_ALLOW_DASHBOARD_ZK === 'YES') {
    return null;
  }
  return 'Set RELAYER_ALLOW_DASHBOARD_ORDERS=YES or RELAYER_ALLOW_DASHBOARD_ZK=YES in .env to enable unlock-close / unlock-failed from the dashboard.';
}

async function jsonHandler(res, promise) {
  try {
    const result = await promise;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}

/**
 * @param {import('express').Express} app
 * @param {{ requireToken: import('express').RequestHandler }} opts
 */
export function registerRelayerRoutes(app, { requireToken }) {
  const repoRoot = getRepoRoot();

  app.get('/api/relayer/meta', requireToken, (_req, res) => {
    const faucet =
      sanitizeString(process.env.FAUCET_BASE_URL || process.env.NYKS_FAUCET_URL || '') || '';
    const networkType = normalizedNetworkType();
    res.json({
      binary: getRelayerBinary(),
      repoRoot,
      ordersAllowEnv: process.env.RELAYER_ALLOW_DASHBOARD_ORDERS === 'YES',
      zkAllowEnv: process.env.RELAYER_ALLOW_DASHBOARD_ZK === 'YES',
      faucetConfigured: !!faucet,
      faucetBaseUrl: faucet || null,
      networkType,
      /** True when test sats mint (POST /mint) is expected to work — same chain as faucet. */
      testSatsMintExpected: networkType === 'testnet' && !!faucet,
    });
  });

  app.post('/api/relayer/ping', requireToken, (_req, res) => {
    jsonHandler(
      res,
      runRelayerCli(['market', 'price', '--json'], { cwd: repoRoot }).then((r) => ({
        ok: r.ok,
        ...r,
      }))
    );
  });

  app.post('/api/relayer/wallet/list', requireToken, (_req, res) => {
    jsonHandler(
      res,
      runRelayerCli(['wallet', 'list', '--json'], { cwd: repoRoot }).then((r) => ({
        ok: r.ok,
        ...r,
        wallets: parseWalletListStdout(r.stdout || ''),
      }))
    );
  });

  app.post('/api/relayer/wallet/faucet', requireToken, async (req, res) => {
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    const base =
      sanitizeString(process.env.FAUCET_BASE_URL || process.env.NYKS_FAUCET_URL || '') || '';
    if (!base) {
      return res.status(400).json({
        error:
          'Set FAUCET_BASE_URL in .env for testnet (e.g. https://faucet-rpc.twilight.rest). Mainnet has no public faucet.',
      });
    }
    const mintSats = req.body?.mintTestSats === true;
    const networkType = normalizedNetworkType();
    try {
      const bal = await runRelayerCli(
        ['wallet', 'balance', '--wallet-id', walletId, '--password', password],
        { cwd: repoRoot }
      );
      if (!bal.ok) {
        return res.status(400).json({
          error: 'wallet balance failed — check wallet id, password, and relayer-cli',
          ...bal,
        });
      }
      const recipientAddress = parseTwilightAddressFromBalanceStdout(bal.stdout || '');
      if (!recipientAddress) {
        return res.status(500).json({
          error: 'Could not parse Twilight address from relayer-cli output',
          stdout: bal.stdout,
        });
      }
      const nyks = await requestNyksTokens(base, recipientAddress);

      /** @type {Record<string, unknown> | null} */
      let mint = null;
      if (mintSats) {
        if (networkType !== 'testnet') {
          mint = {
            skipped: true,
            networkType: networkType ?? '(unset or unknown)',
            reason:
              'Test sats (POST /mint) are for Twilight testnet only. Set NETWORK_TYPE=testnet in the server `.env`, apply the testnet preset (LCD, RPC, relayer, faucet URLs), restart the dashboard, then try again.',
          };
        } else {
          try {
            const testSats = await requestTestSats(base, recipientAddress);
            mint = { ok: true, ...testSats };
          } catch (e) {
            const msg = e.message || String(e);
            mint = {
              ok: false,
              error: msg,
              hint:
                'NYKS may have succeeded above. Mint can fail if the faucet rate-limits, your address is ineligible, or LCD/RPC/NETWORK_TYPE do not match the faucet chain. Wait and retry, confirm `FAUCET_BASE_URL` is the testnet faucet, and check relayer logs.',
            };
          }
        }
      }

      res.json({
        ok: true,
        networkType,
        faucetBaseUrl: base,
        recipientAddress,
        nyks,
        mintTestSatsRequested: mintSats,
        mint,
        note:
          'NYKS via POST /faucet; test sats via POST /mint. If SATS stay 0 in `wallet balance`, use POST /api/relayer/wallet/faucet-cli (runs `relayer-cli wallet faucet` / SDK get_test_tokens) instead.',
      });
    } catch (e) {
      res.status(502).json({
        error: e.message || String(e),
        step: 'nyks_faucet',
        hint:
          'If NYKS failed, nothing was minted. Fix wallet balance / relayer / FAUCET_BASE_URL and retry.',
      });
    }
  });

  /**
   * Testnet only: runs `relayer-cli wallet faucet` → SDK `get_test_tokens` + `update_balance`.
   * Prefer this when HTTP POST /faucet + /mint succeed but `wallet balance` still shows SATS: 0.
   */
  app.post('/api/relayer/wallet/faucet-cli', requireToken, (req, res) => {
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    if (normalizedNetworkType() !== 'testnet') {
      return res.status(400).json({
        error:
          'CLI `wallet faucet` is testnet-only. Set NETWORK_TYPE=testnet in .env (mainnet uses register-btc / deposits, not the test faucet).',
      });
    }
    jsonHandler(
      res,
      runRelayerCli(['wallet', 'faucet', '--wallet-id', walletId, '--password', password], {
        cwd: repoRoot,
      }).then((r) => ({
        ok: r.ok,
        ...r,
        note: 'nyks-wallet: get_test_tokens(&mut wallet) then update_balance() — official QuickStart path; differs from raw HTTP /faucet + /mint.',
      }))
    );
  });

  app.post('/api/relayer/wallet/balance', requireToken, (req, res) => {
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    jsonHandler(
      res,
      runRelayerCli(
        ['wallet', 'balance', '--wallet-id', walletId, '--password', password, '--json'],
        { cwd: repoRoot }
      ).then((r) => ({ ok: r.ok, ...r }))
    );
  });

  /** Parsed spendable on-chain sats for ZkOS fund UI (best-effort). */
  app.post('/api/relayer/wallet/balance-sats', requireToken, async (req, res) => {
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    try {
      const r = await runRelayerCli(
        ['wallet', 'balance', '--wallet-id', walletId, '--password', password, '--json'],
        { cwd: repoRoot }
      );
      const spendableSats = r.ok ? parseSpendableSatsFromWalletBalance(r.stdout) : null;
      const nyksBalance = r.ok ? parseNyksBalanceFromWalletBalanceText(r.stdout) : null;
      const pendingSats = r.ok ? parsePendingSatsFromWalletBalance(r.stdout) : null;
      let parseNote = null;
      if (r.ok) {
        if (spendableSats == null) {
          parseNote = 'Could not parse SATS from balance output; enter fund amount manually.';
        } else if (pendingSats != null && pendingSats > 0 && spendableSats === 0) {
          parseNote = `Pending / unconfirmed BTC (~${pendingSats} sats) — spendable SATS may stay 0 until the next block is indexed. Wait 1–5 minutes and refresh Manage → Balance.`;
        } else if (spendableSats === 0) {
          const lag =
            'If the faucet mint (POST /mint) just succeeded, spendable SATS can lag 1–5 minutes behind the HTTP response while the block is indexed and UTXOs sync — refresh Manage → Balance again.';
          if (nyksBalance != null && nyksBalance > 0) {
            parseNote =
              'ZkOS fund spends on-chain BTC (SATS), not NYKS. You have NYKS on Twilight but SATS is 0 — deposit BTC to this wallet or use testnet faucet + mint so SATS > 0, then fund ZkOS. ' +
              lag;
          } else {
            parseNote =
              'SATS is 0 — use the testnet faucet (+ mint) or deposit BTC. ' + lag;
          }
        }
        if (r.ok && spendableSats === 0 && parseNote) {
          parseNote +=
            ' If SATS stay 0 after a long wait, the HTTP faucet is not the same as the SDK path — use Faucet “CLI: wallet faucet (SDK)” or run `relayer-cli wallet faucet` (testnet).';
        }
      }
      res.json({
        ok: r.ok,
        spendableSats,
        pendingSats,
        nyksBalance,
        parseNote,
        stderr: r.stderr,
        stdoutPreview: String(r.stdout || '').slice(0, 4000),
      });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post('/api/relayer/wallet/accounts', requireToken, (req, res) => {
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    const argv = ['wallet', 'accounts', '--wallet-id', walletId, '--password', password, '--json'];
    if (req.body?.onChainOnly === true) argv.push('--on-chain-only');
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });

  app.post('/api/relayer/wallet/info', requireToken, (req, res) => {
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    jsonHandler(
      res,
      runRelayerCli(
        ['wallet', 'info', '--wallet-id', walletId, '--password', password, '--json'],
        { cwd: repoRoot }
      ).then((r) => ({ ok: r.ok, ...r }))
    );
  });

  app.post('/api/relayer/wallet/create', requireToken, (req, res) => {
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    const btc = sanitizeString(req.body?.btcAddress ?? '');
    const argv = ['wallet', 'create', '--wallet-id', walletId, '--password', password, '--json'];
    if (btc) {
      argv.push('--btc-address', btc);
    }
    jsonHandler(
      res,
      runRelayerCli(argv, { cwd: repoRoot, allocatePseudoTty: true }).then((r) => ({
        ok: r.ok,
        ...r,
        warning:
          'If a mnemonic was printed, store it offline — never commit it. Dashboard output may appear in logs.',
      }))
    );
  });

  app.post('/api/relayer/wallet/import', requireToken, (req, res) => {
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    const mnemonic = sanitizeString(req.body?.mnemonic ?? '');
    if (!mnemonic) return res.status(400).json({ error: 'mnemonic is required' });
    jsonHandler(
      res,
      runRelayerCli(
        ['wallet', 'import', '--mnemonic', mnemonic, '--wallet-id', walletId, '--password', password, '--json'],
        { cwd: repoRoot }
      ).then((r) => ({ ok: r.ok, ...r }))
    );
  });

  app.post('/api/relayer/wallet/unlock', requireToken, (req, res) => {
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    jsonHandler(
      res,
      runRelayerCli(
        ['wallet', 'unlock', '--wallet-id', walletId, '--password', password],
        { cwd: repoRoot }
      ).then((r) => ({ ok: r.ok, ...r }))
    );
  });

  app.post('/api/relayer/wallet/lock', requireToken, (_req, res) => {
    jsonHandler(
      res,
      runRelayerCli(['wallet', 'lock'], { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r }))
    );
  });

  app.post('/api/relayer/wallet/sync-nonce', requireToken, (req, res) => {
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    jsonHandler(
      res,
      runRelayerCli(
        ['wallet', 'sync-nonce', '--wallet-id', walletId, '--password', password, '--json'],
        { cwd: repoRoot }
      ).then((r) => ({ ok: r.ok, ...r }))
    );
  });

  app.post('/api/relayer/market/price', requireToken, (_req, res) => {
    jsonHandler(
      res,
      runRelayerCli(['market', 'price', '--json'], { cwd: repoRoot }).then((r) => ({
        ok: r.ok,
        ...r,
      }))
    );
  });

  app.post('/api/relayer/market/market-stats', requireToken, (_req, res) => {
    jsonHandler(
      res,
      runRelayerCli(['market', 'market-stats', '--json'], { cwd: repoRoot }).then((r) => ({
        ok: r.ok,
        ...r,
      }))
    );
  });

  app.post('/api/relayer/portfolio/summary', requireToken, (_req, res) => {
    jsonHandler(
      res,
      runRelayerCli(['portfolio', 'summary', '--json'], { cwd: repoRoot }).then((r) => ({
        ok: r.ok,
        ...r,
      }))
    );
  });

  app.post('/api/relayer/zkaccount/fund', requireToken, (req, res) => {
    const gate = requireZkAllowed();
    if (gate) return res.status(403).json({ error: gate });
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    const { amount, amountMbtc, amountBtc } = req.body || {};
    const argv = ['zkaccount', 'fund', '--wallet-id', walletId, '--password', password];
    if (amount != null && amount !== '') {
      argv.push('--amount', String(amount));
    } else if (amountMbtc != null && amountMbtc !== '') {
      argv.push('--amount-mbtc', String(amountMbtc));
    } else if (amountBtc != null && amountBtc !== '') {
      argv.push('--amount-btc', String(amountBtc));
    } else {
      return res.status(400).json({ error: 'Provide amount (sats), amountMbtc, or amountBtc' });
    }
    argv.push('--json');
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });

  app.post('/api/relayer/zkaccount/withdraw', requireToken, (req, res) => {
    const gate = requireZkAllowed();
    if (gate) return res.status(403).json({ error: gate });
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    const accountIndex = req.body?.accountIndex ?? req.body?.account_index;
    if (accountIndex == null || accountIndex === '') {
      return res.status(400).json({ error: 'accountIndex is required' });
    }
    const { amount, amountMbtc, amountBtc } = req.body || {};
    const argv = [
      'zkaccount',
      'withdraw',
      '--account-index',
      String(accountIndex),
      '--wallet-id',
      walletId,
      '--password',
      password,
    ];
    if (amount != null && amount !== '') {
      argv.push('--amount', String(amount));
    } else if (amountMbtc != null && amountMbtc !== '') {
      argv.push('--amount-mbtc', String(amountMbtc));
    } else if (amountBtc != null && amountBtc !== '') {
      argv.push('--amount-btc', String(amountBtc));
    } else {
      return res.status(400).json({ error: 'Provide amount (sats), amountMbtc, or amountBtc' });
    }
    argv.push('--json');
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });

  app.post('/api/relayer/zkaccount/transfer', requireToken, (req, res) => {
    const gate = requireZkAllowed();
    if (gate) return res.status(403).json({ error: gate });
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    const accountIndex = req.body?.accountIndex ?? req.body?.account_index ?? req.body?.from;
    if (accountIndex == null || accountIndex === '') {
      return res.status(400).json({ error: 'accountIndex (or legacy from) is required' });
    }
    const argv = [
      'zkaccount',
      'transfer',
      '--account-index',
      String(accountIndex),
      '--wallet-id',
      walletId,
      '--password',
      password,
      '--json',
    ];
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });

  app.post('/api/relayer/zkaccount/split', requireToken, (req, res) => {
    const gate = requireZkAllowed();
    if (gate) return res.status(403).json({ error: gate });
    const { walletId, password } = creds(req.body || {});
    const err = requireWalletCreds(walletId, password);
    if (err) return res.status(400).json({ error: err });
    const accountIndex = req.body?.accountIndex ?? req.body?.account_index;
    const balances = sanitizeString(req.body?.balances ?? '');
    if (accountIndex == null || accountIndex === '') {
      return res.status(400).json({ error: 'accountIndex is required' });
    }
    if (!balances) {
      return res.status(400).json({
        error: 'balances is required (comma-separated sat amounts, e.g. "10000,20000")',
      });
    }
    const argv = [
      'zkaccount',
      'split',
      '--account-index',
      String(accountIndex),
      '--wallet-id',
      walletId,
      '--password',
      password,
      '--balances',
      balances,
      '--json',
    ];
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });

  app.post('/api/relayer/order/open-trade', requireToken, (req, res) => {
    const gate = requireOrdersAllowed();
    if (gate) return res.status(403).json({ error: gate });
    const { accountIndex, side, entryPrice, leverage, orderType, noWait } = req.body || {};
    if (accountIndex == null || !side || entryPrice == null || leverage == null) {
      return res.status(400).json({
        error: 'Required: accountIndex, side (long|short), entryPrice, leverage',
      });
    }
    const { walletId, password } = creds(req.body || {});
    const argv = ['order', 'open-trade'];
    if (walletId && password) {
      argv.push('--wallet-id', walletId, '--password', password);
    }
    argv.push(
      '--account-index',
      String(accountIndex),
      '--side',
      String(side).toLowerCase(),
      '--entry-price',
      String(Math.round(Number(entryPrice))),
      '--leverage',
      String(leverage),
      '--order-type',
      orderType ? String(orderType).toUpperCase() : 'MARKET',
      '--json'
    );
    if (noWait === true) argv.push('--no-wait');
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });

  app.post('/api/relayer/order/close-trade', requireToken, (req, res) => {
    const gate = requireOrdersAllowed();
    if (gate) return res.status(403).json({ error: gate });
    const { accountIndex, noWait, stopLoss, takeProfit } = req.body || {};
    if (accountIndex == null) {
      return res.status(400).json({ error: 'accountIndex is required' });
    }
    const { walletId, password } = creds(req.body || {});
    const argv = ['order', 'close-trade', '--json'];
    if (walletId && password) {
      argv.splice(1, 0, '--wallet-id', walletId, '--password', password);
    }
    argv.splice(argv.indexOf('--json'), 0, '--account-index', String(accountIndex));
    if (noWait === true) argv.push('--no-wait');
    if (stopLoss != null && stopLoss !== '') argv.push('--stop-loss', String(stopLoss));
    if (takeProfit != null && takeProfit !== '') argv.push('--take-profit', String(takeProfit));
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });

  app.post('/api/relayer/order/cancel-trade', requireToken, (req, res) => {
    const gate = requireOrdersAllowed();
    if (gate) return res.status(403).json({ error: gate });
    const { accountIndex } = req.body || {};
    if (accountIndex == null) {
      return res.status(400).json({ error: 'accountIndex is required' });
    }
    const { walletId, password } = creds(req.body || {});
    const argv = ['order', 'cancel-trade'];
    if (walletId && password) {
      argv.push('--wallet-id', walletId, '--password', password);
    }
    argv.push('--account-index', String(accountIndex), '--json');
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });

  app.post('/api/relayer/order/unlock-close-order', requireToken, (req, res) => {
    const gate = requireOrdersOrZkAllowed();
    if (gate) return res.status(403).json({ error: gate });
    const accountIndex = req.body?.accountIndex ?? req.body?.account_index;
    if (accountIndex == null || accountIndex === '') {
      return res.status(400).json({ error: 'accountIndex is required' });
    }
    const { walletId, password } = creds(req.body || {});
    const argv = ['order', 'unlock-close-order'];
    if (walletId && password) {
      argv.push('--wallet-id', walletId, '--password', password);
    }
    argv.push('--account-index', String(accountIndex), '--json');
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });

  app.post('/api/relayer/order/unlock-failed-order', requireToken, (req, res) => {
    const gate = requireOrdersOrZkAllowed();
    if (gate) return res.status(403).json({ error: gate });
    const accountIndex = req.body?.accountIndex ?? req.body?.account_index;
    if (accountIndex == null || accountIndex === '') {
      return res.status(400).json({ error: 'accountIndex is required' });
    }
    const { walletId, password } = creds(req.body || {});
    const argv = ['order', 'unlock-failed-order'];
    if (walletId && password) {
      argv.push('--wallet-id', walletId, '--password', password);
    }
    argv.push('--account-index', String(accountIndex), '--json');
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });
}

import { getRelayerBinary, runRelayerCli, sanitizeString } from './relayer-cli.mjs';
import { getRepoRoot } from './persistence.mjs';
import { parseTwilightAddressFromBalanceStdout, parseWalletListStdout } from './relayer-parse.mjs';
import { requestNyksTokens, requestTestSats } from './twilight-faucet.mjs';

function creds(body) {
  const walletId = sanitizeString(body?.walletId ?? body?.wallet_id ?? '') || process.env.NYKS_WALLET_ID;
  const password =
    typeof body?.password === 'string' ? body.password : process.env.NYKS_WALLET_PASSPHRASE;
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
    res.json({
      binary: getRelayerBinary(),
      repoRoot,
      ordersAllowEnv: process.env.RELAYER_ALLOW_DASHBOARD_ORDERS === 'YES',
      zkAllowEnv: process.env.RELAYER_ALLOW_DASHBOARD_ZK === 'YES',
      faucetConfigured: !!faucet,
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
      let testSats = null;
      if (mintSats) testSats = await requestTestSats(base, recipientAddress);
      res.json({
        ok: true,
        recipientAddress,
        nyks,
        testSats,
        note: 'NYKS via POST /faucet; test sats via POST /mint (testnet only).',
      });
    } catch (e) {
      res.status(502).json({ error: e.message || String(e) });
    }
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
      runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({
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
    const { amount, amountMbtc, amountBtc } = req.body || {};
    const argv = ['zkaccount', 'fund', '--json'];
    if (amount != null && amount !== '') {
      argv.push('--amount', String(amount));
    } else if (amountMbtc != null && amountMbtc !== '') {
      argv.push('--amount-mbtc', String(amountMbtc));
    } else if (amountBtc != null && amountBtc !== '') {
      argv.push('--amount-btc', String(amountBtc));
    } else {
      return res.status(400).json({ error: 'Provide amount (sats), amountMbtc, or amountBtc' });
    }
    jsonHandler(res, runRelayerCli(argv, { cwd: repoRoot }).then((r) => ({ ok: r.ok, ...r })));
  });

  app.post('/api/relayer/zkaccount/transfer', requireToken, (req, res) => {
    const gate = requireZkAllowed();
    if (gate) return res.status(403).json({ error: gate });
    const from = req.body?.from ?? req.body?.accountIndex;
    if (from == null || from === '') {
      return res.status(400).json({ error: 'from (account index) is required' });
    }
    jsonHandler(
      res,
      runRelayerCli(['zkaccount', 'transfer', '--from', String(from), '--json'], {
        cwd: repoRoot,
      }).then((r) => ({ ok: r.ok, ...r }))
    );
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
    const argv = [
      'order',
      'open-trade',
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
      '--json',
    ];
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
    const argv = ['order', 'close-trade', '--account-index', String(accountIndex), '--json'];
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
    jsonHandler(
      res,
      runRelayerCli(['order', 'cancel-trade', '--account-index', String(accountIndex), '--json'], {
        cwd: repoRoot,
      }).then((r) => ({ ok: r.ok, ...r }))
    );
  });
}

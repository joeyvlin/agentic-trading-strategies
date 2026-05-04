import { runRelayerCli, sanitizeString } from './relayer-cli.mjs';
import { getRepoRoot, loadTransactions } from './persistence.mjs';
import { mergeAndWriteEnv } from './env-store.mjs';
import { loadEnv } from '../../agents/twilight-strategy-monitor/src/config.js';
import { readAgentSettings } from './agent-settings.mjs';
import { flattenCexPosition } from './cex-flatten.mjs';
import { getOpenPosition, closePosition, unrealizedUsdForOpen } from './position-ledger.mjs';
import { getStrategyApiEnv } from './env-store.mjs';
import { fetchMarket } from '../../agents/twilight-strategy-monitor/src/strategyClient.js';
import { applyDashboardExchangeKeysToEnv } from './monitor-service.mjs';
import { parseZkOsAccountIndicesFromAccountsStdout } from './relayer-parse.mjs';

function zkDashboardTransferAllowed() {
  return process.env.RELAYER_ALLOW_DASHBOARD_ZK === 'YES';
}

function autoZkRotateAfterCloseEnabled() {
  const v = process.env.AUTO_ZKOS_ROTATE_AFTER_CLOSE;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function persistTwilightIndexAfterRotateEnabled() {
  const v = process.env.PERSIST_TWILIGHT_INDEX_AFTER_ROTATE;
  if (v != null && String(v).trim() !== '' && /^(0|false|no|off)$/i.test(String(v).trim())) {
    return false;
  }
  try {
    const s = readAgentSettings();
    if (s.automation && s.automation.persistTwilightIndexAfterRotate === false) return false;
  } catch {
    /* missing agent.monitor.yaml */
  }
  return true;
}

function relayerOrdersAllowed() {
  return process.env.RELAYER_ALLOW_DASHBOARD_ORDERS === 'YES';
}

function hydrateFromTransaction(tradeId) {
  const txs = loadTransactions();
  const tx = txs.find((t) => t.tradeId === tradeId);
  const ex = tx?.execution;
  if (!ex || ex.kind !== 'real') return { twilightOpened: false, twilightAccountIndex: null, cexFlatten: null };

  const twilightOpened = !!ex.twilight?.completed;
  let twilightAccountIndex = null;
  if (twilightOpened) {
    if (ex.twilight?.accountIndex != null) {
      const n = Number(ex.twilight.accountIndex);
      twilightAccountIndex = Number.isFinite(n) ? n : null;
    }
    if (twilightAccountIndex == null) {
      twilightAccountIndex = Number(process.env.TWILIGHT_ACCOUNT_INDEX ?? 0) || 0;
    }
  }

  let cexFlatten = null;
  if (ex.cex?.completed && ex.cex.flattenSide && ex.cex.symbol && ex.cex.venue) {
    const amt = Number(ex.cex.flattenAmount);
    if (Number.isFinite(amt) && amt > 0) {
      cexFlatten = {
        venue: String(ex.cex.venue).toLowerCase(),
        symbol: String(ex.cex.symbol),
        side: String(ex.cex.flattenSide).toLowerCase(),
        amount: amt,
      };
    }
  }
  return { twilightOpened, twilightAccountIndex, cexFlatten };
}

async function fetchCurrentBtc() {
  const { base, key } = getStrategyApiEnv();
  if (!key) return 0;
  try {
    const m = await fetchMarket(base, key);
    return Number(m?.btcPrice ?? m?.prices?.twilight) || 0;
  } catch {
    return 0;
  }
}

function mergeCloseHints(row, fromTx) {
  let twilightAccountIndex =
    row.twilightAccountIndex != null ? Number(row.twilightAccountIndex) : fromTx.twilightAccountIndex;
  if (!Number.isFinite(twilightAccountIndex)) twilightAccountIndex = null;
  if (fromTx.twilightOpened && (twilightAccountIndex == null || !Number.isFinite(twilightAccountIndex))) {
    twilightAccountIndex = Number(process.env.TWILIGHT_ACCOUNT_INDEX ?? 0) || 0;
  }

  let cexFlatten = row.cexFlatten || fromTx.cexFlatten;
  if (cexFlatten && (!cexFlatten.venue || !cexFlatten.symbol || !cexFlatten.side)) {
    cexFlatten = null;
  }
  return { twilightAccountIndex, cexFlatten, twilightOpened: fromTx.twilightOpened };
}

/**
 * Close venues (real mode) then move row to closed with realized P&amp;L (MTM or override).
 * @param {string} tradeId
 * @param {{ realizedPnlUsd?: number|null, walletId?: string, password?: string }} opts
 */
export async function executeFullPositionClose(tradeId, opts = {}) {
  const row = getOpenPosition(tradeId);
  if (!row) return { ok: false, error: 'Open position not found' };

  const mode = String(row.mode || '');
  const fromTx = hydrateFromTransaction(tradeId);
  const { twilightAccountIndex, cexFlatten, twilightOpened } = mergeCloseHints(row, fromTx);

  const venueSteps = { twilight: null, cex: null };

  if (mode === 'real') {
    const walletId = sanitizeString(opts.walletId ?? '') || sanitizeString(process.env.NYKS_WALLET_ID || '');
    const password =
      typeof opts.password === 'string'
        ? opts.password
        : String(process.env.NYKS_WALLET_PASSPHRASE || '');

    if (twilightOpened && twilightAccountIndex != null) {
      if (!relayerOrdersAllowed()) {
        throw new Error(
          'Twilight market close requires RELAYER_ALLOW_DASHBOARD_ORDERS=YES in .env (same gate as Advanced relayer orders).'
        );
      }
      if (!walletId || !password) {
        throw new Error(
          'Twilight close needs wallet id and encryption password (Twilight wallet step 1, or NYKS_WALLET_ID / NYKS_WALLET_PASSPHRASE in .env).'
        );
      }
      const argv = [
        'order',
        'close-trade',
        '--wallet-id',
        walletId,
        '--password',
        password,
        '--account-index',
        String(twilightAccountIndex),
        '--json',
      ];
      const r = await runRelayerCli(argv, { cwd: getRepoRoot(), timeoutMs: 180000 });
      venueSteps.twilight = {
        ok: r.ok,
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        accountIndex: twilightAccountIndex,
      };
      if (!r.ok) {
        throw new Error(
          `Twilight close-trade failed (exit ${r.code}): ${String(r.stderr || r.stdout || '').trim() || 'no output'}`
        );
      }

      /**
       * After close-trade, relayer may still hold the account in Memo until settlement is synced.
       * `zkaccount transfer` requires Coin — run unlock-close-order first (no-op / soft-fail if already Coin).
       */
      let unlockR = null;
      try {
        unlockR = await runRelayerCli(
          [
            'order',
            'unlock-close-order',
            '--wallet-id',
            walletId,
            '--password',
            password,
            '--account-index',
            String(twilightAccountIndex),
            '--json',
          ],
          { cwd: getRepoRoot(), timeoutMs: 180000 }
        );
      } catch (e) {
        unlockR = {
          ok: false,
          code: -1,
          stdout: '',
          stderr: e?.message || String(e),
        };
      }
      venueSteps.unlockCloseOrder = {
        ok: unlockR.ok,
        code: unlockR.code,
        stdout: unlockR.stdout,
        stderr: unlockR.stderr,
      };

      /** After close + unlock, move ZkOS balance to a fresh index (same as manual 100% transfer). */
      if (zkDashboardTransferAllowed() && autoZkRotateAfterCloseEnabled()) {
        try {
          const tr = await runRelayerCli(
            [
              'zkaccount',
              'transfer',
              '--account-index',
              String(twilightAccountIndex),
              '--wallet-id',
              walletId,
              '--password',
              password,
              '--json',
            ],
            { cwd: getRepoRoot(), timeoutMs: 180000 }
          );
          const base = {
            ok: tr.ok,
            code: tr.code,
            stdout: tr.stdout,
            stderr: tr.stderr,
            fromIndex: twilightAccountIndex,
          };
          if (tr.ok) {
            const listAfter = await runRelayerCli(
              [
                'wallet',
                'accounts',
                '--wallet-id',
                walletId,
                '--password',
                password,
                '--json',
              ],
              { cwd: getRepoRoot(), timeoutMs: 120000 }
            );
            const idxs = parseZkOsAccountIndicesFromAccountsStdout(listAfter.stdout);
            const maxIdx = idxs.length ? Math.max(...idxs) : null;
            const newHint = maxIdx != null && maxIdx > twilightAccountIndex ? maxIdx : null;
            venueSteps.zkRotate = {
              ...base,
              newAccountIndexHint: newHint,
              listAfterOk: listAfter.ok,
            };
            if (tr.ok && newHint != null && persistTwilightIndexAfterRotateEnabled()) {
              try {
                mergeAndWriteEnv({ TWILIGHT_ACCOUNT_INDEX: String(newHint) }, {});
                loadEnv();
                venueSteps.zkRotate.persistedTwilightIndexToEnv = newHint;
              } catch (e) {
                venueSteps.zkRotate.persistEnvError = e?.message || String(e);
              }
            }
          } else {
            venueSteps.zkRotate = base;
          }
        } catch (e) {
          venueSteps.zkRotate = {
            ok: false,
            fromIndex: twilightAccountIndex,
            error: e.message || String(e),
          };
        }
      } else {
        const reasons = [];
        if (!zkDashboardTransferAllowed()) {
          reasons.push(
            'RELAYER_ALLOW_DASHBOARD_ZK is not YES — enable ZkOS in step 3b to auto-rotate after close, or run Transfer (100%) manually.'
          );
        }
        if (!autoZkRotateAfterCloseEnabled()) {
          reasons.push('AUTO_ZKOS_ROTATE_AFTER_CLOSE is disabled in .env');
        }
        venueSteps.zkRotate = { skipped: true, reasons };
      }
    }

    if (cexFlatten && cexFlatten.amount > 0) {
      applyDashboardExchangeKeysToEnv();
      const cexOut = await flattenCexPosition(cexFlatten);
      venueSteps.cex = { ok: true, orderId: cexOut.order?.id != null ? String(cexOut.order.id) : '' };
    }
  }

  const currentBtc = await fetchCurrentBtc();
  const { key } = getStrategyApiEnv();
  const mtm = key ? unrealizedUsdForOpen(row, currentBtc) : 0;
  const realized =
    opts.realizedPnlUsd != null && Number.isFinite(Number(opts.realizedPnlUsd))
      ? Number(opts.realizedPnlUsd)
      : mtm;

  const out = closePosition(tradeId, realized);
  if (!out.ok) return out;

  return {
    ok: true,
    realizedPnlUsd: realized,
    markToMarketUsd: mtm,
    venueSteps,
    mode,
  };
}

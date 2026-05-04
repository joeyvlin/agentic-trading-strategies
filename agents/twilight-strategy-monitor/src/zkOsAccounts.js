/**
 * Parse ZkOS rows from `relayer-cli wallet accounts --json` stdout and pick an index suitable for open-trade.
 * Coin (idle) accounts are preferred; Memo accounts are skipped for new opens.
 */

function parseJsonAccounts(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    const arr = Array.isArray(j) ? j : j?.accounts || j?.zkosAccounts || j?.zkAccounts || j?.data;
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const row of arr) {
      if (row == null || typeof row !== 'object') continue;
      const rawIx = row.account_index ?? row.accountIndex ?? row.index ?? row.zk_account_index;
      const ix = Number(rawIx);
      if (!Number.isFinite(ix)) continue;
      const io = String(row.io_type ?? row.ioType ?? row.IO_TYPE ?? '').trim() || null;
      const bal =
        row.balance_sats ??
        row.balanceSats ??
        row.balance ??
        row.memo_balance ??
        row.memoBalance;
      const balN = bal != null ? Number(bal) : null;
      out.push({
        index: ix,
        ioType: io,
        balanceSats: Number.isFinite(balN) ? balN : null,
        raw: row,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * @param {string} stdout
 * @returns {{ index: number, ioType: string|null, balanceSats: number|null, raw: object }[]}
 */
export function parseZkOsAccountRows(stdout) {
  const fromJson = parseJsonAccounts(stdout);
  if (fromJson.length) return fromJson;
  return [];
}

const collectIndexFromObject = (row) => {
  if (row == null || typeof row !== 'object') return null;
  const raw = row.account_index ?? row.accountIndex ?? row.index ?? row.zk_account_index;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse `relayer-cli wallet accounts --json` stdout into sorted numeric indices.
 * Uses structured JSON rows when available; otherwise regex / table heuristics (same as dashboard relayer-parse).
 * @param {string} stdout
 * @returns {number[]}
 */
export function parseZkOsAccountIndicesFromAccountsStdout(stdout) {
  const rows = parseZkOsAccountRows(stdout);
  if (rows.length) {
    return [...new Set(rows.map((r) => r.index).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  }

  const s = String(stdout || '').trim();
  if (!s) return [];
  if (/no zkos accounts found/i.test(s)) return [];

  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) {
      return j.map(collectIndexFromObject).filter((n) => n != null).sort((a, b) => a - b);
    }
    if (j && typeof j === 'object') {
      for (const key of ['accounts', 'zkosAccounts', 'zkAccounts', 'data']) {
        const arr = j[key];
        if (Array.isArray(arr)) {
          return arr.map(collectIndexFromObject).filter((n) => n != null).sort((a, b) => a - b);
        }
      }
      const one = collectIndexFromObject(j);
      if (one != null) return [one];
    }
  } catch {
    /* fall through */
  }

  const found = new Set();
  const re = /(?:account_index|accountIndex|index)\s*[:=]\s*(\d+)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) found.add(n);
  }
  for (const line of s.split('\n')) {
    const row = /^\s*(\d+)\s+/.exec(line);
    if (!row) continue;
    const n = Number(row[1]);
    if (Number.isFinite(n)) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

const isMemoIo = (io) => io && /^memo$/i.test(String(io).trim());
const isCoinIo = (io) => io && /^coin$/i.test(String(io).trim());

/**
 * Next Coin account index not in `tried` (newest first). Used after a failed open-trade.
 * @param {string} accountsStdout
 * @param {Iterable<number>} triedIndices
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx]
 */
export function pickNextCoinZkOsIndexAfterFailure(accountsStdout, triedIndices, ctx = {}) {
  const rows = parseZkOsAccountRows(accountsStdout);
  const tried = new Set([...triedIndices].map(Number).filter(Number.isFinite));
  const coins = rows.filter((r) => r.ioType && isCoinIo(r.ioType) && !tried.has(r.index));
  coins.sort((a, b) => b.index - a.index);
  if (coins.length) {
    const pick = coins[0];
    ctx.logger?.info?.(`[ZKOS_RETRY] Next candidate index ${pick.index} (Coin).`);
    return { index: String(pick.index), rows };
  }
  const nonMemo = rows.filter((r) => r.ioType && !isMemoIo(r.ioType) && !tried.has(r.index));
  nonMemo.sort((a, b) => b.index - a.index);
  if (nonMemo.length) {
    const pick = nonMemo[0];
    ctx.logger?.info?.(`[ZKOS_RETRY] Next candidate index ${pick.index} (non-Memo).`);
    return { index: String(pick.index), rows };
  }
  const summary = rows.length
    ? rows.map((r) => `${r.index}:${r.ioType ?? '?'}`).join(', ')
    : '(no structured rows)';
  throw new Error(
    `[ZKOS_RETRY] No remaining eligible ZkOS index outside tried [${[...tried].sort((a, b) => a - b).join(', ')}]. Parsed: ${summary}`
  );
}

/** Whether an open-trade failure may resolve after re-listing accounts and switching index. */
export function shouldRetryTwilightOpenAfterZkRefresh(errMsg) {
  const m = String(errMsg || '');
  if (/password|passphrase|unauthor|401|encrypted wallet|No encrypted wallet/i.test(m)) return false;
  if (/insufficient|not enough balance|fee/i.test(m)) return false;
  return (
    /memo/i.test(m) ||
    /does not exist/i.test(m) ||
    /locked/i.test(m) ||
    /already.*open|existing.*order|order.*already/i.test(m) ||
    /not.*eligible|invalid.*account|bad.*account/i.test(m)
  );
}

/**
 * Choose a ZkOS account index for a new open-trade.
 * Prefers env default when it is Coin; otherwise newest Coin by highest index (post-rotate accounts tend to be higher).
 *
 * @param {string} accountsStdout
 * @param {number|string|null|undefined} preferredIndex from TWILIGHT_ACCOUNT_INDEX
 * @param {{ logger?: { info?: Function } }} [ctx]
 * @returns {{ index: string, reason: string, rows: ReturnType<typeof parseZkOsAccountRows> }}
 */
export function pickZkOsIndexForOpenTrade(accountsStdout, preferredIndex, ctx = {}) {
  const rows = parseZkOsAccountRows(accountsStdout);
  const logger = ctx.logger;
  const want = Number(preferredIndex);
  const prefOk = Number.isFinite(want) && want >= 0;

  const isMemo = (io) => io && /^memo$/i.test(String(io).trim());
  const isCoin = (io) => io && /^coin$/i.test(String(io).trim());

  if (prefOk) {
    const row = rows.find((r) => r.index === want);
    if (row && !isMemo(row.ioType)) {
      const reason = row.ioType && isCoin(row.ioType) ? `default_index_${want}_coin` : `default_index_${want}_not_memo`;
      logger?.info?.(`[ZKOS] Using configured index ${want} (${reason}).`);
      return { index: String(want), reason, rows };
    }
    if (row && isMemo(row.ioType)) {
      logger?.info?.(`[ZKOS] Configured index ${want} is Memo — searching for a Coin account.`);
    }
  }

  const coinRows = rows.filter((r) => r.ioType && isCoin(r.ioType));
  coinRows.sort((a, b) => b.index - a.index);
  if (coinRows.length) {
    const pick = coinRows[0];
    logger?.info?.(
      `[ZKOS] Auto-picked ZkOS index ${pick.index} (io_type=${pick.ioType ?? '?'}) — newest Coin among ${coinRows.length} candidate(s).`
    );
    return { index: String(pick.index), reason: 'auto_newest_coin', rows };
  }

  const nonMemo = rows.filter((r) => r.ioType && !isMemo(r.ioType));
  nonMemo.sort((a, b) => b.index - a.index);
  if (nonMemo.length) {
    const pick = nonMemo[0];
    logger?.info?.(`[ZKOS] Auto-picked ZkOS index ${pick.index} (io_type=${pick.ioType ?? '?'}) — newest non-Memo row.`);
    return { index: String(pick.index), reason: 'auto_newest_non_memo', rows };
  }

  const summary =
    rows.length === 0
      ? 'No ZkOS rows parsed from wallet accounts output (need --json with account rows).'
      : `Parsed ${rows.length} row(s): ${rows
          .map((r) => `${r.index}:${r.ioType ?? '?'}`)
          .slice(0, 12)
          .join(', ')}${rows.length > 12 ? '…' : ''}`;

  throw new Error(
    `[ZKOS_AUTO] No ZkOS account eligible for open-trade (need Coin / non-Memo). ${summary}\n` +
      'Remediation: close or cancel any open Twilight order on a Memo index, run unlock-close-order after a settled close, then rotate with zkaccount transfer, or fund a fresh Coin account.'
  );
}

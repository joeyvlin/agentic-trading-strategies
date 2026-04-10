const WALLET_STORAGE_KEY = 'selectedTwilightWalletId';

/** Set by /api/relayer/wallet/balance-sats for ZkOS fund slider. */
let zkosSpendableSats = null;

/** Last successful `/api/relayer/meta` payload (faucet / network hints). */
let relayerMetaCache = null;

const api = (path, opts = {}) => {
  const headers = { ...opts.headers };
  const token = localStorage.getItem('dashboardToken');
  if (token) headers['x-dashboard-token'] = token;
  return fetch(path, { ...opts, headers });
};

function errMsg(e) {
  if (e && typeof e.message === 'string' && e.message) return e.message;
  return String(e);
}

/** Fetch failed before a normal HTTP response (offline, DNS, blocked, etc.). */
function isLikelyNetworkFailure(e) {
  const m = errMsg(e);
  return (
    /^Network error:/i.test(m) ||
    /failed to fetch|networkerror|load failed|err_network|aborted|econnrefused|enotfound/i.test(m)
  );
}

/** Background polls skip surfacing transport failures; user actions always show errors. */
function shouldSurfaceFetchError(e, opts = {}) {
  if (opts.userAction) return true;
  return !isLikelyNetworkFailure(e);
}

/** Maps `context` passed to showDashboardError / showDashboardWarning to a section id for in-place alerts. */
const SECTION_BY_CONTEXT = {
  'Strategy run': 'sec-strategies',
  'Strategy run skipped': 'sec-strategies',
  'Real trade': 'sec-strategies',
  'Real trading toggle': 'sec-wallet',
  'Wallet list': 'sec-wallet',
  'Wallet / manage': 'sec-manage',
  'Manage wallet': 'sec-manage',
  ZkOS: 'sec-zkos',
  'ZkOS balance': 'sec-zkos',
  'ZkOS allow': 'sec-zkos',
  'Relayer': 'sec-advanced',
  'Relayer meta': 'sec-advanced',
  'Agent PnL': 'sec-agent-pnl',
  'Transactions': 'sec-advanced',
  'Logs': 'sec-advanced',
  'Load config': 'sec-advanced',
  'Trade desk': 'sec-trade-desk',
  'Best trades': 'sec-strategies',
  'Journal': 'sec-journal',
  'Agent settings': 'sec-agent',
  'Save agent settings': 'sec-agent',
  'Close position': 'sec-agent-pnl',
  'Save .env': 'sec-env',
  'Reload .env': 'sec-env',
  'View raw .env': 'sec-env',
  'Testnet preset': 'sec-env',
  'Mainnet preset': 'sec-env',
  'Example Strategy API key': 'sec-env',
  'CEX keys status': 'sec-keys',
  'Faucet': 'sec-faucet',
  'Create wallet': 'sec-wallet',
  'Save CEX keys': 'sec-keys',
  'Add journal entry': 'sec-journal',
  'Remove journal entry': 'sec-journal',
  'Start monitor': 'sec-agent',
  'Stop monitor': 'sec-agent',
  'Simulation run': 'sec-advanced',
  'Save agent config YAML': 'sec-advanced',
  'Reset portfolio': 'sec-advanced',
};

/**
 * Show error / warning / success at the top of a section card when context maps to `SECTION_BY_CONTEXT`.
 * @param {'error'|'warn'|'success'} variant
 * @returns {boolean} true if rendered in-section (no top toast)
 */
function showSectionAlert(variant, message, context) {
  const ctx = context || (variant === 'error' ? 'Error' : variant === 'success' ? 'Done' : 'Notice');
  const sectionId = SECTION_BY_CONTEXT[ctx];
  if (!sectionId) return false;
  const sec = document.getElementById(sectionId);
  if (!sec) return false;

  let host = sec.querySelector(':scope > .dashboard-section-alert-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'dashboard-section-alert-host';
    sec.insertBefore(host, sec.firstChild);
  }

  const base =
    variant === 'error'
      ? 'dashboard-section-alert-error'
      : variant === 'success'
        ? 'dashboard-section-alert-success'
        : 'dashboard-section-alert-warn';
  const role = variant === 'success' ? 'status' : 'alert';
  host.innerHTML = `
    <div class="dashboard-section-alert ${base}" role="${role}">
      <div class="dashboard-section-alert-head">
        <span class="dashboard-section-alert-ctx">${escapeHtml(ctx)}</span>
        <button type="button" class="btn ghost small dashboard-section-alert-dismiss" aria-label="Dismiss">×</button>
      </div>
      <pre class="dashboard-section-alert-body">${escapeHtml(String(message || '').trim() || 'Unknown error')}</pre>
    </div>
  `;
  host.querySelector('.dashboard-section-alert-dismiss')?.addEventListener('click', () => {
    host.innerHTML = '';
  });

  try {
    sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch {
    /* ignore */
  }

  if (sectionId === 'sec-advanced' && typeof sec.open === 'boolean') {
    sec.open = true;
  }

  return true;
}

function parseApiErrorBody(text, status) {
  const st = status ?? '?';
  if (!text || !String(text).trim()) return `[${st}] (empty response body)`;
  try {
    const j = JSON.parse(text);
    let msg = '';
    if (typeof j.error === 'string') msg = j.error;
    else if (typeof j.message === 'string') msg = j.message;
    else if (typeof j.msg === 'string') msg = j.msg;
    if (msg && Array.isArray(j.details) && j.details.length) {
      msg +=
        '\n' +
        j.details.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join('\n');
    }
    if (msg && typeof j.hint === 'string' && j.hint.trim()) {
      msg += '\n' + j.hint.trim();
    }
    if (msg) return `[${st}] ${msg}`;
    return `[${st}] ${String(text).slice(0, 1500)}`;
  } catch {
    const t = String(text).trim();
    return `[${st}] ${t.length > 1800 ? t.slice(0, 1800) + '…' : t}`;
  }
}

/** Toast for explicit user actions only (not polling / page load). Prefer in-section alert when context maps to a section. */
function showDashboardError(message, context = '') {
  const msg = String(message || 'Unknown error').trim() || 'Unknown error';
  const ctx = context || 'Error';
  if (showSectionAlert('error', msg, ctx)) return;
  const wrap = document.getElementById('dashboard-toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'dashboard-toast dashboard-toast-error';
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    <div class="dashboard-toast-head">
      <span class="dashboard-toast-ctx">${escapeHtml(ctx)}</span>
      <button type="button" class="btn ghost small dashboard-toast-dismiss" aria-label="Dismiss">×</button>
    </div>
    <pre class="dashboard-toast-body">${escapeHtml(msg)}</pre>
  `;
  el.querySelector('.dashboard-toast-dismiss').addEventListener('click', () => el.remove());
  wrap.prepend(el);
  while (wrap.children.length > 12) wrap.lastChild.remove();
}

function showDashboardSuccess(message, context = '') {
  const msg = String(message || '').trim();
  if (!msg) return;
  const ctx = context || 'Done';
  if (showSectionAlert('success', msg, ctx)) return;
  const wrap = document.getElementById('dashboard-toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'dashboard-toast dashboard-toast-success';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <div class="dashboard-toast-head">
      <span class="dashboard-toast-ctx">${escapeHtml(ctx)}</span>
      <button type="button" class="btn ghost small dashboard-toast-dismiss" aria-label="Dismiss">×</button>
    </div>
    <pre class="dashboard-toast-body">${escapeHtml(msg)}</pre>
  `;
  el.querySelector('.dashboard-toast-dismiss').addEventListener('click', () => el.remove());
  wrap.prepend(el);
  while (wrap.children.length > 12) wrap.lastChild.remove();
}

function showDashboardWarning(message, context = '') {
  const msg = String(message || '').trim();
  if (!msg) return;
  const ctx = context || 'Notice';
  if (showSectionAlert('warn', msg, ctx)) return;
  const wrap = document.getElementById('dashboard-toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'dashboard-toast dashboard-toast-warn';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <div class="dashboard-toast-head">
      <span class="dashboard-toast-ctx">${escapeHtml(ctx)}</span>
      <button type="button" class="btn ghost small dashboard-toast-dismiss" aria-label="Dismiss">×</button>
    </div>
    <pre class="dashboard-toast-body">${escapeHtml(msg)}</pre>
  `;
  el.querySelector('.dashboard-toast-dismiss').addEventListener('click', () => el.remove());
  wrap.prepend(el);
  while (wrap.children.length > 12) wrap.lastChild.remove();
}

async function readJson(path, opts) {
  let res;
  try {
    res = await api(path, opts);
  } catch (e) {
    throw new Error(`Network error: ${errMsg(e)}`);
  }
  const text = await res.text();
  if (res.status === 401) {
    throw new Error(
      'Unauthorized — set the dashboard token in the header if the server has DASHBOARD_TOKEN set (x-dashboard-token).'
    );
  }
  if (!res.ok) {
    throw new Error(parseApiErrorBody(text, res.status));
  }
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from server (${res.status}): ${text.slice(0, 400)}`);
  }
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function walletSession() {
  const walletId = document.getElementById('wallet-select')?.value?.trim() || '';
  const password = document.getElementById('wallet-pass')?.value || '';
  const o = {};
  if (walletId) o.walletId = walletId;
  if (password) o.password = password;
  return o;
}

/** Panel-specific wallet id; password always from Twilight wallet (session) only. */
function credsFromPanel(selectId) {
  const panelSel = document.getElementById(selectId);
  const sessionSel = document.getElementById('wallet-select');
  const sessionPass = document.getElementById('wallet-pass');
  const walletId = (panelSel?.value ?? sessionSel?.value ?? '').trim() || '';
  const password = sessionPass?.value ?? '';
  const o = {};
  if (walletId) o.walletId = walletId;
  if (password) o.password = password;
  return o;
}

function faucetWalletCreds() {
  return credsFromPanel('faucet-wallet-select');
}

function manageWalletCreds() {
  return credsFromPanel('manage-wallet-select');
}

const PANEL_WALLET_SELECT_IDS = ['faucet-wallet-select', 'manage-wallet-select'];

function syncPanelWalletSelectsFromSession() {
  const sel = document.getElementById('wallet-select');
  if (!sel) return;
  for (const id of PANEL_WALLET_SELECT_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.innerHTML = sel.innerHTML;
    el.value = sel.value;
  }
}

function syncConfirmRealTradingToggle(entries) {
  const chk = document.getElementById('chk-confirm-real-trading');
  const hint = document.getElementById('confirm-real-trading-hint');
  if (!chk) return;
  const row = (entries || []).find((r) => r.key === 'CONFIRM_REAL_TRADING');
  const on = row?.hasValue && String(row.value || '').trim().toUpperCase() === 'YES';
  chk.checked = !!on;
  if (hint) {
    hint.textContent = on
      ? 'Real trading is on — live orders are allowed when execution mode is real.'
      : 'Real trading is off — live orders are blocked (simulation still works).';
  }
}

function syncZkosAllowToggle(entries) {
  const chk = document.getElementById('chk-allow-dashboard-zk');
  const hint = document.getElementById('zkos-allow-hint');
  if (!chk) return;
  const row = (entries || []).find((r) => r.key === 'RELAYER_ALLOW_DASHBOARD_ZK');
  const on = row?.hasValue && String(row.value || '').trim().toUpperCase() === 'YES';
  chk.checked = !!on;
  if (hint) {
    hint.textContent = on
      ? 'ZkOS fund and rotate are allowed for this server process.'
      : 'Enable to write RELAYER_ALLOW_DASHBOARD_ZK=YES to .env (required for fund / rotate).';
  }
}

function formatRelayerMissingMessage(raw) {
  const m = String(raw || '');
  if (/ENOENT|not found/i.test(m) && /relayer/i.test(m)) {
    return (
      'The dashboard could not run relayer-cli (file not found). ' +
      'Build it from nyks-wallet (for example: cargo build --release --bin relayer-cli), ' +
      'then set TWILIGHT_RELAYER_CLI in your repo .env to the full path of the binary, ' +
      'or put relayer-cli on your PATH. Original error: ' +
      m
    );
  }
  return m;
}

async function refreshWalletList(selectId = null, opts = {}) {
  const sel = document.getElementById('wallet-select');
  const hint = document.getElementById('wallet-select-hint');
  const prev = selectId || localStorage.getItem(WALLET_STORAGE_KEY) || sel.value;
  try {
    const r = await readJson('/api/relayer/wallet/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (hint) {
      hint.textContent = '';
      hint.classList.remove('hint-error');
    }
    const wallets = Array.isArray(r.wallets) ? r.wallets : [];
    sel.innerHTML =
      '<option value="">— Select wallet —</option>' +
      wallets
        .map(
          (w) =>
            `<option value="${escapeHtml(w.walletId)}">${escapeHtml(w.walletId)} · ${escapeHtml(
              w.createdAt || ''
            )}</option>`
        )
        .join('');
    const pick = wallets.some((w) => w.walletId === prev) ? prev : '';
    sel.value = pick;
    if (pick) localStorage.setItem(WALLET_STORAGE_KEY, pick);
    else localStorage.removeItem(WALLET_STORAGE_KEY);
    syncPanelWalletSelectsFromSession();
    await refreshZkosBalance();
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = formatRelayerMissingMessage(errMsg(e));
    sel.innerHTML = '<option value="">— Select wallet —</option>';
    syncPanelWalletSelectsFromSession();
    if (hint) {
      hint.textContent = m;
      hint.classList.add('hint-error');
    }
    if (opts.userAction) showDashboardError(m, 'Wallet list');
  }
}

/** Pull tx hash from faucet/mint JSON body string (nested `data.txHash`). */
function parseFaucetStepTxHash(bodyStr) {
  try {
    const j = JSON.parse(String(bodyStr || '').trim());
    const d = j && typeof j === 'object' ? j.data || j : j;
    if (d && typeof d === 'object') {
      const h = d.txHash || d.tx_hash;
      if (typeof h === 'string' && h.trim()) return h.trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function updateFaucetMintUiHints() {
  const warn = document.getElementById('faucet-mint-warning');
  const chk = document.getElementById('chk-faucet-sats');
  const m = relayerMetaCache;
  if (!warn) return;
  if (!m || !chk?.checked) {
    warn.hidden = true;
    return;
  }
  warn.hidden = !!m.testSatsMintExpected;
}

function renderFaucetResponse(r) {
  const pre = document.getElementById('faucet-out');
  const summary = document.getElementById('faucet-result-summary');
  const stepNyks = document.getElementById('faucet-step-nyks');
  const stepMint = document.getElementById('faucet-step-mint');
  const postMint = document.getElementById('faucet-post-mint-hint');
  if (postMint) {
    postMint.hidden = true;
    postMint.textContent = '';
  }
  if (pre) pre.textContent = JSON.stringify(r, null, 2);
  if (summary) summary.hidden = false;
  if (stepNyks) {
    const st = r.nyks?.status ?? '?';
    stepNyks.textContent = `NYKS (POST /faucet): OK — HTTP ${st}`;
    stepNyks.className = 'faucet-step faucet-step-ok';
  }
  if (stepMint) {
    if (!r.mintTestSatsRequested) {
      stepMint.textContent = 'Test sats (POST /mint): not requested (checkbox off).';
      stepMint.className = 'faucet-step faucet-step-muted';
      return;
    }
    if (r.mint?.skipped) {
      const reason = String(r.mint.reason || 'skipped');
      stepMint.textContent = `Test sats (POST /mint): skipped — ${reason}`;
      stepMint.className = 'faucet-step faucet-step-warn';
      showSectionAlert('warn', reason, 'Faucet');
      return;
    }
    if (r.mint?.ok === false) {
      const detail = `${r.mint.error || 'Unknown error'}\n\n${r.mint.hint || ''}`.trim();
      stepMint.textContent = `Test sats (POST /mint): FAILED\n${detail}`;
      stepMint.className = 'faucet-step faucet-step-err';
      showDashboardError(detail, 'Faucet');
      return;
    }
    stepMint.textContent = `Test sats (POST /mint): OK — HTTP ${r.mint?.status ?? '?'}`;
    stepMint.className = 'faucet-step faucet-step-ok';
    if (postMint && r.mintTestSatsRequested) {
      const mintTx = parseFaucetStepTxHash(r.mint?.body);
      const nyksTx = parseFaucetStepTxHash(r.nyks?.body);
      const parts = [
        'The faucet returned HTTP 200 before your local wallet view is guaranteed to show spendable SATS. Wait 1–5 minutes for testnet indexing / confirmations, then use Manage → Balance or ZkOS → Refresh balance.',
        mintTx ? `BTC mint tx: ${mintTx}` : '',
        nyksTx ? `NYKS tx: ${nyksTx}` : '',
      ].filter(Boolean);
      postMint.textContent = parts.join('\n');
      postMint.hidden = false;
    }
    showSectionAlert(
      'success',
      'Mint succeeded over HTTP. If SATS still reads 0, wait a few minutes and refresh balance — see the note below the step lines.',
      'Faucet'
    );
  }
}

async function loadRelayerMetaHints() {
  const hint = document.getElementById('relayer-binary-hint');
  const faucetHint = document.getElementById('faucet-hint');
  const faucetEnv = document.getElementById('faucet-env-line');
  const zkosGate = document.getElementById('zkos-gate-line');
  try {
    const m = await readJson('/api/relayer/meta');
    relayerMetaCache = m;
    if (hint) {
      const nt = m.networkType != null ? m.networkType : 'unset';
      hint.textContent = `Binary: ${m.binary} · NETWORK_TYPE: ${nt} · Zk: ${m.zkAllowEnv ? 'on' : 'off'} · orders: ${m.ordersAllowEnv ? 'on' : 'off'}`;
      hint.classList.remove('hint-error');
    }
    if (zkosGate) {
      zkosGate.textContent = m.zkAllowEnv
        ? 'Relayer meta: ZkOS dashboard actions are on.'
        : 'Relayer meta: ZkOS still off — use the “Allow ZkOS actions” checkbox above, or Reload env after editing .env.';
      zkosGate.classList.toggle('hint-error', !m.zkAllowEnv);
    }
    if (faucetHint) {
      faucetHint.classList.toggle('warn', !m.faucetConfigured);
    }
    if (faucetEnv) {
      const nt = m.networkType != null ? m.networkType : '(unset)';
      const fb = m.faucetBaseUrl || '(FAUCET_BASE_URL not set)';
      const mintOk = m.testSatsMintExpected ? 'yes (testnet + faucet URL)' : 'no — set testnet + faucet';
      faucetEnv.textContent = `Server env snapshot: NETWORK_TYPE=${nt} · FAUCET_BASE_URL=${fb} · test sats mint expected: ${mintOk}`;
      faucetEnv.classList.toggle('warn', m.faucetConfigured === true && m.networkType === 'mainnet');
    }
    updateFaucetMintUiHints();
  } catch (e) {
    relayerMetaCache = null;
    if (isLikelyNetworkFailure(e)) return;
    const m = errMsg(e);
    if (hint) {
      hint.textContent = m;
      hint.classList.add('hint-error');
    }
    if (zkosGate) {
      zkosGate.textContent = m;
      zkosGate.classList.add('hint-error');
    }
    if (faucetEnv) faucetEnv.textContent = '';
    updateFaucetMintUiHints();
  }
}

function zkosAppendInsufficientHint(text, r) {
  const errBlob = `${r?.stderr || ''}\n${r?.stdout || ''}`;
  if (!/Insufficient balance/i.test(errBlob)) return text;
  return (
    text +
    '\n\n---\nHint: if you are funding well below your full balance, fees are usually not the reason — the ' +
    '“spendable” number here is best-effort from `wallet balance` JSON and can disagree with what `zkaccount fund` ' +
    'can actually spend (UTXOs, confirmations, relayer rules). Compare Manage → Balance raw output, try a smaller ' +
    'amount, or check nyks-wallet / relayer docs.'
  );
}

async function zkosPost(path, body) {
  const out = document.getElementById('zkos-out');
  if (!out) return;
  out.textContent = 'Running…';
  try {
    const r = await readJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let text = JSON.stringify(r, null, 2);
    if (r && r.ok === false) text = zkosAppendInsufficientHint(text, r);
    out.textContent = text;
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    showDashboardError(m, 'ZkOS');
  }
}

function zkosPostWithCreds(path, extra = {}) {
  const creds = walletSession();
  if (!creds.walletId) {
    showDashboardWarning('Select a wallet and enter password in Twilight wallet (step 1).', 'ZkOS');
    return;
  }
  zkosPost(path, { ...creds, ...extra });
}

/**
 * When funding ~most of displayed spendable, leave a small buffer for fee/edge cases.
 * For partial funds (e.g. 50%), fees come from the remainder — no buffer needed.
 */
function zkFundAmountAfterFeeHeadroom(rawSats, spendableSats) {
  const raw = Math.floor(Number(rawSats) || 0);
  if (raw <= 0) return 0;
  const sp = spendableSats != null ? Number(spendableSats) : null;
  if (sp != null && sp > 0 && raw <= sp * 0.85) {
    return raw;
  }
  const desiredBuffer = Math.min(25_000, Math.max(546, Math.ceil(raw * 0.025)));
  const buffer = Math.min(Math.max(0, raw - 1), desiredBuffer);
  return Math.max(0, raw - buffer);
}

function setZkosFundFromPct(pctRaw) {
  const pct = Math.min(100, Math.max(0, Number(pctRaw) || 0));
  const input = document.getElementById('zkos-fund-sats');
  const readout = document.getElementById('zkos-fund-pct-readout');
  const slider = document.getElementById('zkos-fund-pct');
  if (readout) readout.textContent = `${pct}%`;
  if (slider && String(slider.value) !== String(pct)) slider.value = String(pct);
  if (zkosSpendableSats == null || zkosSpendableSats <= 0) {
    if (input && pct === 0) input.value = '';
    return;
  }
  const raw = Math.floor((zkosSpendableSats * pct) / 100);
  const amt = zkFundAmountAfterFeeHeadroom(raw, zkosSpendableSats);
  if (input) input.value = amt > 0 ? String(amt) : '';
}

function syncZkosPctFromFundInput() {
  const input = document.getElementById('zkos-fund-sats');
  const slider = document.getElementById('zkos-fund-pct');
  const readout = document.getElementById('zkos-fund-pct-readout');
  if (!input || !slider || !readout) return;
  if (zkosSpendableSats == null || zkosSpendableSats <= 0) return;
  const n = Number(String(input.value).trim().replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return;
  const pct = Math.min(100, Math.max(0, Math.round((n / zkosSpendableSats) * 100)));
  slider.value = String(pct);
  readout.textContent = `${pct}%`;
}

async function refreshZkosBalance(opts = {}) {
  const valEl = document.getElementById('zkos-balance-value');
  const nyksEl = document.getElementById('zkos-balance-nyks');
  const pendingEl = document.getElementById('zkos-balance-pending');
  const hintEl = document.getElementById('zkos-balance-parse-hint');
  const slider = document.getElementById('zkos-fund-pct');
  const creds = walletSession();
  if (!creds.walletId) {
    zkosSpendableSats = null;
    if (valEl) valEl.textContent = '—';
    if (nyksEl) nyksEl.textContent = '';
    if (pendingEl) pendingEl.textContent = '';
    if (slider) {
      slider.disabled = true;
      slider.value = '0';
    }
    setZkosFundFromPct(0);
    if (hintEl) hintEl.hidden = true;
    return;
  }
  if (valEl) valEl.textContent = '…';
  if (nyksEl) nyksEl.textContent = '';
  if (pendingEl) pendingEl.textContent = '';
  try {
    const r = await readJson('/api/relayer/wallet/balance-sats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    zkosSpendableSats = r.spendableSats != null ? Number(r.spendableSats) : null;
    if (valEl) {
      valEl.textContent =
        zkosSpendableSats != null ? `${Number(zkosSpendableSats).toLocaleString()} sats` : '—';
    }
    if (nyksEl) {
      const ny = r.nyksBalance != null ? Number(r.nyksBalance) : null;
      nyksEl.textContent =
        ny != null && Number.isFinite(ny) ? ` · NYKS: ${ny.toLocaleString()}` : '';
    }
    if (pendingEl) {
      const pen = r.pendingSats != null ? Number(r.pendingSats) : null;
      pendingEl.textContent =
        pen != null && Number.isFinite(pen) && pen > 0
          ? ` · pending BTC (unconfirmed): ~${pen.toLocaleString()} sats`
          : '';
    }
    if (slider) {
      const ok = zkosSpendableSats != null && zkosSpendableSats > 0;
      slider.disabled = !ok;
      slider.value = '0';
    }
    setZkosFundFromPct(0);
    if (hintEl) {
      if (r.parseNote && r.ok) {
        hintEl.textContent = r.parseNote;
        hintEl.hidden = false;
      } else {
        hintEl.hidden = true;
      }
    }
  } catch (e) {
    zkosSpendableSats = null;
    if (valEl) valEl.textContent = '—';
    if (nyksEl) nyksEl.textContent = '';
    if (pendingEl) pendingEl.textContent = '';
    if (slider) {
      slider.disabled = true;
      slider.value = '0';
    }
    setZkosFundFromPct(0);
    if (hintEl) hintEl.hidden = true;
    if (opts.userAction) showDashboardError(errMsg(e), 'ZkOS balance');
  }
}

async function managePost(path, body) {
  const out = document.getElementById('manage-out');
  if (!out) return;
  out.textContent = 'Running…';
  try {
    const r = await readJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    out.textContent = JSON.stringify(r, null, 2);
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    showDashboardError(m, 'Wallet / manage');
  }
}

function managePostWithCreds(path, extra = {}) {
  const creds = manageWalletCreds();
  if (!creds.walletId) {
    showDashboardWarning('Select a wallet in Twilight wallet (step 1).', 'Manage wallet');
    return;
  }
  managePost(path, { ...creds, ...extra });
}

document.getElementById('chk-confirm-real-trading')?.addEventListener('change', async (ev) => {
  const on = ev.target.checked;
  try {
    await readJson('/api/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: { CONFIRM_REAL_TRADING: on ? 'YES' : '' } }),
    });
    showDashboardSuccess(
      on
        ? 'Saved CONFIRM_REAL_TRADING=YES to .env — applied for this process.'
        : 'Removed CONFIRM_REAL_TRADING from .env — live orders disabled.',
      'Real trading'
    );
    await refreshEnv();
  } catch (e) {
    ev.target.checked = !on;
    showDashboardError(errMsg(e), 'Real trading toggle');
  }
});

document.getElementById('chk-allow-dashboard-zk')?.addEventListener('change', async (ev) => {
  const on = ev.target.checked;
  try {
    await readJson('/api/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: { RELAYER_ALLOW_DASHBOARD_ZK: on ? 'YES' : '' } }),
    });
    showDashboardSuccess(
      on
        ? 'Saved RELAYER_ALLOW_DASHBOARD_ZK=YES — ZkOS fund/transfer enabled for this process.'
        : 'Removed RELAYER_ALLOW_DASHBOARD_ZK — ZkOS fund/transfer disabled.',
      'ZkOS allow'
    );
    await refreshEnv();
    await loadRelayerMetaHints();
  } catch (e) {
    ev.target.checked = !on;
    showDashboardError(errMsg(e), 'ZkOS allow');
  }
});

async function relayerPost(path, body) {
  const out = document.getElementById('relayer-out');
  if (!out) return;
  out.textContent = 'Running…';
  try {
    const r = await readJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    out.textContent = JSON.stringify(r, null, 2);
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    showDashboardError(m, 'Relayer');
  }
}

async function refreshStatus(opts = {}) {
  const el = document.getElementById('status-line');
  const last = document.getElementById('last-cycle');
  if (!el) return;
  try {
    const s = await readJson('/api/status');
    const running = s.running;
    el.classList.toggle('running', running);
    el.textContent = running
      ? `Running · poll ${s.pollIntervalMs}ms · open notionals ~ ${fmtUsd(s.openNotionalUsd)} · book ${s.logicalTradeCount} leg(s)`
      : `Stopped · open notionals ~ ${fmtUsd(s.openNotionalUsd)} · book ${s.logicalTradeCount} leg(s)`;
    if (s.lastCycle) {
      const lc = s.lastCycle;
      last.textContent = lc.skipped
        ? `Last cycle: skipped (${lc.reason})`
        : `Last cycle: ${lc.strategy?.name ?? 'trade'} · mode ${lc.transaction?.mode ?? '—'}`;
    } else if (last) {
      last.textContent = '';
    }
    if (s.lastError && last) {
      last.textContent += ` · Error: ${s.lastError}`;
    }
    el.classList.remove('status-error');
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    el.textContent = `Error loading status: ${m}`;
    el.classList.add('status-error');
  }
}

async function refreshPnl(opts = {}) {
  const el = document.getElementById('pnl-stats');
  const note = document.getElementById('pnl-note-line');
  const openBody = document.getElementById('positions-open-body');
  const closedBody = document.getElementById('positions-closed-body');
  try {
    const p = await readJson('/api/pnl');
    if (el) {
      el.innerHTML = `
      <dt>Realized P&amp;L (closed)</dt><dd>${fmtUsd(p.realizedPnlUsd)}</dd>
      <dt>Unrealized P&amp;L (open)</dt><dd>${fmtUsd(p.unrealizedPnlUsd)}</dd>
      <dt>BTC mark</dt><dd>${p.currentBtcPrice ? '$' + Number(p.currentBtcPrice).toLocaleString() : '—'}</dd>
      <dt>Open positions</dt><dd>${p.openCount ?? 0}</dd>
      <dt>Closed positions</dt><dd>${p.closedCount ?? 0}</dd>
      <dt>Agent tx log (rows)</dt><dd>${p.transactionCount}</dd>
      <dt>Illustrative daily (APY×notional)</dt><dd>${fmtUsd(p.sumEstimatedDailyUsd)}</dd>
      <dt>Open notional (portfolio)</dt><dd>${fmtUsd(p.openNotionalUsd)}</dd>
    `;
    }
    if (note) note.textContent = p.pnlNote || '';

    const opens = p.openPositions || [];
    if (openBody) {
      openBody.innerHTML = opens
        .map(
          (o) => `
        <tr>
          <td>#${o.strategyId} ${escapeHtml(o.strategyName || '')}</td>
          <td>${escapeHtml(o.mode || '')}</td>
          <td>${o.entryBtcPrice ? '$' + Number(o.entryBtcPrice).toLocaleString() : '—'}</td>
          <td>${o.unrealizedPnlUsd != null ? fmtUsd(o.unrealizedPnlUsd) : '—'}</td>
          <td class="pos-close-cell">
            <input type="text" class="pos-close-amt" data-tid="${escapeHtml(o.tradeId)}" placeholder="Realized $" size="10" />
            <button type="button" class="btn small primary pos-close-btn" data-tid="${escapeHtml(o.tradeId)}">Close</button>
          </td>
        </tr>`
        )
        .join('');
      if (!opens.length) openBody.innerHTML = `<tr><td colspan="5">No open positions. Run a strategy (Sim) to open one.</td></tr>`;
    }

    const closed = (p.closedPositions || []).slice(0, 30);
    if (closedBody) {
      closedBody.innerHTML = closed
        .map(
          (c) => `
        <tr>
          <td>${fmtTime(c.closedAt)}</td>
          <td>#${c.strategyId} ${escapeHtml(c.strategyName || '')}</td>
          <td>${fmtUsd(c.realizedPnlUsd)}</td>
        </tr>`
        )
        .join('');
      if (!closed.length) {
        closedBody.innerHTML = `<tr><td colspan="3">No closed positions yet. Enter realized P&amp;L when you flatten.</td></tr>`;
      }
    }
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    if (el) el.innerHTML = `<dt>Error</dt><dd>${escapeHtml(m)}</dd>`;
    if (openBody) openBody.innerHTML = '';
    if (closedBody) closedBody.innerHTML = '';
    if (opts.userAction) showDashboardError(m, 'Agent PnL');
  }
}

async function refreshTx(opts = {}) {
  const body = document.getElementById('tx-body');
  if (!body) return;
  try {
    const { transactions } = await readJson('/api/transactions');
    body.innerHTML = transactions
      .map(
        (t) => `
      <tr>
        <td>${fmtTime(t.at || t.savedAt)}</td>
        <td>#${t.strategyId} ${escapeHtml(t.strategyName || '')}</td>
        <td>${t.apy != null ? Number(t.apy).toFixed(2) + '%' : '—'}</td>
        <td>${fmtUsd(t.totalNotionalUsd)}</td>
        <td>${fmtUsd(t.estimatedDailyUsd)}</td>
        <td>${escapeHtml(t.mode || '')}${t.execution?.cex?.orderId ? ` · CEX ${escapeHtml(String(t.execution.cex.orderId))}` : ''}</td>
      </tr>`
      )
      .join('');
    if (!transactions.length) {
      body.innerHTML = `<tr><td colspan="6">No transactions yet.</td></tr>`;
    }
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    body.innerHTML = `<tr><td colspan="6">${escapeHtml(m)}</td></tr>`;
    if (opts.userAction) showDashboardError(m, 'Transactions');
  }
}

async function refreshLogs(opts = {}) {
  const box = document.getElementById('log-box');
  if (!box) return;
  try {
    const { logs } = await readJson('/api/logs');
    box.textContent = logs.map((l) => `[${l.t}] ${l.level.toUpperCase()} ${l.msg}`).join('\n');
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    box.textContent = m;
    if (opts.userAction) showDashboardError(m, 'Logs');
  }
}

async function loadConfig(opts = {}) {
  const ta = document.getElementById('config-yaml');
  const msg = document.getElementById('config-msg');
  if (!ta) return;
  if (msg) {
    msg.textContent = '';
    msg.classList.remove('hint-error');
  }
  try {
    const c = await readJson('/api/config');
    ta.value = c.content;
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    if (opts.userAction) showDashboardError(m, 'Load config');
  }
}

function encodeStrategyMetaForBtn(s) {
  try {
    const o = {
      id: s.id,
      name: String(s.name || ''),
      twilightSize: Number(s.twilightSize) || 0,
      binanceSize: Number(s.binanceSize) || 0,
      apy: s.apy,
    };
    return btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  } catch {
    return '';
  }
}

function decodeStrategyMetaFromBtn(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  try {
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function strategyTemplateTotalUsd(meta) {
  if (!meta) return 0;
  return (Number(meta.twilightSize) || 0) + (Number(meta.binanceSize) || 0);
}

let realTradeModalState = null;

function closeRealTradeModal() {
  const el = document.getElementById('modal-real-trade');
  const pre = document.getElementById('modal-real-balance-out');
  if (el) {
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
  }
  if (pre) {
    pre.hidden = true;
    pre.textContent = '';
  }
  realTradeModalState = null;
}

function openRealTradeModal(strategyId, meta) {
  realTradeModalState = { strategyId, meta };
  const overlay = document.getElementById('modal-real-trade');
  const line = document.getElementById('modal-real-trade-strategy');
  const tmpl = document.getElementById('modal-real-trade-template');
  const input = document.getElementById('modal-real-total-usd');
  if (!overlay || !line || !tmpl || !input) return;
  const tw = Number(meta?.twilightSize) || 0;
  const cx = Number(meta?.binanceSize) || 0;
  const total = tw + cx;
  line.textContent = `#${strategyId} ${meta?.name || 'Strategy'}`;
  tmpl.textContent =
    total > 0
      ? `Template notionals: Twilight $${tw.toLocaleString()} · CEX $${cx.toLocaleString()} · total $${total.toLocaleString()}`
      : 'Template shows $0 notionals — enter any positive total you want the agent to size toward.';
  input.value = total > 0 ? String(Math.round(total)) : '1000';
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  input.focus();
  input.select();
}

function setRealTradePresetPercent(pct) {
  if (!realTradeModalState?.meta) return;
  const base = strategyTemplateTotalUsd(realTradeModalState.meta);
  const input = document.getElementById('modal-real-total-usd');
  if (!input) return;
  if (base <= 0) {
    showDashboardWarning('No template notionals to scale; set total USD manually.', 'Real trade');
    return;
  }
  input.value = String(Math.max(1, Math.round((base * pct) / 100)));
}

async function runStrategyExecute(strategyId, mode, options = {}) {
  const { targetTotalNotionalUsd, skipRealConfirm } = options;
  if (mode === 'real' && !skipRealConfirm) {
    if (
      !confirm(
        'Run REAL execution for this strategy? Requires API keys, relayer if the Twilight leg is used, and “Allow real trading” enabled in Twilight wallet (step 1).'
      )
    ) {
      return;
    }
  }
  try {
    const body = { strategyId, mode };
    const t = targetTotalNotionalUsd != null ? Number(targetTotalNotionalUsd) : NaN;
    if (Number.isFinite(t) && t > 0) {
      body.targetTotalNotionalUsd = t;
    }
    if (mode === 'real') {
      const w = walletSession();
      if (w.walletId) body.walletId = w.walletId;
      if (w.password) body.password = w.password;
    }
    const r = await readJson('/api/monitor/run-strategy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.skipped) {
      showDashboardWarning(
        `${r.reason}${r.details ? '\n' + r.details.join('\n') : ''}`,
        'Strategy run skipped'
      );
    } else {
      const t = r.transaction;
      const ex = t?.execution;
      if (t) {
        let msg = `Logical trade ${t.tradeId}\nStrategy #${t.strategyId} ${t.strategyName || ''}\nMode: ${t.mode || '—'}\nNotional ${fmtUsd(t.totalNotionalUsd)}`;
        if (ex?.kind === 'simulation' && ex.note) msg += `\n${ex.note}`;
        if (ex?.twilight?.completed) msg += '\nTwilight: executed (see Trade desk for CLI output).';
        if (ex?.twilight?.reason) {
          msg += `\nTwilight: ${ex.twilight.reason}`;
        }
        if (ex?.cex?.completed && ex.cex.orderId) {
          msg += `\nCEX (${ex.cex.venue}): order ${ex.cex.orderId} ${ex.cex.status ? `status ${ex.cex.status}` : ''}`;
        }
        if (ex?.cex?.reason) msg += `\nCEX: ${ex.cex.reason}`;
        showDashboardSuccess(msg.trim(), 'Strategy run');
      } else {
        showDashboardSuccess('Completed with no transaction record.', 'Strategy run');
      }
    }
    await refreshPnl({ userAction: true });
    await refreshTx({ userAction: true });
    await refreshTradeDesk({ userAction: true });
    await refreshStatus({ userAction: true });
  } catch (e) {
    showDashboardError(errMsg(e), 'Strategy run');
  }
}

function strategyRowAccentStyle(strategyId) {
  const n = Number(strategyId) || 0;
  const hue = (n * 47) % 360;
  return `border-left: 4px solid hsl(${hue} 42% 46%);`;
}

function formatExecTwilightCell(execution) {
  if (!execution || !execution.twilight) return '—';
  const t = execution.twilight;
  if (t.completed) {
    const preview = (t.stdoutPreview || '').trim().slice(0, 220);
    const full = (t.stdoutPreview || '') + (t.stderrPreview ? '\n' + t.stderrPreview : '');
    const esc = escapeHtml(preview || 'OK');
    return `<span class="trade-desk-clip" title="${escapeHtml(full.slice(0, 8000))}">${esc || 'OK'}</span>`;
  }
  return escapeHtml(t.reason || '—');
}

function formatExecCexCell(execution) {
  if (!execution || !execution.cex) return '—';
  const c = execution.cex;
  if (c.completed) {
    const parts = [
      c.venue && `${c.venue}`,
      c.orderId && `id ${c.orderId}`,
      c.status,
      c.side,
      c.price != null && `px ${c.price}`,
      c.filled != null && `filled ${c.filled}`,
    ].filter(Boolean);
    return escapeHtml(parts.join(' · '));
  }
  return escapeHtml(`${c.venue || 'cex'}: ${c.reason || '—'}`);
}

async function refreshTradeDesk(opts = {}) {
  const tbody = document.getElementById('trade-desk-exec-body');
  const meta = document.getElementById('trade-desk-meta');
  const binBody = document.getElementById('trade-desk-binance-body');
  const byBody = document.getElementById('trade-desk-bybit-body');
  const twOut = document.getElementById('trade-desk-twilight-out');
  if (!tbody) return;
  try {
    const sessionWid = document.getElementById('wallet-select')?.value?.trim() || '';
    const tradeDeskPath =
      '/api/trade-desk' + (sessionWid ? `?walletId=${encodeURIComponent(sessionWid)}` : '');
    const d = await readJson(tradeDeskPath);
    if (meta) {
      meta.textContent = `BTC mark ~ $${d.currentBtcPrice ? Number(d.currentBtcPrice).toLocaleString() : '—'} · ledger realized ${fmtUsd(d.realizedPnlUsd)} · unreal ${fmtUsd(d.unrealizedPnlUsd)} · ${(d.agentTransactions || []).length} agent rows`;
    }
    const openByTid = new Map();
    for (const o of d.openPositions || []) {
      if (o.tradeId) openByTid.set(o.tradeId, o);
    }
    const rows = (d.agentTransactions || []).slice(0, 60);
    tbody.innerHTML = rows
      .map((t) => {
        const tid = t.tradeId || '';
        const sid = t.strategyId;
        const open = openByTid.get(tid);
        let ledger = '—';
        if (open) {
          ledger = `Open · unreal ${fmtUsd(open.unrealizedPnlUsd)}`;
        } else if (t.mode === 'real') {
          const closed = (d.closedPositions || []).find((c) => c.tradeId === tid);
          ledger = closed ? `Closed · ${fmtUsd(closed.realizedPnlUsd)}` : 'Flat (no ledger row)';
        } else {
          ledger = 'Sim';
        }
        const ex = t.execution;
        const accent = strategyRowAccentStyle(sid);
        return `
      <tr class="trade-desk-strat-row" style="${accent}">
        <td>${fmtTime(t.at || t.savedAt)}</td>
        <td><span class="trade-desk-strat-badge">#${sid}</span> ${escapeHtml(t.strategyName || '')}</td>
        <td><code class="trade-desk-tid">${escapeHtml(String(tid).slice(0, 13))}</code></td>
        <td>${escapeHtml(t.mode || '')}</td>
        <td>${ledger}</td>
        <td class="trade-desk-exec-cell">${formatExecTwilightCell(ex)}</td>
        <td class="trade-desk-exec-cell">${formatExecCexCell(ex)}</td>
      </tr>`;
      })
      .join('');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7">No agent trades yet. Run Sim or Real from strategies below.</td></tr>`;
    }

    if (binBody) {
      const bl = d.binanceLive;
      if (bl?.ok && (bl.positions || []).length) {
        binBody.innerHTML = bl.positions
          .map(
            (p) => `
        <tr>
          <td>${escapeHtml(p.symbol || '')}</td>
          <td>${escapeHtml(p.side || '')}</td>
          <td>${p.notional != null ? fmtUsd(p.notional) : '—'}</td>
          <td>${p.unrealizedPnl != null ? fmtUsd(p.unrealizedPnl) : '—'}</td>
          <td>${p.entryPrice != null ? '$' + Number(p.entryPrice).toLocaleString() : '—'}</td>
        </tr>`
          )
          .join('');
      } else {
        binBody.innerHTML = `<tr><td colspan="5">${escapeHtml(
          [bl?.reason || bl?.error || 'No open positions or keys not set', bl?.hint].filter(Boolean).join(' — ')
        )}</td></tr>`;
      }
    }
    if (byBody) {
      const bl = d.bybitLive;
      if (bl?.ok && (bl.positions || []).length) {
        byBody.innerHTML = bl.positions
          .map(
            (p) => `
        <tr>
          <td>${escapeHtml(p.symbol || '')}</td>
          <td>${escapeHtml(p.side || '')}</td>
          <td>${p.notional != null ? fmtUsd(p.notional) : '—'}</td>
          <td>${p.unrealizedPnl != null ? fmtUsd(p.unrealizedPnl) : '—'}</td>
          <td>${p.entryPrice != null ? '$' + Number(p.entryPrice).toLocaleString() : '—'}</td>
        </tr>`
          )
          .join('');
      } else {
        byBody.innerHTML = `<tr><td colspan="5">${escapeHtml(bl?.reason || bl?.error || 'No open positions or keys not set')}</td></tr>`;
      }
    }
    if (twOut) {
      const tw = d.twilightLive;
      if (tw?.ok) {
        twOut.textContent = JSON.stringify(tw.summary ?? {}, null, 2);
      } else {
        twOut.textContent = JSON.stringify(
          { error: tw?.error, stderr: tw?.stderr, stdoutPreview: tw?.stdoutPreview, reason: tw?.reason },
          null,
          2
        );
      }
    }
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    tbody.innerHTML = `<tr><td colspan="7">${escapeHtml(m)}</td></tr>`;
    if (meta) meta.textContent = '';
    if (opts.userAction) showDashboardError(m, 'Trade desk');
  }
}

async function refreshStrategies(opts = {}) {
  const tbody = document.getElementById('strategies-body');
  const meta = document.getElementById('strategies-meta');
  try {
    const data = await readJson('/api/strategies/best?limit=20&profitable=true');
    const rows = data.strategies || [];
    tbody.innerHTML = rows
      .map(
        (s) => `
      <tr>
        <td>${s.id}</td>
        <td>${escapeHtml(s.name || '')}</td>
        <td>${escapeHtml(s.category || '')}</td>
        <td>${escapeHtml(s.risk || '')}</td>
        <td>${s.apy != null ? Number(s.apy).toFixed(1) : '—'}</td>
        <td>${fmtUsd(s.dailyPnL)}</td>
        <td>${escapeHtml(s.twilightPosition || '')} ${s.twilightLeverage ? s.twilightLeverage + 'x' : ''}</td>
        <td class="strategy-actions">
          <button type="button" class="btn small strategy-exec" data-sid="${s.id}" data-mode="simulation">Sim</button>
          <button type="button" class="btn small danger strategy-exec" data-sid="${s.id}" data-mode="real" data-strategy-meta="${encodeStrategyMetaForBtn(s)}">Real</button>
        </td>
      </tr>`
      )
      .join('');
    if (!rows.length) tbody.innerHTML = `<tr><td colspan="8">No strategies returned.</td></tr>`;
    if (meta) {
      meta.textContent = `Updated ${fmtTime(data.timestamp)} · BTC ~ $${data.btcPrice != null ? Number(data.btcPrice).toLocaleString() : '—'} · ${data.count ?? rows.length} rows`;
    }
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    tbody.innerHTML = `<tr><td colspan="8">${escapeHtml(m)}</td></tr>`;
    if (meta) meta.textContent = '';
    if (opts.userAction) showDashboardError(m, 'Best trades');
  }
}

async function refreshJournal(opts = {}) {
  const tbody = document.getElementById('journal-body');
  const sumEl = document.getElementById('journal-summary');
  if (!tbody) return;
  try {
    const j = await readJson('/api/trade-journal');
    const { entries, summary } = j;
    tbody.innerHTML = entries
      .map(
        (e) => `
      <tr>
        <td>${fmtTime(e.at)}</td>
        <td>${escapeHtml(e.label)}</td>
        <td>${escapeHtml(e.venue)}</td>
        <td>${escapeHtml(e.side)}</td>
        <td>${e.pnlUsd != null ? fmtUsd(e.pnlUsd) : '—'}</td>
        <td><button type="button" class="btn small ghost journal-del" data-id="${escapeHtml(e.id)}">Remove</button></td>
      </tr>`
      )
      .join('');
    if (!entries.length) tbody.innerHTML = `<tr><td colspan="6">No journal entries yet.</td></tr>`;
    if (sumEl) {
      sumEl.innerHTML = `
      <dt>Entries</dt><dd>${summary.count}</dd>
      <dt>Sum PnL USD</dt><dd>${fmtUsd(summary.sumPnlUsd)}</dd>
      <dt>Sum fees USD</dt><dd>${fmtUsd(summary.sumFeesUsd)}</dd>
    `;
    }
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    tbody.innerHTML = `<tr><td colspan="6">${escapeHtml(m)}</td></tr>`;
    if (sumEl) sumEl.innerHTML = `<dt>Error</dt><dd>${escapeHtml(m)}</dd>`;
    if (opts.userAction) showDashboardError(m, 'Journal');
  }
}

async function loadAgentSettings(opts = {}) {
  const msg = document.getElementById('agent-settings-msg');
  try {
    const s = await readJson('/api/agent/settings');
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el && v !== undefined && v !== null) el.value = v;
    };
    set('agent-poll', s.pollIntervalMs);
    set('agent-limit', s.strategyFilters?.limit);
    const prof = document.getElementById('agent-profitable');
    if (prof) prof.checked = !!s.strategyFilters?.profitable;
    const mode = document.getElementById('agent-mode');
    if (mode) mode.value = s.execution?.mode || 'simulation';
    set('agent-max-total', s.risk?.maxTotalNotionalUsd);
    set('agent-max-concurrent', s.risk?.maxConcurrentLogicalTrades);
    set('agent-max-daily', s.risk?.maxDailyLossUsd);
    if (msg) {
      msg.textContent = '';
      msg.classList.remove('hint-error');
    }
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    if (opts.userAction) showDashboardError(m, 'Agent settings');
  }
}

document.getElementById('btn-save-agent')?.addEventListener('click', async () => {
  const msg = document.getElementById('agent-settings-msg');
  try {
    await readJson('/api/agent/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pollIntervalMs: Number(document.getElementById('agent-poll')?.value),
        strategyFilters: {
          profitable: document.getElementById('agent-profitable')?.checked,
          limit: Number(document.getElementById('agent-limit')?.value) || 5,
        },
        execution: { mode: document.getElementById('agent-mode')?.value || 'simulation' },
        risk: {
          maxTotalNotionalUsd: Number(document.getElementById('agent-max-total')?.value),
          maxConcurrentLogicalTrades: Number(document.getElementById('agent-max-concurrent')?.value),
          maxDailyLossUsd: Number(document.getElementById('agent-max-daily')?.value),
        },
      }),
    });
    if (msg) {
      msg.textContent = 'Saved.';
      msg.classList.remove('hint-error');
    }
  } catch (e) {
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    showDashboardError(m, 'Save agent settings');
  }
});

document.getElementById('btn-reload-agent')?.addEventListener('click', () =>
  loadAgentSettings({ userAction: true })
);

document.getElementById('sec-strategies')?.addEventListener('click', (ev) => {
  const b = ev.target.closest('.strategy-exec');
  if (!b) return;
  const sid = b.getAttribute('data-sid');
  const mode = b.getAttribute('data-mode');
  if (!sid) return;
  const idNum = Number(sid);
  if (mode === 'real') {
    const metaB64 = b.getAttribute('data-strategy-meta');
    const meta = metaB64 ? decodeStrategyMetaFromBtn(metaB64) : null;
    if (meta) {
      openRealTradeModal(idNum, { ...meta, id: idNum });
      return;
    }
  }
  runStrategyExecute(idNum, mode);
});

document.getElementById('modal-real-trade-dismiss')?.addEventListener('click', closeRealTradeModal);
document.getElementById('modal-real-cancel')?.addEventListener('click', closeRealTradeModal);
document.getElementById('modal-real-trade')?.addEventListener('click', (ev) => {
  if (ev.target.id === 'modal-real-trade') closeRealTradeModal();
});
document.getElementById('modal-real-trade')?.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-preset-pct]');
  if (!b) return;
  setRealTradePresetPercent(Number(b.getAttribute('data-preset-pct')));
});
document.getElementById('modal-real-run')?.addEventListener('click', async () => {
  const st = realTradeModalState;
  if (!st) return;
  const input = document.getElementById('modal-real-total-usd');
  const total = Number(input?.value);
  if (!Number.isFinite(total) || total <= 0) {
    showDashboardWarning('Enter a positive total USD to deploy.', 'Real trade');
    return;
  }
  closeRealTradeModal();
  await runStrategyExecute(st.strategyId, 'real', {
    targetTotalNotionalUsd: total,
    skipRealConfirm: true,
  });
});
document.getElementById('modal-real-fetch-balance')?.addEventListener('click', async () => {
  const pre = document.getElementById('modal-real-balance-out');
  const creds = manageWalletCreds();
  if (!creds.walletId) {
    showDashboardWarning('Select a wallet in Twilight wallet (step 1) before loading balance.', 'Real trade');
    return;
  }
  if (pre) {
    pre.hidden = false;
    pre.textContent = 'Loading…';
  }
  try {
    const r = await readJson('/api/relayer/wallet/balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (pre) pre.textContent = r.stdout || r.stderr || JSON.stringify(r, null, 2);
  } catch (e) {
    if (pre) pre.textContent = errMsg(e);
  }
});

document.addEventListener('keydown', (ev) => {
  const modal = document.getElementById('modal-real-trade');
  if (ev.key !== 'Escape' || !modal || modal.hidden) return;
  closeRealTradeModal();
});

document.getElementById('positions-open-body')?.addEventListener('click', async (ev) => {
  const b = ev.target.closest('.pos-close-btn');
  if (!b) return;
  const tid = b.getAttribute('data-tid');
  const tr = b.closest('tr');
  const inp = tr?.querySelector('.pos-close-amt');
  const raw = inp?.value?.trim();
  if (raw === '' || raw == null) {
    showDashboardWarning('Enter realized P&L in USD before closing.', 'Close position');
    return;
  }
  const num = Number(raw);
  if (Number.isNaN(num)) {
    showDashboardWarning('Invalid number for realized P&L.', 'Close position');
    return;
  }
  try {
    await readJson(`/api/positions/${encodeURIComponent(tid)}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realizedPnlUsd: num }),
    });
    await refreshPnl({ userAction: true });
  } catch (e) {
    showDashboardError(errMsg(e), 'Close position');
  }
});

document.getElementById('btn-pnl-refresh')?.addEventListener('click', () => refreshPnl({ userAction: true }));

function envStatusBadge(row) {
  if (!row.hasValue) {
    return '<span class="env-status-badge env-status-missing" title="No value in .env for this key">Not set</span>';
  }
  if (row.masked) {
    return `<span class="env-status-badge env-status-saved" title="Value is stored; leave blank on save to keep">${escapeHtml(row.hint || 'saved')}</span>`;
  }
  return '<span class="env-status-badge env-status-set" title="Value is present in .env">Set</span>';
}

function renderPresetKvTable(obj) {
  const keys = Object.keys(obj || {}).sort();
  if (!keys.length) return '<p class="muted small">(no keys)</p>';
  let t =
    '<table class="env-preset-table"><thead><tr><th>Variable</th><th>Value</th></tr></thead><tbody>';
  for (const k of keys) {
    t += `<tr><td><code>${escapeHtml(k)}</code></td><td><code>${escapeHtml(String(obj[k]))}</code></td></tr>`;
  }
  t += '</tbody></table>';
  return t;
}

function syncZkosTwilightIndexField() {
  const z = document.getElementById('zkos-strategy-index');
  const envEl = document.getElementById('env-TWILIGHT_ACCOUNT_INDEX');
  if (z && envEl) z.value = envEl.value;
}

async function refreshEnv() {
  const root = document.getElementById('env-form-root');
  const pathHint = document.getElementById('env-path-hint');
  const msg = document.getElementById('env-msg');
  if (!root) return;
  try {
    const data = await readJson('/api/env');
    window.__envRows = data.entries || [];
    if (pathHint) {
      pathHint.textContent = `${data.envPath || ''}${data.relayerGuess ? ` · relayer-cli: ${data.relayerGuess}` : ''}`;
    }
    if (msg) {
      msg.textContent = '';
      msg.classList.remove('hint-error');
    }
    const st = data.stats || {};
    const unsetKeys = st.unsetKeys || [];
    const unsetPreview =
      unsetKeys.length === 0
        ? '<span class="muted">none</span>'
        : unsetKeys.length <= 14
          ? unsetKeys.map((k) => escapeHtml(k)).join(', ')
          : `${unsetKeys
              .slice(0, 14)
              .map((k) => escapeHtml(k))
              .join(', ')} <span class="muted">…and ${unsetKeys.length - 14} more</span>`;
    const summaryLine =
      st.total != null
        ? `<div class="env-summary-bar"><p class="env-summary-line"><strong>${st.set ?? 0}</strong> of <strong>${st.total}</strong> listed variables have a value in <code>.env</code>. <strong>${st.unset ?? unsetKeys.length}</strong> still empty: ${unsetPreview}</p></div>`
        : '';
    const pm = data.presetMeta || {};
    const src = pm.sourceBlurb ? `<p class="muted small env-preset-source">${escapeHtml(pm.sourceBlurb)}</p>` : '';
    const testnetNote = pm.notes?.testnet
      ? `<p class="small env-preset-note">${escapeHtml(pm.notes.testnet)}</p>`
      : '';
    const mainnetNote = pm.notes?.mainnet
      ? `<p class="small env-preset-note">${escapeHtml(pm.notes.mainnet)}</p>`
      : '';
    const mainnetFaucet = pm.mainnetFaucetBehavior
      ? `<p class="small env-preset-note">${escapeHtml(pm.mainnetFaucetBehavior)}</p>`
      : '';
    const pv = pm.values || {};
    const presetBlock = `<details class="env-presets-details"><summary>What "testnet" and "mainnet" presets change (exact keys and values)</summary>${src}<div class="env-preset-columns"><div class="env-preset-col"><h4 class="subhead small">Testnet preset</h4>${testnetNote}${renderPresetKvTable(pv.testnet)}</div><div class="env-preset-col"><h4 class="subhead small">Mainnet preset</h4>${mainnetNote}${mainnetFaucet}${renderPresetKvTable(pv.mainnet)}</div></div><p class="hint small">Optional: the confirm dialog when applying a preset can also write the public <strong>example</strong> <code>STRATEGY_API_KEY</code> from the skill docs (for demos — use your own key in production).</p></details>`;

    const groups = data.groups || [];
    const byGroup = {};
    for (const e of data.entries || []) {
      byGroup[e.group] = byGroup[e.group] || [];
      byGroup[e.group].push(e);
    }
    let html = summaryLine + presetBlock;
    for (const g of groups) {
      const rows = byGroup[g.id] || [];
      if (!rows.length) continue;
      const unsetInGroup = rows.filter((r) => !r.hasValue).length;
      const meta =
        unsetInGroup > 0
          ? `${rows.length} fields · ${unsetInGroup} not set`
          : `${rows.length} fields · all set`;
      html += `<details class="env-group-details"><summary class="env-group-summary"><span class="env-group-summary-title">${escapeHtml(g.title)}</span><span class="env-group-summary-meta muted small">${escapeHtml(meta)}</span></summary><p class="muted env-group-desc">${escapeHtml(g.help || '')}</p><div class="field-grid">`;
      for (const row of rows) {
        if (row.hideFromEnvForm) continue;
        const id = `env-${row.key}`;
        const rowCls = row.hasValue ? 'env-field-row env-row-has-value' : 'env-field-row env-row-missing';
        const ph =
          row.masked && row.hasValue ? `Leave blank to keep ${row.hint || 'saved'}` : '';
        const badge = envStatusBadge(row);
        if (row.type === 'select' && row.options) {
          html += `<div class="${rowCls}"><label class="field wide env-field-inner"><span>${escapeHtml(row.label)} <code>${escapeHtml(row.key)}</code> ${badge}</span><select id="${id}">`;
          html += `<option value=""${!row.value ? ' selected' : ''}>— not set —</option>`;
          for (const opt of row.options) {
            const sel = String(row.value) === String(opt) ? ' selected' : '';
            html += `<option value="${escapeHtml(opt)}"${sel}>${escapeHtml(opt)}</option>`;
          }
          html += `</select></label>`;
        } else {
          const inpType = row.secret || row.type === 'password' ? 'password' : 'text';
          html += `<div class="${rowCls}"><label class="field wide env-field-inner"><span>${escapeHtml(row.label)} <code>${escapeHtml(row.key)}</code> ${badge}</span><input type="${inpType}" id="${id}" autocomplete="off" placeholder="${escapeHtml(ph)}" value="${escapeHtml(row.value)}" /></label>`;
        }
        if (row.help) {
          html += `<p class="hint env-field-hint">${escapeHtml(row.help)}</p>`;
        }
        html += '</div>';
      }
      html += '</div></details>';
    }
    if (data.unknownKeys?.length) {
      html += `<p class="hint">Other keys in <code>.env</code> (not in the form above): <code>${data.unknownKeys.map(escapeHtml).join(', ')}</code></p>`;
    }
    root.innerHTML = html || '<p class="muted">No fields.</p>';
    syncConfirmRealTradingToggle(data.entries || []);
    syncZkosAllowToggle(data.entries || []);
    syncZkosTwilightIndexField();
  } catch (e) {
    if (isLikelyNetworkFailure(e)) return;
    const m = errMsg(e);
    root.innerHTML = `<p class="hint hint-error">${escapeHtml(m)}</p>`;
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
  }
}

function collectEnvUpdates() {
  const updates = {};
  const rows = window.__envRows || [];
  const root = document.getElementById('env-form-root');
  if (!root) return updates;
  root.querySelectorAll('[id^="env-"]').forEach((el) => {
    const key = el.id.replace(/^env-/, '');
    const v = el.value.trim();
    const row = rows.find((r) => r.key === key);
    if (row?.secret && row.hasValue && !v) return;
    if (row?.secret && !row.hasValue && !v) return;
    updates[key] = v;
  });
  return updates;
}

async function refreshEnvRawIfVisible() {
  const panel = document.getElementById('env-raw-panel');
  const pre = document.getElementById('env-raw-content');
  if (!panel || !pre || panel.hidden) return;
  try {
    const data = await readJson('/api/env/raw');
    pre.textContent = data.exists
      ? data.content
      : '(No file yet — save the form above to create .env.)';
  } catch (e) {
    if (isLikelyNetworkFailure(e)) return;
    const m = errMsg(e);
    pre.textContent = m;
  }
}

document.getElementById('btn-env-save')?.addEventListener('click', async () => {
  const msg = document.getElementById('env-msg');
  try {
    await readJson('/api/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: collectEnvUpdates() }),
    });
    if (msg) {
      msg.textContent = 'Saved. Environment reloaded for this process.';
      msg.classList.remove('hint-error');
    }
    await refreshEnv();
    await refreshEnvRawIfVisible();
    await refreshWalletList();
    loadRelayerMetaHints();
    await refreshStrategies();
  } catch (e) {
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    showDashboardError(m, 'Save .env');
  }
});

document.getElementById('btn-env-reload')?.addEventListener('click', async () => {
  const msg = document.getElementById('env-msg');
  try {
    await readJson('/api/env/reload', { method: 'POST' });
    if (msg) {
      msg.textContent = 'Reloaded from disk.';
      msg.classList.remove('hint-error');
    }
    await refreshEnv();
    await refreshEnvRawIfVisible();
  } catch (e) {
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    showDashboardError(m, 'Reload .env');
  }
});

document.getElementById('btn-env-view-raw')?.addEventListener('click', async () => {
  const panel = document.getElementById('env-raw-panel');
  const pre = document.getElementById('env-raw-content');
  const btn = document.getElementById('btn-env-view-raw');
  if (!panel || !pre || !btn) return;
  if (!panel.hidden) {
    panel.hidden = true;
    btn.textContent = 'View raw .env';
    return;
  }
  pre.textContent = 'Loading…';
  panel.hidden = false;
  btn.textContent = 'Hide raw .env';
  try {
    const data = await readJson('/api/env/raw');
    pre.textContent = data.exists
      ? data.content
      : '(No file yet — save the form above to create .env.)';
  } catch (e) {
    const m = errMsg(e);
    pre.textContent = m;
    showDashboardError(m, 'View raw .env');
  }
});

document.getElementById('btn-env-preset-testnet')?.addEventListener('click', async () => {
  const msg = document.getElementById('env-msg');
  const ex = confirm(
    'Apply Twilight testnet URLs (LCD, RPC, ZkOS, relayer, faucet) from the skill docs?\n\nOK = also set the public example Strategy API key (for demos only). Cancel = endpoints only.'
  );
  try {
    await readJson('/api/env/apply-preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'testnet', applyExampleStrategyKey: ex }),
    });
    if (msg) {
      msg.textContent = 'Testnet preset applied.';
      msg.classList.remove('hint-error');
    }
    await refreshEnv();
    await refreshEnvRawIfVisible();
    await refreshWalletList();
    loadRelayerMetaHints();
  } catch (e) {
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    showDashboardError(m, 'Testnet preset');
  }
});

document.getElementById('btn-env-preset-mainnet')?.addEventListener('click', async () => {
  const msg = document.getElementById('env-msg');
  const ex = confirm(
    'Apply Twilight mainnet URLs from the skill docs?\n\nOK = also set the public example Strategy API key. Cancel = endpoints only.'
  );
  try {
    await readJson('/api/env/apply-preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'mainnet', applyExampleStrategyKey: ex }),
    });
    if (msg) {
      msg.textContent = 'Mainnet preset applied.';
      msg.classList.remove('hint-error');
    }
    await refreshEnv();
    await refreshEnvRawIfVisible();
    await refreshWalletList();
    loadRelayerMetaHints();
  } catch (e) {
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    showDashboardError(m, 'Mainnet preset');
  }
});

document.getElementById('btn-env-example-key')?.addEventListener('click', async () => {
  const msg = document.getElementById('env-msg');
  try {
    await readJson('/api/env/apply-example-strategy-key', { method: 'POST' });
    if (msg) {
      msg.textContent = 'Example Strategy API key written (skill docs sample).';
      msg.classList.remove('hint-error');
    }
    await refreshEnv();
    await refreshEnvRawIfVisible();
  } catch (e) {
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    showDashboardError(m, 'Example Strategy API key');
  }
});

async function loadExchangeStatus(opts = {}) {
  const el = document.getElementById('exchange-status');
  if (!el) return;
  try {
    const m = await readJson('/api/venue-api-keys');
    const bk = document.getElementById('binance-testnet');
    const bt = document.getElementById('bybit-testnet');
    if (bk) bk.checked = !!m.binance?.useTestnet;
    if (bt) bt.checked = !!m.bybit?.useTestnet;
    el.textContent = `Binance: ${m.binance?.configured ? 'saved (' + (m.binance.apiKeySuffix || 'key') + ')' : 'not set'} · Bybit: ${m.bybit?.configured ? 'saved (' + (m.bybit.apiKeySuffix || 'key') + ')' : 'not set'}`;
    el.classList.remove('hint-error');
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    el.textContent = m;
    el.classList.add('hint-error');
    if (opts.userAction) showDashboardError(m, 'CEX keys status');
  }
}

document.getElementById('btn-save-token')?.addEventListener('click', () => {
  const v = document.getElementById('dash-token').value.trim();
  if (v) localStorage.setItem('dashboardToken', v);
  else localStorage.removeItem('dashboardToken');
  refreshStatus({ userAction: true });
  refreshWalletList();
  refreshEnv();
});

document.getElementById('wallet-select')?.addEventListener('change', (ev) => {
  const v = ev.target.value;
  if (v) localStorage.setItem(WALLET_STORAGE_KEY, v);
  else localStorage.removeItem(WALLET_STORAGE_KEY);
  for (const id of PANEL_WALLET_SELECT_IDS) {
    const panelSel = document.getElementById(id);
    if (panelSel && [...panelSel.options].some((o) => o.value === v)) {
      panelSel.value = v;
    }
  }
  refreshZkosBalance();
});

document.getElementById('wallet-pass')?.addEventListener('change', () => refreshZkosBalance());

document.getElementById('btn-wallet-refresh')?.addEventListener('click', () =>
  refreshWalletList(null, { userAction: true })
);

document.getElementById('btn-faucet')?.addEventListener('click', async () => {
  const out = document.getElementById('faucet-out');
  const summary = document.getElementById('faucet-result-summary');
  const creds = faucetWalletCreds();
  if (!creds.walletId) {
    showDashboardWarning('Select a wallet for the faucet (dropdown or Twilight wallet step 1).', 'Faucet');
    return;
  }
  out.hidden = false;
  if (summary) summary.hidden = true;
  out.textContent = 'Calling wallet balance, then POST /faucet (NYKS)…';
  try {
    const r = await readJson('/api/relayer/wallet/faucet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...creds,
        mintTestSats: document.getElementById('chk-faucet-sats')?.checked === true,
      }),
    });
    renderFaucetResponse(r);
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    if (summary) summary.hidden = true;
    showDashboardError(m, 'Faucet');
  }
});

document.getElementById('chk-faucet-sats')?.addEventListener('change', () => updateFaucetMintUiHints());

document.getElementById('btn-faucet-cli')?.addEventListener('click', async () => {
  const out = document.getElementById('faucet-out');
  const summary = document.getElementById('faucet-result-summary');
  const postMint = document.getElementById('faucet-post-mint-hint');
  const creds = faucetWalletCreds();
  if (!creds.walletId) {
    showDashboardWarning('Select a wallet for the faucet (dropdown or Twilight wallet step 1).', 'Faucet');
    return;
  }
  if (out) {
    out.hidden = false;
    out.textContent = 'Running relayer-cli wallet faucet (testnet SDK get_test_tokens)…';
  }
  if (summary) summary.hidden = true;
  if (postMint) {
    postMint.hidden = true;
    postMint.textContent = '';
  }
  try {
    const r = await readJson('/api/relayer/wallet/faucet-cli', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (out) out.textContent = JSON.stringify(r, null, 2);
    if (r.ok) {
      showSectionAlert(
        'success',
        'CLI faucet finished. Refresh ZkOS / Manage balance — SATS should reflect update_balance() from the SDK.',
        'Faucet'
      );
      await refreshZkosBalance();
    }
  } catch (e) {
    const m = errMsg(e);
    if (out) out.textContent = m;
    showDashboardError(m, 'Faucet');
  }
});

document.getElementById('btn-manage-balance')?.addEventListener('click', () =>
  managePostWithCreds('/api/relayer/wallet/balance')
);
document.getElementById('btn-manage-accounts')?.addEventListener('click', () =>
  managePostWithCreds('/api/relayer/wallet/accounts', {
    onChainOnly: document.getElementById('relayer-onchain-only')?.checked,
  })
);
document.getElementById('btn-manage-info')?.addEventListener('click', () =>
  managePostWithCreds('/api/relayer/wallet/info')
);
document.getElementById('btn-manage-unlock')?.addEventListener('click', () =>
  managePostWithCreds('/api/relayer/wallet/unlock')
);
document.getElementById('btn-manage-lock')?.addEventListener('click', () =>
  managePost('/api/relayer/wallet/lock', {})
);
document.getElementById('btn-manage-sync-nonce')?.addEventListener('click', () =>
  managePostWithCreds('/api/relayer/wallet/sync-nonce')
);

document.getElementById('btn-zkos-accounts')?.addEventListener('click', () =>
  zkosPostWithCreds('/api/relayer/wallet/accounts', {})
);
document.getElementById('btn-zkos-fund')?.addEventListener('click', () => {
  const amount = document.getElementById('zkos-fund-sats')?.value?.trim();
  if (!amount) {
    showDashboardWarning('Enter an amount in sats to fund.', 'ZkOS');
    return;
  }
  zkosPostWithCreds('/api/relayer/zkaccount/fund', { amount });
});
document.getElementById('btn-zkos-transfer')?.addEventListener('click', () => {
  const from = document.getElementById('zkos-rotate-from')?.value?.trim();
  if (from === '' || from == null) {
    showDashboardWarning('Enter the account index to rotate from.', 'ZkOS');
    return;
  }
  zkosPostWithCreds('/api/relayer/zkaccount/transfer', { from });
});
document.getElementById('btn-zkos-refresh-balance')?.addEventListener('click', () =>
  refreshZkosBalance({ userAction: true })
);
document.getElementById('zkos-fund-pct')?.addEventListener('input', (ev) => {
  setZkosFundFromPct(ev.target.value);
});
document.getElementById('zkos-fund-sats')?.addEventListener('input', () => syncZkosPctFromFundInput());

document.getElementById('btn-zkos-save-index')?.addEventListener('click', async () => {
  const v = document.getElementById('zkos-strategy-index')?.value?.trim() ?? '';
  const out = document.getElementById('zkos-out');
  try {
    await readJson('/api/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: { TWILIGHT_ACCOUNT_INDEX: v } }),
    });
    await readJson('/api/env/reload', { method: 'POST' });
    await refreshEnv();
    if (out) {
      out.textContent = `Saved TWILIGHT_ACCOUNT_INDEX=${v || '(empty)'}. Reloaded env.`;
    }
    showDashboardSuccess(`TWILIGHT_ACCOUNT_INDEX saved as ${v || '(empty)'}.`, 'ZkOS');
  } catch (e) {
    const m = errMsg(e);
    if (out) out.textContent = m;
    showDashboardError(m, 'ZkOS');
  }
});

document.getElementById('btn-relayer-create')?.addEventListener('click', async () => {
  const out = document.getElementById('wallet-create-out');
  const walletId = document.getElementById('relayer-create-id').value.trim();
  const password = document.getElementById('relayer-create-pass').value;
  const btcAddress = document.getElementById('relayer-create-btc').value.trim();
  out.hidden = false;
  out.textContent = 'Running…';
  try {
    const body = { walletId, password };
    if (btcAddress) body.btcAddress = btcAddress;
    const r = await readJson('/api/relayer/wallet/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    out.textContent = JSON.stringify(r, null, 2);
    await refreshWalletList(walletId, { userAction: true });
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    showDashboardError(m, 'Create wallet');
  }
});

document.getElementById('btn-save-exchange')?.addEventListener('click', async () => {
  const el = document.getElementById('exchange-status');
  try {
    const r = await readJson('/api/venue-api-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        binance: {
          apiKey: document.getElementById('binance-api-key').value,
          apiSecret: document.getElementById('binance-api-secret').value,
          useTestnet: document.getElementById('binance-testnet').checked,
        },
        bybit: {
          apiKey: document.getElementById('bybit-api-key').value,
          apiSecret: document.getElementById('bybit-api-secret').value,
          useTestnet: document.getElementById('bybit-testnet').checked,
        },
      }),
    });
    el.textContent = `Saved. Binance: ${r.binance?.configured ? 'on' : 'off'} · Bybit: ${r.bybit?.configured ? 'on' : 'off'}`;
    document.getElementById('binance-api-key').value = '';
    document.getElementById('binance-api-secret').value = '';
    document.getElementById('bybit-api-key').value = '';
    document.getElementById('bybit-api-secret').value = '';
    await loadExchangeStatus();
  } catch (e) {
    const m = errMsg(e);
    el.textContent = m;
    el.classList.add('hint-error');
    showDashboardError(m, 'Save CEX keys');
  }
});

document.getElementById('btn-reload-exchange')?.addEventListener('click', () =>
  loadExchangeStatus({ userAction: true })
);

document.getElementById('btn-strategies-refresh')?.addEventListener('click', () =>
  refreshStrategies({ userAction: true })
);

document.getElementById('btn-trade-desk-refresh')?.addEventListener('click', () =>
  refreshTradeDesk({ userAction: true })
);

document.getElementById('btn-journal-refresh')?.addEventListener('click', () =>
  refreshJournal({ userAction: true })
);
document.getElementById('btn-journal-add')?.addEventListener('click', async () => {
  try {
    await readJson('/api/trade-journal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: document.getElementById('journal-label').value,
        venue: document.getElementById('journal-venue').value,
        side: document.getElementById('journal-side').value,
        notionalUsd: document.getElementById('journal-notional').value,
        pnlUsd: document.getElementById('journal-pnl').value,
        feesUsd: document.getElementById('journal-fees').value,
        note: document.getElementById('journal-note').value,
        walletId: document.getElementById('wallet-select').value || null,
      }),
    });
    document.getElementById('journal-label').value = '';
    document.getElementById('journal-notional').value = '';
    document.getElementById('journal-pnl').value = '';
    document.getElementById('journal-fees').value = '';
    document.getElementById('journal-note').value = '';
    await refreshJournal();
  } catch (e) {
    showDashboardError(errMsg(e), 'Add journal entry');
  }
});

document.getElementById('journal-body')?.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.journal-del');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (!id || !confirm('Remove this journal entry?')) return;
  try {
    await readJson(`/api/trade-journal/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await refreshJournal();
  } catch (e) {
    showDashboardError(errMsg(e), 'Remove journal entry');
  }
});

document.getElementById('btn-start')?.addEventListener('click', async () => {
  try {
    await readJson('/api/monitor/start', { method: 'POST' });
    await refreshStatus({ userAction: true });
  } catch (e) {
    showDashboardError(errMsg(e), 'Start monitor');
  }
});

document.getElementById('btn-stop')?.addEventListener('click', async () => {
  try {
    await readJson('/api/monitor/stop', { method: 'POST' });
    await refreshStatus({ userAction: true });
  } catch (e) {
    showDashboardError(errMsg(e), 'Stop monitor');
  }
});

document.getElementById('btn-sim-once')?.addEventListener('click', async () => {
  const out = document.getElementById('sim-out');
  if (!out) return;
  out.textContent = 'Running…';
  try {
    const r = await readJson('/api/simulation/run-once', { method: 'POST' });
    out.textContent = JSON.stringify(r, null, 2);
    await refreshPnl({ userAction: true });
    await refreshTx({ userAction: true });
    await refreshTradeDesk({ userAction: true });
    await refreshStatus({ userAction: true });
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    showDashboardError(m, 'Simulation run');
  }
});

document.getElementById('btn-save-config')?.addEventListener('click', async () => {
  const msg = document.getElementById('config-msg');
  const content = document.getElementById('config-yaml').value;
  try {
    await readJson('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (msg) {
      msg.textContent = 'Saved.';
      msg.classList.remove('hint-error');
    }
  } catch (e) {
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    showDashboardError(m, 'Save agent config YAML');
  }
});

document.getElementById('btn-reload-config')?.addEventListener('click', () => loadConfig({ userAction: true }));
document.getElementById('btn-refresh-tx')?.addEventListener('click', () => refreshTx({ userAction: true }));
document.getElementById('btn-refresh-logs')?.addEventListener('click', () => refreshLogs({ userAction: true }));

document.getElementById('btn-reset-portfolio')?.addEventListener('click', async () => {
  if (!confirm('Clear in-memory portfolio snapshot? Transaction history file is unchanged.')) return;
  try {
    await readJson('/api/portfolio/reset', { method: 'POST' });
    await refreshPnl({ userAction: true });
    await refreshStatus({ userAction: true });
  } catch (e) {
    showDashboardError(errMsg(e), 'Reset portfolio');
  }
});

async function loadRelayerMeta(opts = {}) {
  const hint = document.getElementById('relayer-binary-hint');
  const gate = document.getElementById('relayer-gate-hint');
  const line = document.getElementById('relayer-meta-line');
  if (!hint) return;
  try {
    const m = await readJson('/api/relayer/meta');
    hint.textContent = `Binary: ${m.binary} · repo: ${m.repoRoot} · Zk: ${m.zkAllowEnv ? 'on' : 'off'} · orders: ${m.ordersAllowEnv ? 'on' : 'off'}`;
    hint.classList.remove('hint-error');
    if (gate) gate.style.color = m.zkAllowEnv && m.ordersAllowEnv ? 'var(--ok)' : '';
    if (line) {
      line.textContent =
        'Uses relayer-cli with repo .env. Optional NYKS_WALLET_ID / NYKS_WALLET_PASSPHRASE; session wallet above overrides.';
    }
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    hint.textContent = m;
    hint.classList.add('hint-error');
    if (opts.userAction) showDashboardError(m, 'Relayer meta');
  }
}

document.getElementById('btn-relayer-meta')?.addEventListener('click', () =>
  loadRelayerMeta({ userAction: true })
);

document.getElementById('btn-relayer-ping')?.addEventListener('click', () => relayerPost('/api/relayer/ping'));
document.getElementById('btn-relayer-mstats')?.addEventListener('click', () =>
  relayerPost('/api/relayer/market/market-stats')
);

document.getElementById('btn-relayer-fund')?.addEventListener('click', () => {
  const amount = document.getElementById('relayer-fund-sats').value.trim();
  relayerPost('/api/relayer/zkaccount/fund', { amount, ...walletSession() });
});

document.getElementById('btn-relayer-transfer')?.addEventListener('click', () => {
  const from = document.getElementById('relayer-zk-from').value.trim();
  relayerPost('/api/relayer/zkaccount/transfer', { from, ...walletSession() });
});

document.getElementById('btn-relayer-open')?.addEventListener('click', () => {
  relayerPost('/api/relayer/order/open-trade', {
    accountIndex: document.getElementById('relayer-ot-acc').value.trim(),
    side: document.getElementById('relayer-ot-side').value,
    entryPrice: document.getElementById('relayer-ot-price').value.trim(),
    leverage: document.getElementById('relayer-ot-lev').value.trim(),
    orderType: 'MARKET',
    noWait: document.getElementById('relayer-ot-nowait').checked,
  });
});

document.getElementById('btn-relayer-close')?.addEventListener('click', () => {
  relayerPost('/api/relayer/order/close-trade', {
    accountIndex: document.getElementById('relayer-close-acc').value.trim(),
    noWait: document.getElementById('relayer-close-nowait').checked,
  });
});

document.getElementById('btn-relayer-cancel')?.addEventListener('click', () => {
  relayerPost('/api/relayer/order/cancel-trade', {
    accountIndex: document.getElementById('relayer-close-acc').value.trim(),
  });
});

document.getElementById('btn-relayer-import')?.addEventListener('click', () => {
  const mnemonic = document.getElementById('relayer-import-mnemonic').value.trim();
  relayerPost('/api/relayer/wallet/import', { ...walletSession(), mnemonic });
});

const tok = localStorage.getItem('dashboardToken');
const dashTokEl = document.getElementById('dash-token');
if (tok && dashTokEl) dashTokEl.value = tok;

refreshWalletList();
loadRelayerMetaHints();
loadExchangeStatus();
refreshJournal();
refreshStrategies();
refreshTradeDesk();
loadRelayerMeta();
refreshEnv();
loadAgentSettings();
refreshStatus();
refreshPnl();
refreshTx();
refreshLogs();
loadConfig();

setInterval(refreshStatus, 4000);

let strategiesTimer = null;
function syncStrategiesTimer() {
  if (strategiesTimer) clearInterval(strategiesTimer);
  strategiesTimer = null;
  if (document.getElementById('chk-strategies-auto')?.checked) {
    strategiesTimer = setInterval(refreshStrategies, 15000);
  }
}
document.getElementById('chk-strategies-auto')?.addEventListener('change', syncStrategiesTimer);
syncStrategiesTimer();

let tradeDeskTimer = null;
function syncTradeDeskTimer() {
  if (tradeDeskTimer) clearInterval(tradeDeskTimer);
  tradeDeskTimer = null;
  if (document.getElementById('chk-trade-desk-auto')?.checked) {
    tradeDeskTimer = setInterval(refreshTradeDesk, 20000);
  }
}
document.getElementById('chk-trade-desk-auto')?.addEventListener('change', syncTradeDeskTimer);
syncTradeDeskTimer();

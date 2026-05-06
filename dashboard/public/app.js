const WALLET_STORAGE_KEY = 'selectedTwilightWalletId';
const WALLET_SESSION_STORAGE_KEY = 'twilightWalletSessionV1';
const WALLET_SESSION_MODE_STORAGE_KEY = 'twilightWalletSessionModeV1';
const SECTION_COLLAPSE_STORAGE_KEY = 'dashboardCollapsedSectionsV1';
const DESK_TAB_STORAGE_KEY = 'dashboardDeskTabV1';
const STRATEGIES_CEX_FILTER_STORAGE_KEY = 'strategiesCexFilterV1';

/** Last successful `/api/strategies/best` payload; CEX checkboxes filter client-side without refetch. */
let strategiesListCache = null;

/** Set by /api/relayer/wallet/balance-sats for ZkOS fund slider. */
let zkosSpendableSats = null;

/** Last successful `/api/relayer/meta` payload (faucet / network hints). */
let relayerMetaCache = null;
/** Last faucet HTTP recipient address from `/api/relayer/wallet/faucet`. */
let lastFaucetRecipientAddress = '';
/** Last faucet tx hashes captured from response. */
let lastFaucetNyksTxHash = '';
let lastFaucetMintTxHash = '';
/** Best-effort UI gate for enabling Real strategy runs. */
let zkosAccountAvailability = {
  checked: false,
  canRunReal: false,
  accountCount: 0,
  reason: 'Checking ZkOS accounts…',
};

/** Rows from last `wallet accounts` (table or JSON); drives ZkOS account dropdown. */
let zkosAccountsListCache = [];

/** Last `/api/pnl` open rows — used for click-to-detail modal. */
let lastOpenPositions = [];

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

/**
 * Relayer envelopes `{ ok, code, stdout, stderr, … }` often have wide, multi-line `stdout` (ASCII tables).
 * `JSON.stringify` puts that in a single JSON string line, which does not wrap well in a narrow preview
 * / iframe — the middle looks missing. Show JSON without those fields, then raw blocks.
 * @param {unknown} r
 */
function formatRelayerEnvelopeForPre(r) {
  if (r == null || typeof r !== 'object') return JSON.stringify(r, null, 2);
  const hasStdout = Object.prototype.hasOwnProperty.call(r, 'stdout');
  const hasStderr = Object.prototype.hasOwnProperty.call(r, 'stderr');
  if (!hasStdout && !hasStderr) return JSON.stringify(r, null, 2);
  const meta = { ...r };
  const stdout = meta.stdout;
  const stderr = meta.stderr;
  delete meta.stdout;
  delete meta.stderr;
  return `${JSON.stringify(meta, null, 2)}\n\n──────── stdout ────────\n${String(stdout ?? '')}\n\n──────── stderr ────────\n${String(stderr ?? '')}`;
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

async function copyTextToClipboard(text) {
  const s = String(text ?? '');
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(s);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = s;
  ta.setAttribute('readonly', 'true');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.left = '-1000px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function initCopyButtons() {
  const pres = document.querySelectorAll(
    'pre.out[id], pre.log[id], pre.env-raw-pre[id], pre.relayer-out[id], pre.modal-dashboard-result-body[id]'
  );
  for (const pre of pres) {
    if (!pre?.id) continue;
    if (pre.dataset.copyBtnAttached === '1') continue;
    pre.dataset.copyBtnAttached = '1';

    const row = document.createElement('div');
    row.className = 'copy-row';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small ghost copy-btn';
    btn.textContent = 'Copy';
    btn.dataset.copyTargetId = pre.id;
    btn.addEventListener('click', async () => {
      try {
        const target = document.getElementById(btn.dataset.copyTargetId);
        await copyTextToClipboard(target?.textContent ?? '');
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = prev;
        }, 900);
      } catch (e) {
        showDashboardError(errMsg(e), 'Copy');
      }
    });

    row.appendChild(btn);
    pre.insertAdjacentElement('beforebegin', row);
  }
}

function initHelpTips() {
  for (const el of document.querySelectorAll('.help-tip[title]')) {
    const title = el.getAttribute('title') || '';
    if (!title) continue;
    el.setAttribute('data-tip', title);
    el.setAttribute('aria-label', title);
    el.setAttribute('tabindex', '0');
  }
}

/** Maps `context` passed to showDashboardError / showDashboardWarning to a section id for in-place alerts. */
const SECTION_BY_CONTEXT = {
  'Strategy run': 'sec-strategies',
  'Strategy run skipped': 'sec-strategies',
  'Real trade': 'sec-strategies',
  'Real trading toggle': 'sec-wallet',
  'Twilight network switch': 'sec-wallet',
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
  'Test CEX key': 'sec-keys',
  'Faucet': 'sec-faucet',
  'Faucet tx status': 'sec-faucet',
  'Create wallet': 'sec-wallet',
  'Save CEX keys': 'sec-keys',
  'Start monitor': 'sec-agent',
  'Stop monitor': 'sec-agent',
  'Run one cycle': 'sec-agent',
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

  if (sectionId === 'sec-agent' || sectionId === 'sec-advanced') {
    const autoPanel = document.getElementById('desk-panel-automated');
    if (autoPanel?.hasAttribute('hidden')) {
      document.getElementById('tab-desk-automated')?.click();
    }
  }

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

/** After section alert / toast, modal OK dismiss (Escape / overlay click also close). */
function closeDashboardResultModal() {
  const overlay = document.getElementById('modal-dashboard-result');
  if (!overlay) return;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
}

function dashboardResultModalOnKeydown(ev) {
  if (ev.key !== 'Escape') return;
  const overlay = document.getElementById('modal-dashboard-result');
  if (!overlay || overlay.hidden) return;
  ev.preventDefault();
  closeDashboardResultModal();
}

function openDashboardResultModal(variant, context, message) {
  const overlay = document.getElementById('modal-dashboard-result');
  const titleEl = document.getElementById('modal-dashboard-result-title');
  const subEl = document.getElementById('modal-dashboard-result-sub');
  const bodyEl = document.getElementById('modal-dashboard-result-body');
  const dialog = document.getElementById('modal-dashboard-result-dialog');
  if (!overlay || !titleEl || !bodyEl || !dialog) return;

  const ctx = String(context || '').trim();
  const variantTitle =
    variant === 'error' ? 'Error' : variant === 'success' ? 'Success' : 'Notice';
  titleEl.textContent = variantTitle;
  if (subEl) {
    subEl.textContent = ctx || '';
    subEl.style.display = ctx ? 'block' : 'none';
  }

  bodyEl.textContent = String(message || '').trim() || (variant === 'error' ? 'Unknown error' : '');

  dialog.classList.remove('modal-result--error', 'modal-result--warn', 'modal-result--success');
  dialog.classList.add(
    variant === 'error' ? 'modal-result--error' : variant === 'success' ? 'modal-result--success' : 'modal-result--warn'
  );

  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    document.getElementById('modal-dashboard-result-ok')?.focus();
  });
}

function initDashboardResultModal() {
  const overlay = document.getElementById('modal-dashboard-result');
  if (!overlay) return;
  document.addEventListener('keydown', dashboardResultModalOnKeydown);
  document.getElementById('modal-dashboard-result-ok')?.addEventListener('click', closeDashboardResultModal);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeDashboardResultModal();
  });
}

function formatRequestForError(path, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  let extra = '';
  if (opts.body != null && opts.body !== '') {
    if (typeof opts.body === 'string') {
      try {
        const o = JSON.parse(opts.body);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          extra = ` body keys: ${Object.keys(o).join(', ')}`;
        }
      } catch {
        extra = ' body: (non-JSON or empty)';
      }
    }
  }
  return `${method} ${path}${extra}`;
}

function appendRequestLine(msg, path, opts) {
  const base = String(msg || '').trim();
  const line = formatRequestForError(path, opts);
  if (!base) return `Request: ${line}`;
  if (base.includes('Request:')) return base;
  return `${base}\nRequest: ${line}`;
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
    if (j.request && typeof j.request === 'object') {
      const r = j.request;
      const bits = [r.method, r.url || r.path].filter(Boolean).join(' ');
      if (bits) msg = msg ? `${msg}\nUpstream request: ${bits}` : `Upstream request: ${bits}`;
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
  const inSection = showSectionAlert('error', msg, ctx);
  if (!inSection) {
    const wrap = document.getElementById('dashboard-toasts');
    if (wrap) {
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
  }
  openDashboardResultModal('error', ctx, msg);
}

function showDashboardSuccess(message, context = '') {
  const msg = String(message || '').trim();
  if (!msg) return;
  const ctx = context || 'Done';
  const inSection = showSectionAlert('success', msg, ctx);
  if (!inSection) {
    const wrap = document.getElementById('dashboard-toasts');
    if (wrap) {
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
  }
  openDashboardResultModal('success', ctx, msg);
}

function showDashboardWarning(message, context = '') {
  const msg = String(message || '').trim();
  if (!msg) return;
  const ctx = context || 'Notice';
  const inSection = showSectionAlert('warn', msg, ctx);
  if (!inSection) {
    const wrap = document.getElementById('dashboard-toasts');
    if (wrap) {
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
  }
  openDashboardResultModal('warn', ctx, msg);
}

async function readJson(path, opts = {}) {
  let res;
  try {
    res = await api(path, opts);
  } catch (e) {
    throw new Error(appendRequestLine(`Network error: ${errMsg(e)}`, path, opts));
  }
  const text = await res.text();
  if (res.status === 401) {
    throw new Error(
      appendRequestLine(
        'Unauthorized — set the dashboard token in the header if the server has DASHBOARD_TOKEN set (x-dashboard-token).',
        path,
        opts
      )
    );
  }
  if (!res.ok) {
    throw new Error(appendRequestLine(parseApiErrorBody(text, res.status), path, opts));
  }
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      appendRequestLine(
        `Invalid JSON from server (${res.status}): ${text.slice(0, 400)}`,
        path,
        opts
      )
    );
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

function loadCollapsedSectionsState() {
  try {
    const raw = localStorage.getItem(SECTION_COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCollapsedSectionsState(state) {
  try {
    localStorage.setItem(SECTION_COLLAPSE_STORAGE_KEY, JSON.stringify(state || {}));
  } catch {
    /* ignore */
  }
}

function setSectionCollapsed(section, btn, collapsed) {
  section.classList.toggle('section-collapsed', !!collapsed);
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  btn.textContent = collapsed ? 'Expand' : 'Collapse';
}

function initDeskTabs() {
  const manualPanel = document.getElementById('desk-panel-manual');
  const autoPanel = document.getElementById('desk-panel-automated');
  const agenticPanel = document.getElementById('desk-panel-agentic');
  const tabManual = document.getElementById('tab-desk-manual');
  const tabAuto = document.getElementById('tab-desk-automated');
  const tabAgentic = document.getElementById('tab-desk-agentic');
  const navManual = document.querySelector('.flow-nav-manual');
  const navAuto = document.querySelector('.flow-nav-automated');
  const navAgentic = document.querySelector('.flow-nav-agentic');

  function setDeskTab(which, { persist = true } = {}) {
    const mode = which === 'automated' || which === 'agentic' ? which : 'manual';
    const manual = mode === 'manual';
    const automated = mode === 'automated';
    const agentic = mode === 'agentic';
    tabManual?.classList.toggle('is-active', manual);
    tabAuto?.classList.toggle('is-active', automated);
    tabAgentic?.classList.toggle('is-active', agentic);
    tabManual?.setAttribute('aria-selected', manual ? 'true' : 'false');
    tabAuto?.setAttribute('aria-selected', automated ? 'true' : 'false');
    tabAgentic?.setAttribute('aria-selected', agentic ? 'true' : 'false');
    manualPanel?.toggleAttribute('hidden', !manual);
    autoPanel?.toggleAttribute('hidden', !automated);
    agenticPanel?.toggleAttribute('hidden', !agentic);
    navManual?.toggleAttribute('hidden', !manual);
    navAuto?.toggleAttribute('hidden', !automated);
    navAgentic?.toggleAttribute('hidden', !agentic);
    if (persist) {
      try {
        localStorage.setItem(DESK_TAB_STORAGE_KEY, mode);
      } catch {
        /* ignore */
      }
    }
    if (automated) refreshStatus();
    if (agentic) refreshAgenticTrading();
  }

  tabManual?.addEventListener('click', () => setDeskTab('manual'));
  tabAuto?.addEventListener('click', () => setDeskTab('automated'));
  tabAgentic?.addEventListener('click', () => setDeskTab('agentic'));

  for (const el of document.querySelectorAll('.desk-link-manual')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const id = el.getAttribute('data-sec') || el.getAttribute('href')?.replace(/^#/, '');
      setDeskTab('manual');
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      if (id) history.replaceState(null, '', `#${id}`);
    });
  }

  for (const el of document.querySelectorAll('a.desk-link-automated')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const id = el.getAttribute('href')?.replace(/^#/, '') || 'sec-agent';
      setDeskTab('automated');
      if (id === 'sec-advanced') {
        const det = document.getElementById('sec-advanced');
        if (det) det.open = true;
      }
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      history.replaceState(null, '', `#${id}`);
    });
  }

  for (const el of document.querySelectorAll('a.desk-link-agentic')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const id = el.getAttribute('href')?.replace(/^#/, '') || 'sec-agentic-runtime';
      setDeskTab('agentic');
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      history.replaceState(null, '', `#${id}`);
    });
  }

  let initial = 'manual';
  try {
    const saved = localStorage.getItem(DESK_TAB_STORAGE_KEY);
    if (saved === 'automated') initial = 'automated';
    if (saved === 'agentic') initial = 'agentic';
  } catch {
    /* ignore */
  }
  if (
    location.hash === '#sec-agent' ||
    location.hash === '#sec-advanced' ||
    location.hash === '#sec-agent-pnl-auto'
  ) {
    initial = 'automated';
  }
  if (
    location.hash === '#sec-agentic-runtime' ||
    location.hash === '#sec-agentic-process' ||
    location.hash === '#sec-agentic-pnl' ||
    location.hash === '#sec-agentic-bot-console' ||
    location.hash === '#sec-agentic-bot-trades' ||
    location.hash === '#sec-agentic-bot-positions' ||
    location.hash === '#sec-agentic-bot-ticks' ||
    location.hash === '#sec-agentic-bot-live'
  ) {
    initial = 'agentic';
  }
  setDeskTab(initial, { persist: false });
  if (location.hash === '#sec-advanced') {
    const det = document.getElementById('sec-advanced');
    if (det) det.open = true;
  }

  window.addEventListener('hashchange', () => {
    if (
      location.hash === '#sec-agent' ||
      location.hash === '#sec-advanced' ||
      location.hash === '#sec-agent-pnl-auto'
    ) {
      setDeskTab('automated');
      if (location.hash === '#sec-advanced') {
        const det = document.getElementById('sec-advanced');
        if (det) det.open = true;
      }
      return;
    }
    if (
      location.hash === '#sec-agentic-runtime' ||
      location.hash === '#sec-agentic-process' ||
      location.hash === '#sec-agentic-pnl' ||
      location.hash === '#sec-agentic-bot-console' ||
      location.hash === '#sec-agentic-bot-trades' ||
      location.hash === '#sec-agentic-bot-positions' ||
      location.hash === '#sec-agentic-bot-ticks' ||
      location.hash === '#sec-agentic-bot-live'
    ) {
      setDeskTab('agentic');
    }
  });
}

function initCollapsibleSections() {
  const state = loadCollapsedSectionsState();
  const sections = document.querySelectorAll('main.flow-grid .desk-tab-panel > section.card.wide[id]');
  for (const sec of sections) {
    const id = sec.id;
    let head = sec.querySelector(':scope > .card-head');
    if (!head) {
      const h2 = sec.querySelector(':scope > h2');
      if (!h2) continue;
      head = document.createElement('div');
      head.className = 'card-head';
      sec.insertBefore(head, h2);
      head.appendChild(h2);
    }

    const already = head.querySelector('.section-collapse-toggle');
    if (already) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small ghost section-collapse-toggle';
    btn.dataset.sectionId = id;
    head.appendChild(btn);

    const collapsed = !!state[id];
    setSectionCollapsed(sec, btn, collapsed);

    btn.addEventListener('click', () => {
      const next = !sec.classList.contains('section-collapsed');
      setSectionCollapsed(sec, btn, next);
      state[id] = next;
      saveCollapsedSectionsState(state);
    });
  }
}

function walletSession() {
  const walletId = document.getElementById('wallet-select')?.value?.trim() || '';
  const password = document.getElementById('wallet-pass')?.value || '';
  const o = {};
  if (walletId) o.walletId = walletId;
  if (password) o.password = password;
  return o;
}

function walletSessionMode() {
  const sel = document.getElementById('wallet-session-mode');
  const fromUi = sel?.value === 'remember' ? 'remember' : 'session';
  return fromUi;
}

function walletSessionStorageForMode(mode) {
  return mode === 'remember' ? localStorage : sessionStorage;
}

function persistWalletSessionMode(mode) {
  localStorage.setItem(WALLET_SESSION_MODE_STORAGE_KEY, mode === 'remember' ? 'remember' : 'session');
}

function getPersistedWalletSessionMode() {
  return localStorage.getItem(WALLET_SESSION_MODE_STORAGE_KEY) === 'remember' ? 'remember' : 'session';
}

function loadWalletSessionStorage() {
  try {
    const storage = walletSessionStorageForMode(walletSessionMode());
    const raw = storage.getItem(WALLET_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return {
      walletId: String(j.walletId || '').trim(),
      password: typeof j.password === 'string' ? j.password : '',
    };
  } catch {
    return null;
  }
}

function saveWalletSessionStorage(walletId, password) {
  const mode = walletSessionMode();
  const storage = walletSessionStorageForMode(mode);
  storage.setItem(
    WALLET_SESSION_STORAGE_KEY,
    JSON.stringify({ walletId: String(walletId || '').trim(), password: String(password || '') })
  );
  walletSessionStorageForMode(mode === 'remember' ? 'session' : 'remember').removeItem(WALLET_SESSION_STORAGE_KEY);
  persistWalletSessionMode(mode);
}

function clearWalletSessionStorage() {
  sessionStorage.removeItem(WALLET_SESSION_STORAGE_KEY);
  localStorage.removeItem(WALLET_SESSION_STORAGE_KEY);
}

function updateWalletSessionStatus() {
  const line = document.getElementById('wallet-session-status');
  const loggedInBlock = document.getElementById('wallet-auth-logged-in');
  const loggedOutBlock = document.getElementById('wallet-auth-logged-out');
  const loggedInLabel = document.getElementById('wallet-auth-logged-in-label');
  if (!line) return;
  const mode = walletSessionMode();
  const s = loadWalletSessionStorage();
  if (s?.walletId && s.password) {
    if (loggedInBlock) loggedInBlock.hidden = false;
    if (loggedOutBlock) loggedOutBlock.hidden = true;
    if (loggedInLabel) {
      loggedInLabel.textContent =
        mode === 'remember'
          ? `Logged in as ${s.walletId}. Persistence: Remember on this device.`
          : `Logged in as ${s.walletId}. Persistence: Session-only.`;
    }
    line.textContent =
      mode === 'remember'
        ? `Logged in: ${s.walletId} (remembered on this device/browser profile).`
        : `Logged in: ${s.walletId} (session-only for this tab/browser run).`;
    line.classList.remove('hint-error');
  } else {
    if (loggedInBlock) loggedInBlock.hidden = true;
    if (loggedOutBlock) loggedOutBlock.hidden = false;
    if (loggedInLabel) loggedInLabel.textContent = '';
    line.textContent =
      mode === 'remember'
        ? 'Logged out: no remembered wallet session on this device.'
        : 'Logged out: wallet session is not persisted beyond this tab/browser session.';
    line.classList.remove('hint-error');
  }
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

/**
 * Parse `relayer-cli wallet accounts` stdout (human table or `--json`) into rows for UI.
 * Table columns: INDEX, BALANCE, ON-CHAIN, IO-TYPE, TX-TYPE, ACCOUNT (see nyks-wallet docs).
 * @returns {Array<{ index: number, balance: string, onChain: string, ioType: string, txType: string, accountId: string, raw?: object|null }>}
 */
function parseZkOsAccountDetailsFromStdout(stdout) {
  const s = String(stdout || '').trim();
  if (!s || /No ZkOS accounts found/i.test(s)) return [];
  try {
    const j = JSON.parse(s);
    const arr = Array.isArray(j) ? j : j?.accounts || j?.zkosAccounts || j?.zkAccounts || j?.data;
    if (Array.isArray(arr) && arr.length) {
      const out = [];
      for (const row of arr) {
        if (row == null || typeof row !== 'object') continue;
        const index = Number(row.account_index ?? row.accountIndex ?? row.index);
        if (!Number.isFinite(index)) continue;
        const balance = row.balance ?? row.BALANCE ?? row.balance_sats ?? '';
        const accountId = String(
          row.account ?? row.account_id ?? row.accountAddress ?? row.address ?? ''
        ).trim();
        const ioType = String(row.io_type ?? row.ioType ?? row.IO_TYPE ?? '').trim();
        const txType = String(row.tx_type ?? row.txType ?? row.TX_TYPE ?? '').trim();
        let raw = null;
        try {
          raw = JSON.parse(JSON.stringify(row));
        } catch {
          raw = null;
        }
        out.push({
          index,
          balance: String(balance ?? ''),
          onChain: String(row.on_chain ?? row.onChain ?? ''),
          ioType,
          txType,
          accountId,
          raw,
        });
      }
      return out.sort((a, b) => a.index - b.index);
    }
  } catch {
    /* table / plain text */
  }
  const out = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!/^\d+\s+/.test(t)) continue;
    if (/^INDEX\b/i.test(t)) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 2) continue;
    const index = Number(parts[0]);
    if (!Number.isFinite(index)) continue;
    const balance = parts[1];
    let onChain = '';
    let ioType = '';
    let txType = '';
    let accountId = '';
    if (parts.length >= 6) {
      onChain = parts[2] || '';
      ioType = parts[3] || '';
      txType = parts[4] || '';
      accountId = parts.slice(5).join(' ') || '';
    } else if (parts.length === 5) {
      onChain = parts[2] || '';
      ioType = parts[3] || '';
      accountId = parts[4] || '';
    } else {
      onChain = parts[2] || '';
      accountId = parts.length > 3 ? parts.slice(2).join(' ') : '';
    }
    out.push({
      index,
      balance,
      onChain,
      ioType,
      txType,
      accountId,
      raw: null,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

function parseAccountRowsFromStdout(stdout) {
  return parseZkOsAccountDetailsFromStdout(stdout).length;
}

function envFlagYes(key) {
  const rows = window.__envRows || [];
  const row = rows.find((r) => r.key === key);
  if (!row?.hasValue) return false;
  return String(row.value || '').trim().toUpperCase() === 'YES';
}

/** Row for the account selected in ZkOS dropdown; synthetic if index not in last list cache. */
function getSelectedZkOsRow() {
  const sel = document.getElementById('zkos-active-account-select');
  const v = sel?.value?.trim();
  if (!v) return null;
  const idx = Number(v);
  if (!Number.isFinite(idx)) return null;
  const rows = Array.isArray(zkosAccountsListCache) ? zkosAccountsListCache : [];
  const found = rows.find((r) => r.index === idx);
  if (found) return found;
  return {
    index: idx,
    balance: '',
    onChain: '',
    ioType: '',
    txType: '',
    accountId: '',
    raw: null,
    _synthetic: true,
  };
}

function syncZkosInspectorGateHint() {
  const el = document.getElementById('zkos-inspector-gates');
  if (!el) return;
  const zk = envFlagYes('RELAYER_ALLOW_DASHBOARD_ZK');
  const ord = envFlagYes('RELAYER_ALLOW_DASHBOARD_ORDERS');
  el.textContent = `Relayer gates (.env): ZkOS ${zk ? 'YES' : 'NO'} · Orders ${ord ? 'YES' : 'NO'}`;
}

function syncZkosInspector() {
  syncZkosInspectorGateHint();
  const emptyEl = document.getElementById('zkos-inspector-empty');
  const bodyEl = document.getElementById('zkos-inspector-body');
  const fieldsEl = document.getElementById('zkos-inspector-fields');
  const rawEl = document.getElementById('zkos-inspector-raw');
  const rawTgl = document.getElementById('zkos-inspector-raw-toggle');
  const sel = document.getElementById('zkos-active-account-select');
  const hasPick = sel && sel.value !== '' && sel.value != null;
  const row = hasPick ? getSelectedZkOsRow() : null;
  const actionBtns = document.querySelectorAll('#zkos-inspector-actions button');

  if (!hasPick || !row) {
    if (emptyEl) emptyEl.hidden = false;
    if (bodyEl) bodyEl.hidden = true;
    if (fieldsEl) fieldsEl.innerHTML = '';
    if (rawTgl) rawTgl.checked = false;
    if (rawEl) {
      rawEl.textContent = '';
      rawEl.hidden = true;
    }
    actionBtns.forEach((b) => {
      b.disabled = true;
    });
    const fillWd = document.getElementById('btn-zkos-insp-withdraw-fill');
    if (fillWd) fillWd.disabled = true;
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  if (bodyEl) bodyEl.hidden = false;
  actionBtns.forEach((b) => {
    b.disabled = false;
  });
  const fillWd = document.getElementById('btn-zkos-insp-withdraw-fill');
  if (fillWd) fillWd.disabled = false;

  const synth = !!row._synthetic;
  if (fieldsEl) {
    if (synth) {
      fieldsEl.innerHTML = `<tbody><tr><td colspan="2" class="hint">${escapeHtml(
        `Index ${row.index} is not in the last list output — run List ZkOS accounts for full fields. Actions still use this index.`
      )}</td></tr></tbody>`;
    } else {
      const known = new Set([
        'account_index',
        'accountIndex',
        'index',
        'balance',
        'BALANCE',
        'balance_sats',
        'account',
        'account_id',
        'accountAddress',
        'address',
        'on_chain',
        'onChain',
        'io_type',
        'ioType',
        'IO_TYPE',
        'tx_type',
        'txType',
        'TX_TYPE',
      ]);
      const rowsHtml = [
        ['Index', String(row.index)],
        ['Balance (parsed)', row.balance || '—'],
        ['On-chain', row.onChain || '—'],
        ['io_type', row.ioType || '—'],
        ['tx_type', row.txType || '—'],
        ['Account id / address', row.accountId || '—'],
      ];
      if (row.raw && typeof row.raw === 'object') {
        for (const k of Object.keys(row.raw).sort()) {
          if (known.has(k)) continue;
          const v = row.raw[k];
          const cell = v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
          rowsHtml.push([k, cell]);
        }
      }
      fieldsEl.innerHTML = `<tbody>${rowsHtml
        .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
        .join('')}</tbody>`;
    }
  }

  if (rawTgl) rawTgl.checked = false;
  if (rawEl) {
    rawEl.textContent = row.raw
      ? JSON.stringify(row.raw, null, 2)
      : '(No raw JSON — list output was table/text, or synthetic row.)';
    rawEl.hidden = true;
  }
}

async function refreshZkosAccountAvailability() {
  const creds = walletSession();
  if (!creds.walletId || !creds.password) {
    zkosAccountAvailability = {
      checked: true,
      canRunReal: false,
      accountCount: 0,
      reason: 'Select wallet + password in step 1 to enable Real.',
    };
    return zkosAccountAvailability;
  }
  try {
    const r = await readJson('/api/relayer/wallet/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    const rows = parseZkOsAccountDetailsFromStdout(r?.stdout || '');
    if (r?.ok) {
      zkosAccountsListCache = rows;
      rebuildZkosActiveAccountDropdown();
      updateZkosTradeAccountBanner();
    }
    const count = rows.length;
    zkosAccountAvailability = {
      checked: true,
      canRunReal: count > 0,
      accountCount: count,
      reason:
        count > 0
          ? `ZkOS account(s) detected: ${count}`
          : 'No ZkOS accounts yet. Fund one in step 3b first.',
    };
  } catch (e) {
    zkosAccountAvailability = {
      checked: true,
      canRunReal: false,
      accountCount: 0,
      reason: `ZkOS check failed: ${errMsg(e)}`,
    };
  }
  return zkosAccountAvailability;
}

function parseWalletInfoStdout(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    const addr = j.address || j.walletAddress || j.twilightAddress || j.accountAddress || '';
    const btc = j.btc_address || j.btcAddress || '';
    return { address: String(addr || '').trim(), btcAddress: String(btc || '').trim() };
  } catch {
    const addrMatch = raw.match(/(twilight1[0-9a-z]+)/i);
    const btcMatch = raw.match(/(bc1[0-9a-z]+)/i);
    return {
      address: addrMatch ? addrMatch[1].trim() : '',
      btcAddress: btcMatch ? btcMatch[1].trim() : '',
    };
  }
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
      ? 'ZkOS fund, withdraw, and rotate are allowed for this server process.'
      : 'Enable to write RELAYER_ALLOW_DASHBOARD_ZK=YES to .env (required for fund / withdraw / rotate).';
  }
}

function syncTwilightNetworkSwitch(entries) {
  const sel = document.getElementById('twilight-network-mode');
  const hint = document.getElementById('twilight-network-hint');
  if (!sel) return;
  const nt = (entries || []).find((r) => r.key === 'NETWORK_TYPE');
  const value = String(nt?.value || '').trim().toLowerCase();
  const effective = value === 'mainnet' ? 'mainnet' : 'testnet';
  sel.value = effective;
  if (hint) {
    hint.textContent =
      effective === 'mainnet'
        ? 'Mainnet selected. Faucet actions are expected to be unavailable on mainnet.'
        : 'Testnet selected. Faucet + mint paths are available when testnet endpoints are configured.';
    hint.classList.remove('hint-error');
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
  const savedSession = loadWalletSessionStorage();
  const prev = selectId || savedSession?.walletId || localStorage.getItem(WALLET_STORAGE_KEY) || sel.value;
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
    if (savedSession?.password) {
      const pw = document.getElementById('wallet-pass');
      if (pw && !pw.value) pw.value = savedSession.password;
    }
    updateWalletSessionStatus();
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
  lastFaucetRecipientAddress = String(r?.recipientAddress || '').trim();
  lastFaucetNyksTxHash = parseFaucetStepTxHash(r?.nyks?.body || '') || '';
  lastFaucetMintTxHash = parseFaucetStepTxHash(r?.mint?.body || '') || '';
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

async function checkFaucetTxStatus() {
  const out = document.getElementById('faucet-tx-status-out');
  if (!out) return;
  const hashes = [
    ['NYKS', lastFaucetNyksTxHash],
    ['MINT', lastFaucetMintTxHash],
  ].filter(([, h]) => !!h);
  if (!hashes.length) {
    out.hidden = false;
    out.textContent = 'No faucet tx hash captured yet in this browser session. Run faucet first.';
    showDashboardWarning('Run faucet first so tx hashes are available.', 'Faucet tx status');
    return;
  }
  out.hidden = false;
  out.textContent = 'Checking LCD tx status…';
  try {
    const extraHints = [];
    const lines = [];
    for (const [label, hash] of hashes) {
      const r = await readJson('/api/tx-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash: hash }),
      });
      const codeNum = Number(r.code ?? 0);
      const state = codeNum === 0 ? 'SUCCESS' : `FAILED(code=${codeNum})`;
      const rawLog = String(r.rawLog || '');
      if (
        codeNum === 11 &&
        /clearing account/i.test(rawLog) &&
        /does not exist/i.test(rawLog)
      ) {
        extraHints.push(
          'Mint failed with code=11: missing clearing account for this Twilight address. ' +
            'This is a chain-side precondition issue (not a wallet mismatch). ' +
            'Use CLI faucet (SDK) first and/or initialize account state per current Twilight testnet procedure, then retry mint.'
        );
      }
      lines.push(
        `${label} ${hash}\n` +
          `- state: ${state}\n` +
          `- height: ${r.height || '(unknown)'}\n` +
          `- timestamp: ${r.timestamp || '(unknown)'}\n` +
          `- lcd: ${r.lcdBase || '(unknown)'}\n` +
          (r.rawLog ? `- raw_log: ${rawLog.slice(0, 500)}` : '- raw_log: (empty)')
      );
    }
    out.textContent =
      lines.join('\n\n') +
      (extraHints.length ? `\n\nHints:\n- ${extraHints.join('\n- ')}` : '');
    if (extraHints.length) {
      showDashboardWarning(extraHints.join('\n'), 'Faucet tx status');
    } else {
      showDashboardSuccess('Fetched tx status from LCD for latest faucet tx hashes.', 'Faucet tx status');
    }
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    showDashboardError(m, 'Faucet tx status');
  }
}

async function verifyFaucetTargetWallet() {
  const line = document.getElementById('faucet-wallet-verify-line');
  const creds = faucetWalletCreds();
  if (!creds.walletId) {
    const msg = 'Select a wallet in step 1 or faucet wallet dropdown first.';
    if (line) {
      line.textContent = msg;
      line.classList.add('hint-error');
    }
    showDashboardWarning(msg, 'Faucet');
    return;
  }
  if (line) {
    line.textContent = 'Checking wallet info…';
    line.classList.remove('hint-error');
  }
  try {
    const info = await readJson('/api/relayer/wallet/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    const parsed = parseWalletInfoStdout(info?.stdout);
    const tw = parsed?.address || '(unknown twilight address)';
    const btc = parsed?.btcAddress || '(no BTC address shown)';
    const sessionWallet = document.getElementById('wallet-select')?.value?.trim() || '';
    const faucetWallet = document.getElementById('faucet-wallet-select')?.value?.trim() || '';
    const pieces = [
      `Wallet: ${faucetWallet || creds.walletId}`,
      `Twilight address: ${tw}`,
      `BTC address: ${btc}`,
    ];
    if (sessionWallet && faucetWallet && sessionWallet !== faucetWallet) {
      pieces.push(`Warning: faucet wallet (${faucetWallet}) differs from step 1 wallet (${sessionWallet}).`);
    }
    if (lastFaucetRecipientAddress) {
      if (tw && tw === lastFaucetRecipientAddress) {
        pieces.push('Last faucet recipient matches this wallet.');
      } else {
        pieces.push(`Last faucet recipient: ${lastFaucetRecipientAddress}`);
        pieces.push('Warning: last faucet recipient does not match this wallet.');
      }
    } else {
      pieces.push('No recent faucet recipient captured yet in this browser session.');
    }
    if (line) {
      line.textContent = pieces.join(' · ');
      line.classList.remove('hint-error');
    }
  } catch (e) {
    const m = errMsg(e);
    if (line) {
      line.textContent = m;
      line.classList.add('hint-error');
    }
    showDashboardError(m, 'Faucet');
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

function getTwilightAccountIndexFromEnvForm() {
  return document.getElementById('env-TWILIGHT_ACCOUNT_INDEX')?.value?.trim() ?? '';
}

/** Index sent with each real strategy run: UI field first, then saved .env form, then 0. */
function getTwilightAccountIndexForStrategyRun() {
  const pend = document.getElementById('zkos-strategy-index')?.value?.trim() ?? '';
  if (pend !== '' && /^-?\d+$/.test(pend)) return pend;
  const saved = getTwilightAccountIndexFromEnvForm().trim();
  if (saved !== '' && /^-?\d+$/.test(saved)) return saved;
  return '0';
}

/** Best-effort sats from a `wallet accounts` row (for transfer slider max). */
function parseZkOsRowBalanceSats(row) {
  if (!row || typeof row !== 'object') return 0;
  const raw = String(row.balance ?? '').trim();
  if (!raw) return 0;
  const n = Number(raw.replace(/,/g, ''));
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  const digits = raw.replace(/[^\d]/g, '');
  if (digits) {
    const m = Number(digits);
    if (Number.isFinite(m) && m >= 0) return Math.floor(m);
  }
  return 0;
}

function zkosTransferAmountForPct(maxSats, pctRaw) {
  const p = Math.min(100, Math.max(0, Number(pctRaw) || 0));
  if (!Number.isFinite(maxSats) || maxSats <= 0) return 0;
  if (p >= 100) return maxSats;
  return Math.floor((maxSats * p) / 100);
}

function syncZkosTransferSliderState() {
  const sel = document.getElementById('zkos-transfer-from');
  const pct = document.getElementById('zkos-transfer-pct');
  const readout = document.getElementById('zkos-transfer-amount-readout');
  if (!sel || !pct || !readout) return;
  const opt = sel.selectedOptions[0];
  const maxSats = Number(opt?.dataset?.maxSats ?? 0);
  const pctNum = Math.min(100, Math.max(0, Number(pct.value) || 0));
  pct.value = String(pctNum);
  const ok = Number.isFinite(maxSats) && maxSats > 0 && sel.value !== '';
  pct.disabled = !ok;
  if (!ok) {
    readout.textContent = '0 / 0 sats';
    return;
  }
  const amt = zkosTransferAmountForPct(maxSats, pctNum);
  readout.textContent =
    pctNum >= 100
      ? `${amt.toLocaleString()} sats (full account)`
      : `${amt.toLocaleString()} / ${maxSats.toLocaleString()} sats (${pctNum}% · split)`;
}

function rebuildZkosTransferFromSelect() {
  const sel = document.getElementById('zkos-transfer-from');
  if (!sel) return;
  const prev = sel.value;
  const rows = Array.isArray(zkosAccountsListCache)
    ? zkosAccountsListCache.slice().sort((a, b) => a.index - b.index)
    : [];
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.dataset.maxSats = '0';
  ph.textContent = rows.length ? '— Choose source account —' : '— List ZkOS accounts first —';
  sel.appendChild(ph);
  for (const r of rows) {
    const o = document.createElement('option');
    o.value = String(r.index);
    const maxSats = parseZkOsRowBalanceSats(r);
    o.dataset.maxSats = String(maxSats);
    const io = r.ioType ? String(r.ioType) : '—';
    const tx = r.txType && String(r.txType) !== '-' ? String(r.txType) : '—';
    o.textContent = `Index ${r.index} · ~${maxSats.toLocaleString()} sats · ${io}/${tx}`;
    sel.appendChild(o);
  }
  const hasPrev = prev !== '' && [...sel.options].some((x) => x.value === prev);
  sel.value = hasPrev ? prev : '';
  syncZkosTransferSliderState();
}

function rebuildZkosActiveAccountDropdown() {
  const sel = document.getElementById('zkos-active-account-select');
  const idxInput = document.getElementById('zkos-strategy-index');
  if (!sel || !idxInput) return;
  let current = String(idxInput.value ?? '').trim();
  if (current === '' || current === 'NaN' || !/^-?\d+$/.test(current)) current = '0';
  idxInput.value = current;

  const rows = Array.isArray(zkosAccountsListCache)
    ? zkosAccountsListCache.slice().sort((a, b) => a.index - b.index)
    : [];

  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = rows.length ? '— Choose account —' : '— List ZkOS accounts (button below) —';
  sel.appendChild(ph);

  for (const r of rows) {
    const o = document.createElement('option');
    o.value = String(r.index);
    const bal = r.balance != null && r.balance !== '' ? String(r.balance) : '—';
    const io = r.ioType ? String(r.ioType) : '—';
    const tx = r.txType && String(r.txType) !== '-' ? String(r.txType) : '—';
    const tail =
      r.accountId && String(r.accountId).length > 10
        ? `…${String(r.accountId).slice(-8)}`
        : r.accountId || '—';
    o.textContent = `Index ${r.index} · ${bal} sats · ${io}/${tx} · ${tail}`;
    sel.appendChild(o);
  }

  const inRows = rows.some((r) => String(r.index) === current);
  if (!inRows && current !== '') {
    const o = document.createElement('option');
    o.value = current;
    o.textContent = `Index ${current} (.env / manual — not in last list)`;
    sel.appendChild(o);
  }

  const hasOpt = [...sel.options].some((o) => o.value === current);
  sel.value = hasOpt ? current : '';
  rebuildZkosTransferFromSelect();
  syncZkosInspector();
}

function updateZkosTradeAccountBanner() {
  const line = document.getElementById('zkos-trade-account-line');
  const sub = document.getElementById('zkos-trade-account-sub');
  if (!line) return;
  const savedRaw = getTwilightAccountIndexFromEnvForm();
  const savedNorm = savedRaw === '' ? '0' : savedRaw;
  const runNorm = getTwilightAccountIndexForStrategyRun();
  line.innerHTML = `Real strategy runs use ZkOS index <strong>${escapeHtml(runNorm)}</strong> (field below, then .env). Saved <code>TWILIGHT_ACCOUNT_INDEX</code>: <strong>${escapeHtml(savedNorm)}</strong>.`;
  if (sub) {
    const mismatch = String(runNorm) !== String(savedNorm);
    sub.textContent = mismatch
      ? `Runs use ${runNorm} while .env has ${savedNorm}. Click Save default index to persist the field into .env.`
      : 'Fund moves on-chain sats into ZkOS; Transfer below rotates balance into new account(s). Use a **Coin** row for new opens; **Memo** means that index is locked until the order path settles or you rotate.';
    sub.classList.toggle('hint-error', mismatch);
  }
}

async function runZkosListAccounts(opts = {}) {
  const out = document.getElementById('zkos-out');
  const creds = walletSession();
  if (!creds.walletId) {
    showDashboardWarning('Select a wallet in Twilight wallet (step 1).', 'ZkOS');
    return;
  }
  if (!creds.password) {
    showDashboardWarning('Enter wallet password or log in (step 1).', 'ZkOS');
    return;
  }
  if (out) out.textContent = 'Running…';
  try {
    const r = await readJson('/api/relayer/wallet/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (r?.ok) {
      zkosAccountsListCache = parseZkOsAccountDetailsFromStdout(r.stdout || '');
      rebuildZkosActiveAccountDropdown();
      updateZkosTradeAccountBanner();
    }
    let text = formatRelayerEnvelopeForPre(r);
    if (r && r.ok === false) text = zkosAppendInsufficientHint(text, r);
    if (out && (!opts.silentOut || r.ok === false)) out.textContent = text;
  } catch (e) {
    const m = errMsg(e);
    if (out) out.textContent = m;
    if (opts.userAction) showDashboardError(m, 'ZkOS');
  }
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
    let text = formatRelayerEnvelopeForPre(r);
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

/** Inspector / one-off: POST relayer route and write combined output to #zkos-out. */
async function runZkosInspectorRelayerToOut(label, path, body) {
  const out = document.getElementById('zkos-out');
  if (out) out.textContent = `Running (${label})…`;
  try {
    const r = await readJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let text = formatRelayerEnvelopeForPre(r);
    if (r && r.ok === false) text = zkosAppendInsufficientHint(text, r);
    if (out) out.textContent = text;
    if (r?.ok) showDashboardSuccess(`${label} finished.`, 'ZkOS');
  } catch (e) {
    const m = errMsg(e);
    if (out) out.textContent = m;
    showDashboardError(m, 'ZkOS');
  }
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
    out.textContent = formatRelayerEnvelopeForPre(r);
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
        ? 'Saved RELAYER_ALLOW_DASHBOARD_ZK=YES — ZkOS fund/withdraw/transfer enabled for this process.'
        : 'Removed RELAYER_ALLOW_DASHBOARD_ZK — ZkOS fund/withdraw/transfer disabled.',
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
    out.textContent = formatRelayerEnvelopeForPre(r);
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    showDashboardError(m, 'Relayer');
  }
}

async function refreshStatus(opts = {}) {
  const el = document.getElementById('status-line');
  const last = document.getElementById('last-cycle');
  const errPre = document.getElementById('monitor-error-detail');
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
    if (errPre) {
      if (s.lastErrorStack) {
        errPre.hidden = false;
        errPre.textContent = s.lastErrorStack;
      } else if (s.lastError) {
        errPre.hidden = false;
        errPre.textContent = s.lastError;
      } else {
        errPre.hidden = true;
        errPre.textContent = '';
      }
    }
    el.classList.remove('status-error');
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    el.textContent = `Error loading status: ${m}`;
    el.classList.add('status-error');
  }
}

const PNL_DOM_SLOTS = [
  { stats: 'pnl-stats', note: 'pnl-note-line', open: 'positions-open-body', closed: 'positions-closed-body' },
  {
    stats: 'pnl-stats-auto',
    note: 'pnl-note-line-auto',
    open: 'positions-open-body-auto',
    closed: 'positions-closed-body-auto',
  },
  {
    stats: 'pnl-stats-agentic',
    note: 'pnl-note-line-agentic',
    open: 'positions-open-body-agentic',
    closed: 'positions-closed-body-agentic',
  },
];

function renderPnlNote(noteEl, pnlNote) {
  if (!noteEl) return;
  const raw = String(pnlNote || '').trim();
  if (!raw) {
    noteEl.textContent = '';
    return;
  }
  if (/^Close sends real venue exits/i.test(raw)) {
    noteEl.innerHTML =
      'Close behavior' +
      ' <span class="help-tip" title="' +
      escapeHtml(raw) +
      '">?</span>';
    return;
  }
  noteEl.textContent = raw;
}

function renderPnlIntoSlot(slot, p) {
  const el = document.getElementById(slot.stats);
  const note = document.getElementById(slot.note);
  const openBody = document.getElementById(slot.open);
  const closedBody = document.getElementById(slot.closed);
  if (el) {
    const stat = (label, value) =>
      `<div class="stat-item"><dt>${label}</dt><dd>${value}</dd></div>`;
    el.innerHTML = [
      stat('Realized P&amp;L (closed)', fmtUsd(p.realizedPnlUsd)),
      stat('Unrealized P&amp;L (open)', fmtUsd(p.unrealizedPnlUsd)),
      stat('BTC mark', p.currentBtcPrice ? '$' + Number(p.currentBtcPrice).toLocaleString() : '—'),
      stat('Open positions', String(p.openCount ?? 0)),
      stat('Closed positions', String(p.closedCount ?? 0)),
      stat('Agent tx log (rows)', String(p.transactionCount)),
      stat('Illustrative daily (APY×notional)', fmtUsd(p.sumEstimatedDailyUsd)),
      stat('Open notional (portfolio)', fmtUsd(p.openNotionalUsd)),
    ].join('');
  }
  renderPnlNote(note, p.pnlNote);

  const opens = p.openPositions || [];
  if (openBody) {
    openBody.innerHTML = opens
      .map(
        (o) => `
        <tr class="pos-open-row" data-pos-tid="${escapeHtml(o.tradeId)}">
          <td>#${o.strategyId} ${escapeHtml(o.strategyName || '')}</td>
          <td>${escapeHtml(o.mode || '')}</td>
          <td>${o.entryBtcPrice ? '$' + Number(o.entryBtcPrice).toLocaleString() : '—'}</td>
          <td>${o.unrealizedPnlUsd != null ? fmtUsd(o.unrealizedPnlUsd) : '—'}</td>
          <td class="pos-close-cell">
            <input type="text" class="pos-close-amt" data-tid="${escapeHtml(o.tradeId)}" placeholder="Optional realized $" title="Blank = Twilight-leg mark at close after venue exits. Real mode runs relayer + CEX reduce-only when those legs existed." size="12" />
            <button type="button" class="btn small primary pos-close-btn" data-tid="${escapeHtml(o.tradeId)}" data-mode="${escapeHtml(o.mode || '')}" data-mtm-usd="${Number.isFinite(Number(o.unrealizedPnlUsd)) ? Number(o.unrealizedPnlUsd) : 0}">Close</button>
          </td>
        </tr>`
      )
      .join('');
    if (!opens.length)
      openBody.innerHTML = `<tr><td colspan="5">No open positions. Run a strategy (Sim) to open one.</td></tr>`;
  }

  const closed = p.closedPositions || [];
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
      closedBody.innerHTML = `<tr><td colspan="3">No closed positions yet. Use Close on an open row (real = venue exits + ledger).</td></tr>`;
    }
  }
}

async function refreshPnl(opts = {}) {
  try {
    const p = await readJson('/api/pnl');
    const opens = p.openPositions || [];
    lastOpenPositions = opens.slice();
    for (const slot of PNL_DOM_SLOTS) {
      if (document.getElementById(slot.stats)) renderPnlIntoSlot(slot, p);
    }
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    lastOpenPositions = [];
    for (const slot of PNL_DOM_SLOTS) {
      const el = document.getElementById(slot.stats);
      const openBody = document.getElementById(slot.open);
      const closedBody = document.getElementById(slot.closed);
      if (el) el.innerHTML = `<div class="stat-item"><dt>Error</dt><dd>${escapeHtml(m)}</dd></div>`;
      if (openBody) openBody.innerHTML = '';
      if (closedBody) closedBody.innerHTML = '';
    }
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

function encodeStrategyForDetails(s) {
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(s || {}))));
  } catch {
    return '';
  }
}

function decodeStrategyFromDetails(b64) {
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
let strategyDetailsModalState = null;

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

function closeStrategyDetailsModal() {
  const el = document.getElementById('modal-strategy-details');
  if (el) {
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
  }
  strategyDetailsModalState = null;
}

function closeOpenPositionDetailsModal() {
  const el = document.getElementById('modal-open-position');
  if (el) {
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
  }
}

/**
 * @param {Record<string, unknown>} o open row from `/api/pnl` (ledger + unrealized)
 */
function openOpenPositionDetailsModal(o) {
  const overlay = document.getElementById('modal-open-position');
  const line = document.getElementById('modal-open-position-line');
  const tbody = document.getElementById('modal-open-position-table');
  const raw = document.getElementById('modal-open-position-raw');
  if (!overlay || !tbody) return;

  const v = o.venues || {};
  const twUsdRaw = o.twilightSizeUsd;
  const twUsd =
    twUsdRaw != null && Number.isFinite(Number(twUsdRaw)) && Number(twUsdRaw) > 0
      ? Number(twUsdRaw)
      : Number(v.twilight) || 0;
  const venueBits = [];
  if (Number(v.twilight) > 0 || twUsd > 0) {
    venueBits.push(`Twilight ${fmtUsd(Number(v.twilight) || twUsd)}`);
  }
  if (Number(v.binance) > 0) venueBits.push(`Binance ${fmtUsd(v.binance)}`);
  if (Number(v.bybit) > 0) venueBits.push(`Bybit ${fmtUsd(v.bybit)}`);
  const venueLine = venueBits.length ? venueBits.join(' · ') : '—';

  const lev = o.twilightLeverage;
  const levStr =
    lev != null && Number.isFinite(Number(lev)) && Number(lev) > 0 ? `${Number(lev)}×` : '—';

  if (line) {
    line.textContent = `${o.tradeId} · #${o.strategyId} ${o.strategyName || ''} · ${o.mode || '—'}`;
  }

  const rows = [
    ['Total target notional (at open)', fmtUsd(o.notionalUsd)],
    ['Leg notionals at execution', venueLine],
    ['Twilight direction', o.twilightPosition ? String(o.twilightPosition) : '—'],
    ['Twilight leg size (template USD)', fmtUsd(twUsd)],
    ['Twilight leverage', levStr],
    ['Twilight exposure / margin est. (USD)', fmtUsd(o.exposureUsd)],
    ['BTC mark at open', o.entryBtcPrice ? '$' + Number(o.entryBtcPrice).toLocaleString() : '—'],
    ['CEX venue (hedge)', o.cexVenue ? String(o.cexVenue) : '—'],
    ['CEX direction', o.cexPosition ? String(o.cexPosition) : '—'],
    ['CEX leg notional (template USD)', o.cexNotionalUsd != null ? fmtUsd(Number(o.cexNotionalUsd)) : '—'],
    ['Unrealized (Twilight leg, illustrative)', fmtUsd(o.unrealizedPnlUsd)],
    ['ZkOS account index', o.twilightAccountIndex != null ? String(o.twilightAccountIndex) : '—'],
  ];
  const cf = o.cexFlatten;
  if (cf && typeof cf === 'object' && (cf.symbol || cf.venue)) {
    rows.push([
      'Reduce-only flatten (for close)',
      `${cf.venue || '—'} ${cf.symbol || ''} · side ${cf.side || '—'} · amount ${cf.amount != null ? cf.amount : '—'}`,
    ]);
  }

  tbody.innerHTML = rows
    .map(
      ([k, val]) =>
        `<tr><th style="width: 42%">${escapeHtml(String(k))}</th><td>${escapeHtml(String(val))}</td></tr>`
    )
    .join('');
  if (raw) raw.textContent = JSON.stringify(o, null, 2);
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
}

function openStrategyDetailsModal(strategy) {
  strategyDetailsModalState = strategy || null;
  const overlay = document.getElementById('modal-strategy-details');
  const name = document.getElementById('modal-strategy-details-name');
  const tbody = document.getElementById('modal-strategy-details-table');
  const raw = document.getElementById('modal-strategy-details-raw');
  if (!overlay || !name || !tbody || !raw) return;
  const s = strategy || {};
  name.textContent = `#${s.id ?? '?'} ${s.name || 'Strategy'}`;
  const rows = [
    ['Category', s.category],
    ['Risk', s.risk],
    ['APY %', s.apy],
    ['Daily PnL (est USD)', s.dailyPnL],
    ['Twilight position', s.twilightPosition],
    ['Twilight size USD', s.twilightSize],
    ['Twilight leverage', s.twilightLeverage],
    ['CEX position', s.binancePosition],
    ['CEX size USD', s.binanceSize],
    ['CEX leverage', s.binanceLeverage],
    ['Bybit position', s.bybitPosition],
    ['Bybit size USD', s.bybitSize],
    ['Bybit leverage', s.bybitLeverage],
    ['Profitable', s.profitable],
    ['Strategy ID', s.id],
  ];
  tbody.innerHTML = rows
    .map(
      ([k, v]) =>
        `<tr><th style="width: 40%">${escapeHtml(String(k))}</th><td>${escapeHtml(
          v == null || v === '' ? '—' : String(v)
        )}</td></tr>`
    )
    .join('');
  raw.textContent = JSON.stringify(s, null, 2);
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
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
      if (!w.walletId || !w.password) {
        showDashboardWarning(
          'Real run requires wallet + encryption password in Twilight wallet (step 1). Log in first, then retry.',
          'Real trade'
        );
        return;
      }
      if (w.walletId) body.walletId = w.walletId;
      if (w.password) body.password = w.password;
      body.twilightAccountIndex = getTwilightAccountIndexForStrategyRun();
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
      const st = r.strategy;
      if (t) {
        let msg = `Logical trade ${t.tradeId}\nStrategy #${t.strategyId} ${t.strategyName || ''}\nMode: ${t.mode || '—'}\nNotional ${fmtUsd(t.totalNotionalUsd)}`;
        if (st && typeof st === 'object') {
          const tw = Number(st.twilightSize) || 0;
          const byb = st.isBybitStrategy;
          const cexUsd = byb ? Number(st.bybitSize) || 0 : Number(st.binanceSize) || 0;
          const cexLab = byb ? 'Bybit' : 'Binance';
          const cexDir = byb ? st.bybitPosition : st.binancePosition;
          msg += `\nTwilight ${String(st.twilightPosition || '—')} $${tw.toLocaleString()} (${st.twilightLeverage ?? '—'}×) · ${cexLab} ${String(cexDir || '—')} $${cexUsd.toLocaleString()}`;
        }
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

function asPrettyJson(v) {
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return String(v ?? '');
  }
}

async function refreshAgenticProcessStatus(opts = {}) {
  const line = document.getElementById('agentic-process-line');
  const logsOut = document.getElementById('agentic-process-logs-out');
  if (!line && !logsOut) return;
  try {
    const st = await readJson('/api/twilight-bot/process/status');
    const run = st?.running ? 'running' : 'stopped';
    const pid = st?.pid ?? st?.lastPid ?? '—';
    const mode = st?.attached ? 'attached' : st?.external ? 'external' : 'none';
    if (line) {
      line.textContent = `Process: ${run} · mode: ${mode} · pid ${pid} · spawn allowed: ${st?.spawnAllowed ? 'yes' : 'no'} · repo: ${st?.repoDir || '—'}`;
    }
    if (logsOut) {
      const lines = Array.isArray(st?.recentLogs) ? st.recentLogs : [];
      logsOut.textContent = lines.length ? lines.join('\n') : 'No output yet.';
    }
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    if (line) line.textContent = m;
    if (logsOut) logsOut.textContent = m;
    if (opts.userAction) showDashboardError(m, 'Twilight-bot process');
  }
}

async function refreshAgenticTrading(opts = {}) {
  const runtimeLine = document.getElementById('agentic-runtime-line');
  if (!runtimeLine) return;
  await refreshAgenticProcessStatus(opts);
  try {
    const health = await readJson('/api/twilight-bot/healthz');
    const up = health?.uptime_s ?? health?.uptime ?? health?.uptime_sec;
    runtimeLine.textContent = `Health: connected · uptime: ${up != null ? up : 'n/a'} · status: ${health?.status || 'ok'}`;
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    runtimeLine.textContent = `Health: ${m}`;
    if (opts.userAction) showDashboardError(m, 'Agentic trading');
  }
}

async function spinUpAgentic() {
  try {
    const r = await readJson('/api/twilight-bot/spin-up', { method: 'POST' });
    const stepSummary =
      Array.isArray(r.steps) && r.steps.length
        ? `\n${r.steps.map((s) => `${s.step}: ${s.ok ? 'ok' : 'fail'}`).join('\n')}`
        : '';
    showDashboardSuccess(`Spin up complete (pid ${r.pid ?? '—'}).${stepSummary}`, 'Twilight-bot');
    await refreshAgenticProcessStatus({ userAction: true });
    await refreshAgenticTrading({ userAction: false });
  } catch (e) {
    showDashboardError(errMsg(e), 'Spin up twilight-bot');
  }
}

function readNumOrDefault(id, def) {
  const raw = document.getElementById(id)?.value;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

const TWILIGHT_BOT_PARAM_DEFAULTS = {
  PAPER: '1',
  LIVE_TRADING_CONFIRMED: 'NO',
  MAX_OPEN_POSITIONS: '1',
  MAX_NOTIONAL_USD_PER_INTENT: '200',
  MAX_LEVERAGE: '5',
  DAILY_LOSS_STOP_USD: '50',
  MIN_BALANCE_USD_PER_VENUE: '50',
};

const TWILIGHT_BOT_PARAM_KEYS = [
  'PAPER',
  'LIVE_TRADING_CONFIRMED',
  'MAX_OPEN_POSITIONS',
  'MAX_NOTIONAL_USD_PER_INTENT',
  'MAX_LEVERAGE',
  'DAILY_LOSS_STOP_USD',
  'MIN_BALANCE_USD_PER_VENUE',
  'NYKS_WALLET_ID',
  'NYKS_WALLET_PASSPHRASE',
  'BINANCE_API_KEY',
  'BINANCE_API_SECRET',
  'BYBIT_API_KEY',
  'BYBIT_API_SECRET',
];

const TWILIGHT_BOT_SECRET_KEYS = new Set([
  'NYKS_WALLET_PASSPHRASE',
  'BINANCE_API_KEY',
  'BINANCE_API_SECRET',
  'BYBIT_API_KEY',
  'BYBIT_API_SECRET',
]);

let twilightBotParamRows = [];
let exchangeKeysStatusCache = null;

function tbParamInput(key) {
  return document.getElementById(`tb-param-${key}`);
}

function tbParamStatusEl(key) {
  return document.getElementById(`tb-param-status-${key}`);
}

function getTwilightBotAutoFillValues() {
  const map = {};
  const selectedWallet = document.getElementById('wallet-select')?.value?.trim() ?? '';
  const walletPass = document.getElementById('wallet-pass')?.value ?? '';
  const binanceKey = document.getElementById('binance-api-key')?.value ?? '';
  const binanceSecret = document.getElementById('binance-api-secret')?.value ?? '';
  const bybitKey = document.getElementById('bybit-api-key')?.value ?? '';
  const bybitSecret = document.getElementById('bybit-api-secret')?.value ?? '';
  if (selectedWallet) map.NYKS_WALLET_ID = selectedWallet;
  if (walletPass) map.NYKS_WALLET_PASSPHRASE = walletPass;
  if (binanceKey) map.BINANCE_API_KEY = binanceKey;
  if (binanceSecret) map.BINANCE_API_SECRET = binanceSecret;
  if (bybitKey) map.BYBIT_API_KEY = bybitKey;
  if (bybitSecret) map.BYBIT_API_SECRET = bybitSecret;
  return map;
}

function refreshTwilightBotSecretIndicators() {
  const keys = ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'BYBIT_API_KEY', 'BYBIT_API_SECRET'];
  const byKey = Object.fromEntries((twilightBotParamRows || []).map((e) => [e.key, e]));
  const savedBin = !!exchangeKeysStatusCache?.binance?.configured;
  const savedBy = !!exchangeKeysStatusCache?.bybit?.configured;
  for (const key of keys) {
    const el = tbParamStatusEl(key);
    if (!el) continue;
    const fromEnv = String(byKey[key]?.value || '').trim() !== '';
    const fromStore = key.startsWith('BINANCE_') ? savedBin : savedBy;
    const suffix = key.startsWith('BINANCE_')
      ? exchangeKeysStatusCache?.binance?.apiKeySuffix || ''
      : exchangeKeysStatusCache?.bybit?.apiKeySuffix || '';
    if (fromEnv) {
      el.textContent = 'set in .env';
    } else if (fromStore) {
      el.textContent = suffix ? `saved in CEX key store (${suffix})` : 'saved in CEX key store';
    } else {
      el.textContent = 'not set';
    }
  }
}

function fillTwilightBotParamInputs(entries = [], { preferDashboard = false } = {}) {
  const byKey = Object.fromEntries((entries || []).map((e) => [e.key, e]));
  const auto = getTwilightBotAutoFillValues();
  for (const key of TWILIGHT_BOT_PARAM_KEYS) {
    const el = tbParamInput(key);
    if (!el) continue;
    const envVal = byKey[key]?.value ?? '';
    const autoVal = auto[key] ?? '';
    const defVal = TWILIGHT_BOT_PARAM_DEFAULTS[key] ?? '';
    const next = preferDashboard ? autoVal || envVal || defVal : envVal || autoVal || defVal;
    if (typeof next === 'string') el.value = next;
  }
}

async function refreshTwilightBotParams() {
  const msg = document.getElementById('tb-params-msg');
  try {
    const data = await readJson('/api/env');
    twilightBotParamRows = data.entries || [];
    fillTwilightBotParamInputs(twilightBotParamRows, { preferDashboard: false });
    refreshTwilightBotSecretIndicators();
    if (msg) {
      msg.textContent = 'Saved to repo .env (used by twilight-bot process).';
      msg.classList.remove('hint-error');
    }
  } catch (e) {
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
  }
}

async function autofillTwilightBotParamsFromDashboard() {
  const msg = document.getElementById('tb-params-msg');
  try {
    const exported = await readJson('/api/venue-api-keys/export-env');
    const byKey = Object.fromEntries((twilightBotParamRows || []).map((e) => [e.key, e]));
    fillTwilightBotParamInputs(twilightBotParamRows, { preferDashboard: true });
    for (const key of ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'BYBIT_API_KEY', 'BYBIT_API_SECRET']) {
      const el = tbParamInput(key);
      if (!el) continue;
      const raw = String(exported?.[key] || '').trim();
      if (raw) {
        el.value = raw;
      } else if (byKey[key]?.hasValue) {
        // Keep blank to preserve already-saved secret on Save.
        el.value = '';
      }
    }
    refreshTwilightBotSecretIndicators();
    if (msg) {
      msg.textContent = 'Autofilled from wallet/session/CEX key store and current .env.';
      msg.classList.remove('hint-error');
    }
  } catch (e) {
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    showDashboardError(m, 'Autofill twilight-bot params');
  }
}

function collectTwilightBotParamUpdates() {
  const updates = {};
  const byKey = Object.fromEntries((twilightBotParamRows || []).map((r) => [r.key, r]));
  for (const key of TWILIGHT_BOT_PARAM_KEYS) {
    const el = tbParamInput(key);
    if (!el) continue;
    const raw = String(el.value ?? '').trim();
    if (!raw && TWILIGHT_BOT_SECRET_KEYS.has(key) && byKey[key]?.hasValue) continue;
    if (!raw && TWILIGHT_BOT_SECRET_KEYS.has(key)) continue;
    if (!raw) continue;
    updates[key] = raw;
  }
  return updates;
}

async function saveTwilightBotParams() {
  const msg = document.getElementById('tb-params-msg');
  try {
    const updates = collectTwilightBotParamUpdates();
    await readJson('/api/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });
    if (msg) {
      msg.textContent = 'Saved. Restart/spin up twilight-bot to apply env changes.';
      msg.classList.remove('hint-error');
    }
    await refreshTwilightBotParams();
    await refreshEnv();
  } catch (e) {
    const m = errMsg(e);
    if (msg) {
      msg.textContent = m;
      msg.classList.add('hint-error');
    }
    showDashboardError(m, 'Save twilight-bot params');
  }
}

async function refreshBotTrades(opts = {}) {
  const out = document.getElementById('agentic-bot-trades-out');
  if (!out) return;
  out.textContent = 'Loading…';
  try {
    const q = document.getElementById('agentic-bot-trades-q')?.value?.trim() ?? '';
    const limit = readNumOrDefault('agentic-bot-trades-limit', 25);
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (limit) qs.set('limit', String(limit));
    const data = await readJson(`/api/twilight-bot/trades${qs.size ? `?${qs.toString()}` : ''}`);
    out.textContent = asPrettyJson(data);
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    if (opts.userAction) showDashboardError(m, 'twilight-bot trades');
  }
}

async function refreshBotPositions(opts = {}) {
  const out = document.getElementById('agentic-bot-positions-out');
  if (!out) return;
  out.textContent = 'Loading…';
  try {
    const venue = document.getElementById('agentic-bot-positions-venue')?.value?.trim() ?? '';
    const qs = new URLSearchParams();
    if (venue) qs.set('venue', venue);
    const data = await readJson(`/api/twilight-bot/positions${qs.size ? `?${qs.toString()}` : ''}`);
    out.textContent = asPrettyJson(data);
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    if (opts.userAction) showDashboardError(m, 'twilight-bot positions');
  }
}

async function refreshBotTicks(opts = {}) {
  const out = document.getElementById('agentic-bot-ticks-out');
  if (!out) return;
  out.textContent = 'Loading…';
  try {
    const skill = document.getElementById('agentic-bot-ticks-skill')?.value?.trim() ?? '';
    const status = document.getElementById('agentic-bot-ticks-status')?.value?.trim() ?? '';
    const limit = readNumOrDefault('agentic-bot-ticks-limit', 100);
    const qs = new URLSearchParams();
    if (skill) qs.set('skill', skill);
    if (status) qs.set('status', status);
    if (limit) qs.set('limit', String(limit));
    const data = await readJson(`/api/twilight-bot/ticks${qs.size ? `?${qs.toString()}` : ''}`);
    out.textContent = asPrettyJson(data);
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    if (opts.userAction) showDashboardError(m, 'twilight-bot ticks');
  }
}

function parseJsonTextArea(id) {
  const raw = document.getElementById(id)?.value ?? '';
  if (!String(raw).trim()) return {};
  return JSON.parse(String(raw));
}

async function botPost(path, body) {
  return await readJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function botPut(path, body) {
  return await readJson(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function sendBotIntent({ live }, opts = {}) {
  const out = document.getElementById('agentic-bot-live-out');
  if (!out) return;
  out.textContent = 'Sending…';
  try {
    const body = parseJsonTextArea('agentic-bot-intent-json');
    if (live) {
      body.confirm_live = document.getElementById('agentic-bot-confirm-live')?.checked === true;
    }
    const data = await botPost(live ? '/api/twilight-bot/trades/live' : '/api/twilight-bot/trades/paper', body);
    out.textContent = asPrettyJson(data);
    await refreshBotTrades({ userAction: false });
    await refreshBotPositions({ userAction: false });
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    if (opts.userAction) showDashboardError(m, live ? 'Send live intent' : 'Send paper intent');
  }
}

async function botKillSwitchGet(opts = {}) {
  const out = document.getElementById('agentic-bot-live-out');
  if (!out) return;
  out.textContent = 'Loading…';
  try {
    const data = await readJson('/api/twilight-bot/kill-switch');
    out.textContent = asPrettyJson(data);
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    if (opts.userAction) showDashboardError(m, 'Kill switch');
  }
}

async function botKillSwitchSet(on, opts = {}) {
  const out = document.getElementById('agentic-bot-live-out');
  if (!out) return;
  out.textContent = 'Saving…';
  try {
    const data = await botPut('/api/twilight-bot/kill-switch', { on: !!on });
    out.textContent = asPrettyJson(data);
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    if (opts.userAction) showDashboardError(m, 'Kill switch');
  }
}

async function botCapsGet(opts = {}) {
  const out = document.getElementById('agentic-bot-live-out');
  if (!out) return;
  out.textContent = 'Loading…';
  try {
    const data = await readJson('/api/twilight-bot/caps');
    out.textContent = asPrettyJson(data);
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    if (opts.userAction) showDashboardError(m, 'Caps');
  }
}

async function botClosePosition(opts = {}) {
  const out = document.getElementById('agentic-bot-positions-out');
  if (!out) return;
  const rawId = document.getElementById('agentic-bot-close-position-id')?.value?.trim() ?? '';
  if (!rawId) {
    showDashboardError('Enter a position id to close.', 'twilight-bot positions');
    return;
  }
  out.textContent = 'Closing…';
  try {
    const data = await botPost(`/api/twilight-bot/positions/${encodeURIComponent(rawId)}/close`, {});
    out.textContent = asPrettyJson(data);
    await refreshBotPositions({ userAction: false });
    await refreshBotTrades({ userAction: false });
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    if (opts.userAction) showDashboardError(m, 'Close twilight-bot position');
  }
}

async function stopAgenticProcess() {
  try {
    await readJson('/api/twilight-bot/process/stop', { method: 'POST' });
    await refreshAgenticProcessStatus({ userAction: true });
  } catch (e) {
    showDashboardError(errMsg(e), 'Stop twilight-bot');
  }
}

async function sendAgenticProcessCommand(opts = {}) {
  const input = document.getElementById('agentic-process-command');
  const out = document.getElementById('agentic-process-command-out');
  const command = input?.value?.trim() ?? '';
  if (!command) {
    if (out) out.textContent = 'Enter a command first.';
    if (opts.userAction) showDashboardError('Enter a command first.', 'Twilight-bot stdin');
    return;
  }
  if (out) out.textContent = 'Sending…';
  try {
    const data = await readJson('/api/twilight-bot/process/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (out) out.textContent = asPrettyJson(data);
    if (input) input.value = '';
    await refreshAgenticProcessStatus({ userAction: false });
    await refreshAgenticTrading({ userAction: false });
  } catch (e) {
    const m = errMsg(e);
    if (out) out.textContent = m;
    if (opts.userAction) showDashboardError(m, 'Send command to twilight-bot');
  }
}

/** Same CEX detection as `agents/twilight-strategy-monitor/src/normalize.js` `cexVenue`. */
function strategyCexVenue(s) {
  if (s?.isBybitStrategy) return 'bybit';
  const hasBinance =
    s?.binancePosition &&
    String(s.binancePosition).toLowerCase() !== 'null' &&
    Number(s.binanceSize) > 0;
  if (hasBinance) return 'binance';
  return null;
}

function loadStrategiesCexFilterPrefs() {
  try {
    const raw = localStorage.getItem(STRATEGIES_CEX_FILTER_STORAGE_KEY);
    if (!raw) return { binance: false, bybit: false };
    const j = JSON.parse(raw);
    return { binance: !!j.binance, bybit: !!j.bybit };
  } catch {
    return { binance: false, bybit: false };
  }
}

function saveStrategiesCexFilterPrefs() {
  const binance = document.getElementById('chk-strategies-cex-binance')?.checked === true;
  const bybit = document.getElementById('chk-strategies-cex-bybit')?.checked === true;
  localStorage.setItem(STRATEGIES_CEX_FILTER_STORAGE_KEY, JSON.stringify({ binance, bybit }));
}

function applyStrategiesCexFilterPrefsToUi() {
  const f = loadStrategiesCexFilterPrefs();
  const cbB = document.getElementById('chk-strategies-cex-binance');
  const cbY = document.getElementById('chk-strategies-cex-bybit');
  if (cbB) cbB.checked = f.binance;
  if (cbY) cbY.checked = f.bybit;
}

function getStrategiesCexFilterState() {
  return {
    binance: document.getElementById('chk-strategies-cex-binance')?.checked === true,
    bybit: document.getElementById('chk-strategies-cex-bybit')?.checked === true,
  };
}

function strategyPassesCexLegFilter(s) {
  const f = getStrategiesCexFilterState();
  if (!f.binance && !f.bybit) return true;
  const v = strategyCexVenue(s);
  if (f.binance && v === 'binance') return true;
  if (f.bybit && v === 'bybit') return true;
  return false;
}

function renderStrategiesTableFromCache() {
  const tbody = document.getElementById('strategies-body');
  const meta = document.getElementById('strategies-meta');
  if (!tbody) return;
  const data = strategiesListCache;
  if (!data || !Array.isArray(data.strategies)) {
    tbody.innerHTML = '<tr><td colspan="8">Loading…</td></tr>';
    return;
  }
  const zkos = zkosAccountAvailability;
  const all = data.strategies;
  const rows = all.filter(strategyPassesCexLegFilter);
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
          <button type="button" class="btn small ghost strategy-details" data-strategy-detail="${encodeStrategyForDetails(s)}">View</button>
          <button type="button" class="btn small strategy-exec" data-sid="${s.id}" data-mode="simulation">Sim</button>
          <button type="button" class="btn small danger strategy-exec" data-sid="${s.id}" data-mode="real" data-strategy-meta="${encodeStrategyMetaForBtn(s)}" ${zkos.canRunReal ? '' : 'disabled'} title="${escapeHtml(zkos.reason || '')}">Real</button>
        </td>
      </tr>`
    )
    .join('');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8">${
      all.length ? 'No strategies match the CEX filter (try other checkboxes or refresh).' : 'No strategies returned.'
    }</td></tr>`;
  }
  if (meta) {
    const f = getStrategiesCexFilterState();
    const filterActive = f.binance || f.bybit;
    const filterPart = filterActive
      ? ` · Showing ${rows.length} of ${all.length} (Binance${f.binance ? ' on' : ' off'}, Bybit${f.bybit ? ' on' : ' off'})`
      : ` · ${all.length} rows`;
    meta.textContent = `Updated ${fmtTime(data.timestamp)} · BTC ~ $${data.btcPrice != null ? Number(data.btcPrice).toLocaleString() : '—'}${filterPart}`;
  }
}

async function refreshStrategies(opts = {}) {
  const tbody = document.getElementById('strategies-body');
  const meta = document.getElementById('strategies-meta');
  try {
    const zkos = await refreshZkosAccountAvailability();
    const data = await readJson('/api/strategies/best?limit=20&profitable=true');
    strategiesListCache = data;
    renderStrategiesTableFromCache();
  } catch (e) {
    strategiesListCache = null;
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    if (tbody) tbody.innerHTML = `<tr><td colspan="8">${escapeHtml(m)}</td></tr>`;
    if (meta) meta.textContent = '';
    if (opts.userAction) showDashboardError(m, 'Best trades');
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
    const perStrat = s.risk?.maxNotionalPerStrategyUsd;
    set(
      'agent-max-per-strategy',
      perStrat != null && Number.isFinite(Number(perStrat)) && Number(perStrat) > 0 ? perStrat : ''
    );
    const cexEl = document.getElementById('agent-cex-venue');
    if (cexEl) cexEl.value = (s.strategyFilters?.cexVenue || 'any').toLowerCase();
    const riskEl = document.getElementById('agent-strategy-risk');
    if (riskEl) {
      const r = s.strategyFilters?.risk;
      riskEl.value = r != null && String(r).trim() !== '' ? String(r).trim() : 'any';
    }
    const allow = s.strategyFilters?.riskAllowlist;
    set(
      'agent-risk-allowlist',
      Array.isArray(allow) ? allow.join(',') : allow != null ? String(allow) : ''
    );
    const apz = document.getElementById('chk-auto-pick-zkos');
    if (apz) apz.checked = s.automation?.autoPickZkOsAccount !== false;
    const pzi = document.getElementById('chk-persist-zk-index');
    if (pzi) pzi.checked = s.automation?.persistTwilightIndexAfterRotate !== false;
    const otz = s.automation?.openTradeMaxZkAttempts;
    set('agent-open-trade-max-zk', otz != null && Number(otz) >= 1 ? otz : '');
    const pac = s.positionAutoClose || {};
    const lp = pac.lossPctOfInitialNotional;
    const pp = pac.profitPctOfInitialNotional;
    const mm = pac.maxHoldMinutes;
    set(
      'agent-auto-close-loss-pct',
      lp != null && Number.isFinite(Number(lp)) && Number(lp) > 0 ? lp : ''
    );
    set(
      'agent-auto-close-profit-pct',
      pp != null && Number.isFinite(Number(pp)) && Number(pp) > 0 ? pp : ''
    );
    set(
      'agent-auto-close-max-min',
      mm != null && Number.isFinite(Number(mm)) && Number(mm) > 0 ? mm : ''
    );
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
    const riskParam = document.getElementById('agent-strategy-risk')?.value || 'any';
    const strategyFilters = {
      profitable: document.getElementById('agent-profitable')?.checked,
      limit: Number(document.getElementById('agent-limit')?.value) || 5,
      cexVenue: document.getElementById('agent-cex-venue')?.value || 'any',
      riskAllowlist: document.getElementById('agent-risk-allowlist')?.value?.trim() || '',
    };
    if (riskParam && riskParam !== 'any') strategyFilters.risk = riskParam;
    await readJson('/api/agent/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pollIntervalMs: Number(document.getElementById('agent-poll')?.value),
        strategyFilters,
        execution: { mode: document.getElementById('agent-mode')?.value || 'simulation' },
        risk: {
          maxTotalNotionalUsd: Number(document.getElementById('agent-max-total')?.value),
          maxConcurrentLogicalTrades: Number(document.getElementById('agent-max-concurrent')?.value),
          maxDailyLossUsd: Number(document.getElementById('agent-max-daily')?.value),
          maxNotionalPerStrategyUsd: Number(document.getElementById('agent-max-per-strategy')?.value) || 0,
        },
        automation: {
          autoPickZkOsAccount: !!document.getElementById('chk-auto-pick-zkos')?.checked,
          persistTwilightIndexAfterRotate: !!document.getElementById('chk-persist-zk-index')?.checked,
          openTradeMaxZkAttempts:
            Number(document.getElementById('agent-open-trade-max-zk')?.value) || 3,
        },
        positionAutoClose: {
          lossPctOfInitialNotional: document.getElementById('agent-auto-close-loss-pct')?.value,
          profitPctOfInitialNotional: document.getElementById('agent-auto-close-profit-pct')?.value,
          maxHoldMinutes: document.getElementById('agent-auto-close-max-min')?.value,
        },
      }),
    });
    await loadAgentSettings({ userAction: false });
    await loadConfig({ userAction: false });
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
  const d = ev.target.closest('.strategy-details');
  if (d) {
    const payload = decodeStrategyFromDetails(d.getAttribute('data-strategy-detail'));
    if (payload) openStrategyDetailsModal(payload);
    return;
  }
  const b = ev.target.closest('.strategy-exec');
  if (!b) return;
  const sid = b.getAttribute('data-sid');
  const mode = b.getAttribute('data-mode');
  if (!sid) return;
  const idNum = Number(sid);
  if (mode === 'real') {
    if (b.disabled) {
      showDashboardWarning(zkosAccountAvailability.reason || 'Real mode is currently unavailable.', 'Real trade');
      return;
    }
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
  const creds = walletSession();
  if (!creds.walletId || !creds.password) {
    showDashboardWarning(
      'Log in with wallet + encryption password in Twilight wallet (step 1) before loading the ZkOS snapshot.',
      'Real trade'
    );
    return;
  }
  if (pre) {
    pre.hidden = false;
    pre.textContent = 'Loading…';
  }
  try {
    const r = await readJson('/api/relayer/wallet/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    const rows = parseZkOsAccountDetailsFromStdout(r?.stdout || '');
    const idxNum = Number(getTwilightAccountIndexForStrategyRun());
    const idx = Number.isFinite(idxNum) && idxNum >= 0 ? idxNum : 0;
    const row = rows.find((x) => x.index === idx);
    let text = `ZkOS row for index ${idx} (same index sent with real strategy runs — ZkOS field / .env fallback)\n\n`;
    if (!r?.ok) {
      text += `Relayer did not return ok.\nstderr:\n${r?.stderr || '(none)'}\n\nstdout:\n${r?.stdout || '(none)'}`;
    } else if (!row) {
      const known = rows.length ? rows.map((x) => x.index).join(', ') : '(none — no ZkOS accounts yet)';
      text +=
        `No account row for index ${idx}. Known indices: ${known}.\n` +
        `Fund / list accounts in ZkOS (step 3b) or fix the index in the env form.\n\n--- stdout ---\n${r.stdout || ''}`;
    } else {
      text += `${JSON.stringify(row, null, 2)}\n\n--- relayer stdout ---\n${r.stdout || ''}`;
    }
    if (pre) pre.textContent = text;
  } catch (e) {
    if (pre) pre.textContent = errMsg(e);
  }
});

document.addEventListener('keydown', (ev) => {
  const modal = document.getElementById('modal-real-trade');
  if (ev.key !== 'Escape' || !modal || modal.hidden) return;
  closeRealTradeModal();
});
document.getElementById('modal-strategy-details-dismiss')?.addEventListener('click', closeStrategyDetailsModal);
document.getElementById('modal-strategy-details-close')?.addEventListener('click', closeStrategyDetailsModal);
document.getElementById('modal-strategy-details')?.addEventListener('click', (ev) => {
  if (ev.target.id === 'modal-strategy-details') closeStrategyDetailsModal();
});
document.addEventListener('keydown', (ev) => {
  const modal = document.getElementById('modal-strategy-details');
  if (ev.key !== 'Escape' || !modal || modal.hidden) return;
  closeStrategyDetailsModal();
});

document.getElementById('modal-open-position-dismiss')?.addEventListener('click', closeOpenPositionDetailsModal);
document.getElementById('modal-open-position-close')?.addEventListener('click', closeOpenPositionDetailsModal);
document.getElementById('modal-open-position')?.addEventListener('click', (ev) => {
  if (ev.target.id === 'modal-open-position') closeOpenPositionDetailsModal();
});
document.addEventListener('keydown', (ev) => {
  const modal = document.getElementById('modal-open-position');
  if (ev.key !== 'Escape' || !modal || modal.hidden) return;
  closeOpenPositionDetailsModal();
});

function bindPositionsOpenBodyClick(tbody) {
  if (!tbody) return;
  tbody.addEventListener('click', async (ev) => {
  const closeBtn = ev.target.closest('.pos-close-btn');
  if (closeBtn) {
    const tid = closeBtn.getAttribute('data-tid');
    const mode = (closeBtn.getAttribute('data-mode') || '').trim().toLowerCase();
    const tr = closeBtn.closest('tr');
    const inp = tr?.querySelector('.pos-close-amt');
    const raw = inp?.value?.trim();
    const useMtm = raw === '' || raw == null;
    if (mode === 'real') {
      if (
        !confirm(
          'Close this REAL position? This submits a Twilight market close when that leg was opened, then a reduce-only CEX order when the hedge leg was opened, then updates the ledger.'
        )
      ) {
        return;
      }
      const w0 = walletSession();
      if (!w0.walletId || !w0.password) {
        showDashboardWarning(
          'Real close needs wallet + encryption password in Twilight wallet (step 1).',
          'Close position'
        );
        return;
      }
    }
    const payload = {};
    if (!useMtm) {
      const num = Number(raw);
      if (Number.isNaN(num)) {
        showDashboardWarning('Invalid number for realized P&L override.', 'Close position');
        return;
      }
      payload.realizedPnlUsd = num;
    } else {
      const snap = Number(closeBtn.getAttribute('data-mtm-usd'));
      payload.realizedPnlUsd = Number.isFinite(snap) ? snap : 0;
    }
    if (mode === 'real') {
      const w = walletSession();
      if (w.walletId) payload.walletId = w.walletId;
      if (w.password) payload.password = w.password;
    }
    try {
      const data = await readJson(`/api/positions/${encodeURIComponent(tid)}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (data?.realizedPnlUsd != null && Number.isFinite(Number(data.realizedPnlUsd))) {
        const vs = data.venueSteps || {};
        const parts = [];
        if (mode === 'real') {
          if (vs.twilight) parts.push(vs.twilight.ok ? 'Twilight: closed' : 'Twilight: attempted');
          if (vs.unlockCloseOrder && vs.unlockCloseOrder.ok === false) {
            const u = vs.unlockCloseOrder;
            const msg = String(u.stderr || u.stdout || 'relayer error').trim().slice(0, 400);
            showDashboardWarning(
              `After close, unlock-close-order did not succeed (exit ${u.code}): ${msg}. If rotation failed, wait for settlement, use ZkOS inspector → Unlock settled close, then Transfer 100%.`,
              'Close position'
            );
          }
          if (vs.cex?.ok) parts.push(vs.cex.orderId ? `CEX: order ${vs.cex.orderId}` : 'CEX: flattened');
          const zr = vs.zkRotate;
          const closedIdx = Number(vs.twilight?.accountIndex);
          if (zr?.ok && zr.newAccountIndexHint != null && Number.isFinite(closedIdx) && zr.newAccountIndexHint > closedIdx) {
            const idxEl = document.getElementById('zkos-strategy-index');
            if (idxEl) {
              idxEl.value = String(zr.newAccountIndexHint);
              rebuildZkosActiveAccountDropdown();
              updateZkosTradeAccountBanner();
            }
            parts.push(
              `ZkOS: rotated to index ${zr.newAccountIndexHint} (field updated — Save default index in step 3b to persist .env)`
            );
          } else if (zr?.ok) {
            parts.push('ZkOS: transfer ran — use List ZkOS accounts if the new index is not obvious, then set the field / save .env.');
          } else if (zr?.skipped && Array.isArray(zr.reasons) && zr.reasons.length) {
            parts.push(`ZkOS: ${zr.reasons.join(' ')}`);
          } else if (zr && zr.skipped !== true && zr.ok === false) {
            showDashboardWarning(
              `Twilight closed but ZkOS transfer failed: ${zr.error || zr.stderr || zr.stdout || 'unknown'}. When the account is ready, use step 3b Transfer at 100% from index ${Number.isFinite(closedIdx) ? closedIdx : '?'}.`,
              'Close position'
            );
          }
        }
        parts.push(`Realized (ledger) ${fmtUsd(data.realizedPnlUsd)}${useMtm ? ' · MTM snapshot (Twilight leg)' : ''}`);
        showDashboardSuccess(parts.join(' · '), 'Close position');
      }
      await refreshPnl({ userAction: true });
      await refreshTradeDesk({ userAction: false });
      await refreshZkosAccountAvailability();
      renderStrategiesTableFromCache();
    } catch (e) {
      showDashboardError(errMsg(e), 'Close position');
    }
    return;
  }

  const row = ev.target.closest('tr.pos-open-row');
  if (!row) return;
  const tid = row.getAttribute('data-pos-tid');
  if (!tid) return;
  const o = lastOpenPositions.find((x) => x.tradeId === tid);
  if (o) openOpenPositionDetailsModal(o);
  });
}

bindPositionsOpenBodyClick(document.getElementById('positions-open-body'));
bindPositionsOpenBodyClick(document.getElementById('positions-open-body-auto'));
bindPositionsOpenBodyClick(document.getElementById('positions-open-body-agentic'));

document.getElementById('btn-pnl-refresh')?.addEventListener('click', () => refreshPnl({ userAction: true }));
document.getElementById('btn-pnl-refresh-auto')?.addEventListener('click', () => refreshPnl({ userAction: true }));
document
  .getElementById('btn-pnl-refresh-agentic')
  ?.addEventListener('click', () => refreshPnl({ userAction: true }));

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
  const fromEnv = envEl?.value?.trim();
  if (z) z.value = fromEnv !== undefined && fromEnv !== '' ? fromEnv : '0';
  rebuildZkosActiveAccountDropdown();
  updateZkosTradeAccountBanner();
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
    // Intentionally omit the "X of Y variables set" summary bar.
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
    let html = presetBlock;
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
    syncTwilightNetworkSwitch(data.entries || []);
    syncZkosTwilightIndexField();
    syncZkosInspector();
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

document.getElementById('btn-apply-twilight-network')?.addEventListener('click', async () => {
  const sel = document.getElementById('twilight-network-mode');
  const hint = document.getElementById('twilight-network-hint');
  const preset = sel?.value === 'mainnet' ? 'mainnet' : 'testnet';
  try {
    await readJson('/api/env/apply-preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset, applyExampleStrategyKey: false }),
    });
    await refreshEnv();
    await refreshEnvRawIfVisible();
    await refreshWalletList();
    await loadRelayerMetaHints();
    await loadExchangeStatus();
    await refreshStrategies();
    await refreshTradeDesk();
    if (hint) {
      hint.textContent = `Applied ${preset} preset to .env.`;
      hint.classList.remove('hint-error');
    }
    showDashboardSuccess(
      `Twilight network switched to ${preset}. Setup sections now use ${preset} endpoints from .env.`,
      'Twilight network switch'
    );
  } catch (e) {
    const m = errMsg(e);
    if (hint) {
      hint.textContent = m;
      hint.classList.add('hint-error');
    }
    showDashboardError(m, 'Twilight network switch');
  }
});

async function loadExchangeStatus(opts = {}) {
  const el = document.getElementById('exchange-status');
  const lastEl = document.getElementById('exchange-last-status');
  if (!el) return;
  try {
    const m = await readJson('/api/venue-api-keys');
    exchangeKeysStatusCache = m;
    const bk = document.getElementById('binance-testnet');
    const bt = document.getElementById('bybit-testnet');
    if (bk) bk.checked = !!m.binance?.useTestnet;
    if (bt) bt.checked = !!m.bybit?.useTestnet;
    el.textContent = `Binance: ${m.binance?.configured ? 'saved (' + (m.binance.apiKeySuffix || 'key') + ')' : 'not set'} · Bybit: ${m.bybit?.configured ? 'saved (' + (m.bybit.apiKeySuffix || 'key') + ')' : 'not set'}`;
    if (lastEl) {
      const b = m.binance?.lastStatus;
      const y = m.bybit?.lastStatus;
      const bLine = b
        ? `Binance last check: ${b.ok ? 'OK' : 'FAIL'} @ ${fmtTime(b.checkedAt)}${b.message ? ` — ${b.message}` : ''}`
        : 'Binance last check: not tested yet';
      const yLine = y
        ? `Bybit last check: ${y.ok ? 'OK' : 'FAIL'} @ ${fmtTime(y.checkedAt)}${y.message ? ` — ${y.message}` : ''}`
        : 'Bybit last check: not tested yet';
      lastEl.textContent = `${bLine} · ${yLine}`;
    }
    el.classList.remove('hint-error');
    refreshTwilightBotSecretIndicators();
  } catch (e) {
    if (!shouldSurfaceFetchError(e, opts)) return;
    const m = errMsg(e);
    el.textContent = m;
    el.classList.add('hint-error');
    exchangeKeysStatusCache = null;
    refreshTwilightBotSecretIndicators();
    if (opts.userAction) showDashboardError(m, 'CEX keys status');
  }
}

async function testExchangeKey(venue) {
  const el = document.getElementById('exchange-status');
  if (el) el.textContent = `Testing ${venue} key…`;
  try {
    const r = await readJson('/api/venue-api-keys/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ venue }),
    });
    const msg = r?.message || `${venue} key check ${r?.ok ? 'OK' : 'failed'}.`;
    if (r?.ok) {
      showDashboardSuccess(msg, 'Test CEX key');
    } else {
      showDashboardWarning(msg, 'Test CEX key');
    }
    await loadExchangeStatus({ userAction: true });
    await refreshTradeDesk({ userAction: true });
  } catch (e) {
    const m = errMsg(e);
    if (el) {
      el.textContent = m;
      el.classList.add('hint-error');
    }
    showDashboardError(m, 'Test CEX key');
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
document.getElementById('wallet-session-mode')?.addEventListener('change', async () => {
  const mode = walletSessionMode();
  persistWalletSessionMode(mode);
  const s = loadWalletSessionStorage();
  const pw = document.getElementById('wallet-pass');
  const ws = document.getElementById('wallet-select');
  if (s?.password && pw && !pw.value) pw.value = s.password;
  if (s?.walletId && ws) ws.value = s.walletId;
  updateWalletSessionStatus();
  await refreshZkosBalance();
});
document.getElementById('btn-wallet-login')?.addEventListener('click', async () => {
  const walletId = document.getElementById('wallet-select')?.value?.trim() || '';
  const password = document.getElementById('wallet-pass')?.value || '';
  if (!walletId || !password) {
    showDashboardWarning('Select wallet and enter password first.', 'Wallet list');
    return;
  }
  saveWalletSessionStorage(walletId, password);
  updateWalletSessionStatus();
  showDashboardSuccess(`Saved wallet session for ${walletId}.`, 'Wallet list');
  await refreshZkosBalance();
});
document.getElementById('btn-wallet-logout')?.addEventListener('click', async () => {
  clearWalletSessionStorage();
  const pw = document.getElementById('wallet-pass');
  if (pw) pw.value = '';
  updateWalletSessionStatus();
  try {
    await readJson('/api/relayer/wallet/lock', { method: 'POST' });
  } catch {
    /* ignore lock failure */
  }
  showDashboardSuccess('Logged out wallet session for this browser.', 'Wallet list');
  await refreshZkosBalance();
});

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
document.getElementById('btn-faucet-verify-wallet')?.addEventListener('click', verifyFaucetTargetWallet);
document.getElementById('btn-faucet-check-tx')?.addEventListener('click', checkFaucetTxStatus);

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

document.getElementById('btn-zkos-accounts')?.addEventListener('click', () => runZkosListAccounts({ userAction: true }));
document.getElementById('zkos-active-account-select')?.addEventListener('change', (ev) => {
  const v = ev.target?.value;
  const idx = document.getElementById('zkos-strategy-index');
  if (!idx) return;
  if (v === '' || v == null) return;
  idx.value = String(v);
  updateZkosTradeAccountBanner();
  syncZkosInspector();
});
document.getElementById('zkos-strategy-index')?.addEventListener('input', () => {
  rebuildZkosActiveAccountDropdown();
  updateZkosTradeAccountBanner();
  syncZkosInspector();
});
document.getElementById('btn-zkos-fund')?.addEventListener('click', () => {
  const amount = document.getElementById('zkos-fund-sats')?.value?.trim();
  if (!amount) {
    showDashboardWarning('Enter an amount in sats to fund.', 'ZkOS');
    return;
  }
  zkosPostWithCreds('/api/relayer/zkaccount/fund', { amount });
});
document.getElementById('zkos-transfer-from')?.addEventListener('change', () => syncZkosTransferSliderState());
document.getElementById('zkos-transfer-pct')?.addEventListener('input', () => syncZkosTransferSliderState());

document.getElementById('btn-zkos-transfer')?.addEventListener('click', async () => {
  const out = document.getElementById('zkos-out');
  const sel = document.getElementById('zkos-transfer-from');
  const pctEl = document.getElementById('zkos-transfer-pct');
  const creds = walletSession();
  if (!creds.walletId || !creds.password) {
    showDashboardWarning('Select wallet and enter password in Twilight wallet (step 1).', 'ZkOS');
    return;
  }
  const from = sel?.value?.trim();
  if (!from) {
    showDashboardWarning('Choose a source ZkOS account (list accounts first).', 'ZkOS');
    return;
  }
  const maxSats = Number(sel?.selectedOptions?.[0]?.dataset?.maxSats ?? 0);
  if (!Number.isFinite(maxSats) || maxSats <= 0) {
    showDashboardWarning('Could not read a positive balance for this row; list accounts again.', 'ZkOS');
    return;
  }
  const pct = Math.min(100, Math.max(0, Number(pctEl?.value ?? 100)));
  const amount = zkosTransferAmountForPct(maxSats, pct);
  const useFullTransfer = pct >= 100 || amount >= maxSats;
  if (useFullTransfer) {
    if (
      !confirm(
        `Transfer the full ${maxSats.toLocaleString()} sats from ZkOS index ${from} into one new account? (relayer-cli zkaccount transfer)`
      )
    ) {
      return;
    }
  } else {
    const remainder = maxSats - amount;
    if (amount < 1 || remainder < 1) {
      showDashboardWarning(
        'Move the slider so both split parts are at least 1 sat, or set 100% for a full transfer.',
        'ZkOS'
      );
      return;
    }
    if (
      !confirm(
        `Split ZkOS index ${from} (${maxSats.toLocaleString()} sats) into two NEW accounts: ${amount.toLocaleString()} and ${remainder.toLocaleString()} sats? (zkaccount split — does not deposit into an existing index.)`
      )
    ) {
      return;
    }
  }
  if (out) out.textContent = 'Running…';
  try {
    let r;
    if (useFullTransfer) {
      r = await readJson('/api/relayer/zkaccount/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...creds, accountIndex: Number(from) }),
      });
    } else {
      r = await readJson('/api/relayer/zkaccount/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...creds,
          accountIndex: Number(from),
          balances: `${amount},${maxSats - amount}`,
        }),
      });
    }
    if (out) out.textContent = formatRelayerEnvelopeForPre(r);
    if (r?.ok) {
      await runZkosListAccounts({ userAction: false });
      await refreshZkosAccountAvailability();
      renderStrategiesTableFromCache();
    }
  } catch (e) {
    const m = errMsg(e);
    if (out) out.textContent = m;
    showDashboardError(m, 'ZkOS');
  }
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
    updateZkosTradeAccountBanner();
  } catch (e) {
    const m = errMsg(e);
    if (out) out.textContent = m;
    showDashboardError(m, 'ZkOS');
  }
});

document.getElementById('zkos-inspector-raw-toggle')?.addEventListener('change', (ev) => {
  const pre = document.getElementById('zkos-inspector-raw');
  if (pre) pre.hidden = !ev.target.checked;
});

document.getElementById('btn-zkos-insp-use-index')?.addEventListener('click', () => {
  const row = getSelectedZkOsRow();
  if (!row) return;
  const idx = document.getElementById('zkos-strategy-index');
  if (idx) idx.value = String(row.index);
  rebuildZkosActiveAccountDropdown();
  updateZkosTradeAccountBanner();
  syncZkosInspector();
  showDashboardSuccess(
    `Strategy index field set to ${row.index} (Save default index in step 3b to persist .env).`,
    'ZkOS'
  );
});

document.getElementById('btn-zkos-insp-close')?.addEventListener('click', async () => {
  const row = getSelectedZkOsRow();
  if (!row) return;
  const creds = walletSession();
  if (!creds.walletId || !creds.password) {
    showDashboardWarning('Wallet + password required (step 1).', 'ZkOS');
    return;
  }
  if (!confirm(`Close Twilight trade on ZkOS index ${row.index}?`)) return;
  await runZkosInspectorRelayerToOut('Close trade', '/api/relayer/order/close-trade', {
    ...creds,
    accountIndex: row.index,
    noWait: document.getElementById('zkos-insp-close-nowait')?.checked === true,
  });
  await runZkosListAccounts({ userAction: false, silentOut: true });
  await refreshZkosAccountAvailability();
  syncZkosInspector();
});

document.getElementById('btn-zkos-insp-cancel')?.addEventListener('click', async () => {
  const row = getSelectedZkOsRow();
  if (!row) return;
  const creds = walletSession();
  if (!creds.walletId || !creds.password) {
    showDashboardWarning('Wallet + password required (step 1).', 'ZkOS');
    return;
  }
  if (!confirm(`Cancel pending trade on ZkOS index ${row.index}?`)) return;
  await runZkosInspectorRelayerToOut('Cancel trade', '/api/relayer/order/cancel-trade', {
    ...creds,
    accountIndex: row.index,
  });
  await runZkosListAccounts({ userAction: false, silentOut: true });
  syncZkosInspector();
});

document.getElementById('btn-zkos-insp-unlock-close')?.addEventListener('click', async () => {
  const row = getSelectedZkOsRow();
  if (!row) return;
  const creds = walletSession();
  if (!creds.walletId || !creds.password) {
    showDashboardWarning('Wallet + password required (step 1).', 'ZkOS');
    return;
  }
  if (!confirm(`Unlock settled close on ZkOS index ${row.index}?`)) return;
  await runZkosInspectorRelayerToOut(
    'Unlock settled close',
    '/api/relayer/order/unlock-close-order',
    { ...creds, accountIndex: row.index }
  );
  await runZkosListAccounts({ userAction: false, silentOut: true });
  syncZkosInspector();
});

document.getElementById('btn-zkos-insp-unlock-failed')?.addEventListener('click', async () => {
  const row = getSelectedZkOsRow();
  if (!row) return;
  const creds = walletSession();
  if (!creds.walletId || !creds.password) {
    showDashboardWarning('Wallet + password required (step 1).', 'ZkOS');
    return;
  }
  if (!confirm(`Unlock failed order on ZkOS index ${row.index}?`)) return;
  await runZkosInspectorRelayerToOut(
    'Unlock failed order',
    '/api/relayer/order/unlock-failed-order',
    { ...creds, accountIndex: row.index }
  );
  await runZkosListAccounts({ userAction: false, silentOut: true });
  syncZkosInspector();
});

document.getElementById('btn-zkos-insp-rotate')?.addEventListener('click', async () => {
  const row = getSelectedZkOsRow();
  if (!row) return;
  const creds = walletSession();
  if (!creds.walletId || !creds.password) {
    showDashboardWarning('Wallet + password required (step 1).', 'ZkOS');
    return;
  }
  const maxSats = parseZkOsRowBalanceSats(row);
  const msg =
    maxSats > 0
      ? `Transfer all ~${maxSats.toLocaleString()} sats from ZkOS index ${row.index} into one new account?`
      : `Run full zkaccount transfer from index ${row.index}? (parsed balance is 0 — relayer may still proceed or reject.)`;
  if (!confirm(msg)) return;
  await runZkosInspectorRelayerToOut('ZkOS transfer (rotate)', '/api/relayer/zkaccount/transfer', {
    ...creds,
    accountIndex: row.index,
  });
  await runZkosListAccounts({ userAction: false, silentOut: true });
  await refreshZkosAccountAvailability();
  renderStrategiesTableFromCache();
  syncZkosInspector();
});

document.getElementById('btn-zkos-insp-withdraw-fill')?.addEventListener('click', () => {
  const row = getSelectedZkOsRow();
  const inp = document.getElementById('zkos-insp-withdraw-sats');
  if (!inp || !row) return;
  const n = parseZkOsRowBalanceSats(row);
  inp.value = n > 0 ? String(n) : '';
});

document.getElementById('btn-zkos-insp-withdraw')?.addEventListener('click', async () => {
  const row = getSelectedZkOsRow();
  if (!row) return;
  const creds = walletSession();
  if (!creds.walletId || !creds.password) {
    showDashboardWarning('Wallet + password required (step 1).', 'ZkOS');
    return;
  }
  const raw = document.getElementById('zkos-insp-withdraw-sats')?.value?.trim() ?? '';
  const amt = Math.floor(Number(raw.replace(/,/g, '')));
  if (!Number.isFinite(amt) || amt <= 0) {
    showDashboardWarning('Enter a positive withdraw amount in sats (or use Fill listed balance).', 'ZkOS');
    return;
  }
  if (
    !confirm(
      `Withdraw ${amt.toLocaleString()} sats from ZkOS index ${row.index} to this wallet’s on-chain (SATS) balance?`
    )
  ) {
    return;
  }
  await runZkosInspectorRelayerToOut('ZkOS withdraw', '/api/relayer/zkaccount/withdraw', {
    ...creds,
    accountIndex: row.index,
    amount: String(amt),
  });
  await runZkosListAccounts({ userAction: false, silentOut: true });
  await refreshZkosBalance({ userAction: false });
  syncZkosInspector();
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
document.getElementById('btn-test-binance-key')?.addEventListener('click', () =>
  testExchangeKey('binance')
);
document.getElementById('btn-test-bybit-key')?.addEventListener('click', () =>
  testExchangeKey('bybit')
);

document.getElementById('btn-strategies-refresh')?.addEventListener('click', () =>
  refreshStrategies({ userAction: true })
);
function onStrategiesCexFilterChange() {
  saveStrategiesCexFilterPrefs();
  renderStrategiesTableFromCache();
}
document.getElementById('chk-strategies-cex-binance')?.addEventListener('change', onStrategiesCexFilterChange);
document.getElementById('chk-strategies-cex-bybit')?.addEventListener('change', onStrategiesCexFilterChange);

document.getElementById('btn-trade-desk-refresh')?.addEventListener('click', () =>
  refreshTradeDesk({ userAction: true })
);

document.getElementById('btn-agent-run-once')?.addEventListener('click', async () => {
  const out = document.getElementById('agent-run-once-out');
  if (!out) return;
  out.hidden = false;
  out.textContent = 'Running…';
  try {
    const r = await readJson('/api/run-once', { method: 'POST' });
    out.textContent = JSON.stringify(r, null, 2);
    await refreshPnl({});
    await refreshTx({});
    await refreshTradeDesk({});
    await refreshStatus({ userAction: true });
  } catch (e) {
    const m = errMsg(e);
    out.textContent = m;
    showDashboardError(m, 'Run one cycle');
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
    const openCount = Array.isArray(lastOpenPositions) ? lastOpenPositions.length : 0;
    let closeAllFirst = false;
    if (openCount > 0) {
      closeAllFirst = confirm(
        `There are ${openCount} open position(s). Click OK to close all now, or Cancel to keep them open and stop monitoring.`
      );
    }
    if (closeAllFirst && openCount > 0) {
      const payload = {};
      const w = walletSession();
      if (w.walletId) payload.walletId = w.walletId;
      if (w.password) payload.password = w.password;
      const bulk = await readJson('/api/positions/close-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (bulk?.failed?.length) {
        const first = bulk.failed[0];
        const msg = `Close-all finished with ${bulk.closed?.length || 0} success, ${
          bulk.failed.length
        } failed. First failure: ${first?.tradeId || '?'} - ${first?.error || 'unknown error'}`;
        showDashboardWarning(msg, 'Close position');
      } else if (bulk?.closed?.length) {
        showDashboardSuccess(`Closed ${bulk.closed.length} position(s) before stopping monitor.`, 'Close position');
      }
    }
    await readJson('/api/monitor/stop', { method: 'POST' });
    await refreshPnl({ userAction: true });
    await refreshTradeDesk({ userAction: false });
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
    await loadAgentSettings({ userAction: false });
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
  relayerPost('/api/relayer/zkaccount/transfer', {
    accountIndex: document.getElementById('relayer-zk-from').value.trim(),
    ...walletSession(),
  });
});

document.getElementById('btn-relayer-open')?.addEventListener('click', () => {
  relayerPost('/api/relayer/order/open-trade', {
    accountIndex: document.getElementById('relayer-ot-acc').value.trim(),
    side: document.getElementById('relayer-ot-side').value,
    entryPrice: document.getElementById('relayer-ot-price').value.trim(),
    leverage: document.getElementById('relayer-ot-lev').value.trim(),
    orderType: 'MARKET',
    noWait: document.getElementById('relayer-ot-nowait').checked,
    ...walletSession(),
  });
});

document.getElementById('btn-relayer-close')?.addEventListener('click', () => {
  relayerPost('/api/relayer/order/close-trade', {
    accountIndex: document.getElementById('relayer-close-acc').value.trim(),
    noWait: document.getElementById('relayer-close-nowait').checked,
    ...walletSession(),
  });
});

document.getElementById('btn-relayer-cancel')?.addEventListener('click', () => {
  relayerPost('/api/relayer/order/cancel-trade', {
    accountIndex: document.getElementById('relayer-close-acc').value.trim(),
    ...walletSession(),
  });
});

document.getElementById('btn-relayer-unlock-close')?.addEventListener('click', () => {
  relayerPost('/api/relayer/order/unlock-close-order', {
    accountIndex: document.getElementById('relayer-close-acc').value.trim(),
    ...walletSession(),
  });
});

document.getElementById('btn-relayer-unlock-failed')?.addEventListener('click', () => {
  relayerPost('/api/relayer/order/unlock-failed-order', {
    accountIndex: document.getElementById('relayer-close-acc').value.trim(),
    ...walletSession(),
  });
});

document.getElementById('btn-relayer-import')?.addEventListener('click', () => {
  const mnemonic = document.getElementById('relayer-import-mnemonic').value.trim();
  relayerPost('/api/relayer/wallet/import', { ...walletSession(), mnemonic });
});

document.getElementById('btn-agentic-refresh-health')?.addEventListener('click', () => {
  refreshAgenticTrading({ userAction: true });
});
// Agentic required setup has no inputs; messages only.
document.getElementById('btn-agentic-spin-up')?.addEventListener('click', () => {
  spinUpAgentic();
});
document.getElementById('btn-agentic-process-stop')?.addEventListener('click', () => {
  stopAgenticProcess();
});
document.getElementById('btn-agentic-process-status')?.addEventListener('click', () => {
  refreshAgenticProcessStatus({ userAction: true });
});
document.getElementById('btn-agentic-process-command-send')?.addEventListener('click', () => {
  sendAgenticProcessCommand({ userAction: true });
});
document.getElementById('agentic-process-command')?.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  sendAgenticProcessCommand({ userAction: true });
});

document.getElementById('btn-agentic-bot-trades-refresh')?.addEventListener('click', () => {
  refreshBotTrades({ userAction: true });
});
document.getElementById('btn-agentic-bot-positions-refresh')?.addEventListener('click', () => {
  refreshBotPositions({ userAction: true });
});
document.getElementById('btn-agentic-bot-ticks-refresh')?.addEventListener('click', () => {
  refreshBotTicks({ userAction: true });
});
document.getElementById('btn-agentic-bot-close-position')?.addEventListener('click', () => {
  botClosePosition({ userAction: true });
});
document.getElementById('btn-agentic-bot-send-paper')?.addEventListener('click', () => {
  sendBotIntent({ live: false }, { userAction: true });
});
document.getElementById('btn-agentic-bot-send-live')?.addEventListener('click', () => {
  sendBotIntent({ live: true }, { userAction: true });
});
document.getElementById('btn-agentic-bot-kill-switch')?.addEventListener('click', () => {
  botKillSwitchGet({ userAction: true });
});
document.getElementById('btn-agentic-bot-kill-on')?.addEventListener('click', () => {
  botKillSwitchSet(true, { userAction: true });
});
document.getElementById('btn-agentic-bot-kill-off')?.addEventListener('click', () => {
  botKillSwitchSet(false, { userAction: true });
});
document.getElementById('btn-agentic-bot-caps')?.addEventListener('click', () => {
  botCapsGet({ userAction: true });
});
document.getElementById('btn-tb-params-autofill')?.addEventListener('click', () => {
  autofillTwilightBotParamsFromDashboard();
});
document.getElementById('btn-tb-params-save')?.addEventListener('click', () => {
  saveTwilightBotParams();
});

const tok = localStorage.getItem('dashboardToken');
const dashTokEl = document.getElementById('dash-token');
if (tok && dashTokEl) dashTokEl.value = tok;
const walletSessionModeEl = document.getElementById('wallet-session-mode');
if (walletSessionModeEl) walletSessionModeEl.value = getPersistedWalletSessionMode();
updateWalletSessionStatus();
const savedWalletSession = loadWalletSessionStorage();
if (savedWalletSession?.password) {
  const pw = document.getElementById('wallet-pass');
  if (pw) pw.value = savedWalletSession.password;
}

initDeskTabs();
initDashboardResultModal();
initCollapsibleSections();
initHelpTips();
initCopyButtons();
rebuildZkosTransferFromSelect();
syncZkosInspector();

refreshWalletList();
loadRelayerMetaHints();
loadExchangeStatus();
applyStrategiesCexFilterPrefsToUi();
refreshStrategies();
refreshTradeDesk();
loadRelayerMeta();
refreshEnv();
loadAgentSettings();
refreshStatus();
refreshAgenticTrading();
refreshPnl();
refreshTx();
refreshLogs();
loadConfig();

const intentTa = document.getElementById('agentic-bot-intent-json');
if (intentTa && !intentTa.value.trim()) {
  intentTa.value = JSON.stringify(
    {
      thesis: 'operator-issued via dashboard',
      legs: [{ venue: 'twilight', side: 'long', notional_usd: 25, leverage: 2, account_index: 0 }],
      exit: { rules: [] },
    },
    null,
    2
  );
}

refreshBotTrades();
refreshBotPositions();
refreshBotTicks();
refreshTwilightBotParams();

setInterval(refreshStatus, 4000);
setInterval(refreshAgenticTrading, 10000);

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

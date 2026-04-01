const api = (path, opts = {}) => {
  const headers = { ...opts.headers };
  const token = localStorage.getItem('dashboardToken');
  if (token) headers['x-dashboard-token'] = token;
  return fetch(path, { ...opts, headers });
};

async function readJson(path, opts) {
  const res = await api(path, opts);
  if (res.status === 401) {
    throw new Error('Unauthorized — set dashboard token if DASHBOARD_TOKEN is configured');
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  return res.json();
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

async function refreshStatus() {
  const el = document.getElementById('status-line');
  const last = document.getElementById('last-cycle');
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
    } else {
      last.textContent = '';
    }
    if (s.lastError) {
      last.textContent += ` · Error: ${s.lastError}`;
    }
  } catch (e) {
    el.textContent = e.message;
  }
}

async function refreshPnl() {
  const el = document.getElementById('pnl-stats');
  try {
    const p = await readJson('/api/pnl');
    el.innerHTML = `
      <dt>Transactions (persisted)</dt><dd>${p.transactionCount}</dd>
      <dt>Sum estimated daily USD</dt><dd>${fmtUsd(p.sumEstimatedDailyUsd)}</dd>
      <dt>Open notional (portfolio)</dt><dd>${fmtUsd(p.openNotionalUsd)}</dd>
    `;
  } catch (e) {
    el.innerHTML = `<dt>Error</dt><dd>${e.message}</dd>`;
  }
}

async function refreshTx() {
  const body = document.getElementById('tx-body');
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
        <td>${escapeHtml(t.mode || '')}</td>
      </tr>`
      )
      .join('');
    if (!transactions.length) {
      body.innerHTML = `<tr><td colspan="6">No transactions yet.</td></tr>`;
    }
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6">${escapeHtml(e.message)}</td></tr>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function refreshLogs() {
  const box = document.getElementById('log-box');
  try {
    const { logs } = await readJson('/api/logs');
    box.textContent = logs.map((l) => `[${l.t}] ${l.level.toUpperCase()} ${l.msg}`).join('\n');
  } catch (e) {
    box.textContent = e.message;
  }
}

async function loadConfig() {
  const ta = document.getElementById('config-yaml');
  const msg = document.getElementById('config-msg');
  msg.textContent = '';
  try {
    const c = await readJson('/api/config');
    ta.value = c.content;
  } catch (e) {
    msg.textContent = e.message;
  }
}

document.getElementById('btn-save-token').addEventListener('click', () => {
  const v = document.getElementById('dash-token').value.trim();
  if (v) localStorage.setItem('dashboardToken', v);
  else localStorage.removeItem('dashboardToken');
  refreshStatus();
});

document.getElementById('btn-start').addEventListener('click', async () => {
  try {
    await readJson('/api/monitor/start', { method: 'POST' });
    await refreshStatus();
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById('btn-stop').addEventListener('click', async () => {
  await readJson('/api/monitor/stop', { method: 'POST' });
  await refreshStatus();
});

document.getElementById('btn-sim-once').addEventListener('click', async () => {
  const out = document.getElementById('sim-out');
  out.textContent = 'Running…';
  try {
    const r = await readJson('/api/simulation/run-once', { method: 'POST' });
    out.textContent = JSON.stringify(r, null, 2);
    await refreshPnl();
    await refreshTx();
    await refreshStatus();
  } catch (e) {
    out.textContent = e.message;
  }
});

document.getElementById('btn-save-config').addEventListener('click', async () => {
  const msg = document.getElementById('config-msg');
  const content = document.getElementById('config-yaml').value;
  try {
    await readJson('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    msg.textContent = 'Saved.';
  } catch (e) {
    msg.textContent = e.message;
  }
});

document.getElementById('btn-reload-config').addEventListener('click', loadConfig);

document.getElementById('btn-refresh-tx').addEventListener('click', refreshTx);
document.getElementById('btn-refresh-logs').addEventListener('click', refreshLogs);

document.getElementById('btn-reset-portfolio').addEventListener('click', async () => {
  if (!confirm('Clear in-memory portfolio snapshot? Transaction history file is unchanged.')) return;
  await readJson('/api/portfolio/reset', { method: 'POST' });
  await refreshPnl();
  await refreshStatus();
});

setInterval(refreshStatus, 4000);
refreshStatus();
refreshPnl();
refreshTx();
refreshLogs();
loadConfig();

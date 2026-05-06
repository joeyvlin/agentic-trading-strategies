import { loadEnv } from '../agents/twilight-strategy-monitor/src/config.js';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerAgentSettingsRoutes } from './lib/agent-settings-routes.mjs';
import { createMonitorService } from './lib/monitor-service.mjs';
import { registerDashboardDataRoutes } from './lib/dashboard-data-routes.mjs';
import { registerEnvRoutes } from './lib/env-routes.mjs';
import { getOpenPositionsSnapshot, getPositionPnlSummary } from './lib/position-ledger.mjs';
import { executeFullPositionClose } from './lib/position-close-service.mjs';
import { runPositionAutoClosePass } from './lib/position-auto-close.mjs';
import { getTradeDeskSnapshot } from './lib/trade-desk.mjs';
import { registerRelayerRoutes } from './lib/relayer-routes.mjs';
import { sanitizeString } from './lib/relayer-cli.mjs';
import { getRepoRoot } from './lib/persistence.mjs';
import { registerTwilightBotRoutes } from './lib/twilight-bot-routes.mjs';

/** Load repo `.env` before anything reads `process.env` (e.g. TWILIGHT_RELAYER_CLI). */
loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = getRepoRoot();
const configFile = path.join(repoRoot, 'configs', 'agent.monitor.yaml');

const monitor = createMonitorService();
const app = express();
const PORT = Number(process.env.DASHBOARD_PORT) || 3847;
/** Unset = Node default bind (all interfaces; avoids IPv6 `localhost` vs `127.0.0.1` mismatches). */
const HOST = process.env.DASHBOARD_HOST?.trim() || '';
const TOKEN = process.env.DASHBOARD_TOKEN || '';

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));

function requireToken(req, res, next) {
  if (!TOKEN) return next();
  const h = req.headers['x-dashboard-token'];
  if (h !== TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing x-dashboard-token header' });
  }
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'agentic-trading-dashboard',
    apiVersion: 1,
    serverVersion: `dashboard-${process.pid}-${new Date().toISOString()}`,
  });
});

app.get('/api/status', requireToken, (_req, res) => {
  try {
    res.json(monitor.getStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/logs', requireToken, (_req, res) => {
  res.json({ logs: monitor.getLogs() });
});

app.get('/api/trade-desk', requireToken, async (req, res) => {
  try {
    const q = String(req.query.walletId || req.query.wallet_id || '').trim();
    const snap = await getTradeDeskSnapshot(q ? { walletId: q } : {});
    res.json(snap);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/api/pnl', requireToken, async (_req, res) => {
  try {
    const base = monitor.getPnlSummary();
    const ledger = await getPositionPnlSummary();
    res.json({
      ...base,
      realizedPnlUsd: ledger.realizedPnlUsd,
      unrealizedPnlUsd: ledger.unrealizedPnlUsd,
      currentBtcPrice: ledger.currentBtcPrice,
      openPositions: ledger.openPositions,
      closedPositions: ledger.closedPositions,
      openCount: ledger.openCount,
      closedCount: ledger.closedCount,
      pnlNote: ledger.pnlNote,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/positions/:tradeId/close', requireToken, async (req, res) => {
  const raw = req.body?.realizedPnlUsd;
  const empty =
    raw === undefined ||
    raw === null ||
    (typeof raw === 'string' && String(raw).trim() === '');
  let optRealized = null;
  if (!empty) {
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      return res.status(400).json({ error: 'realizedPnlUsd must be a number when provided' });
    }
    optRealized = v;
  }
  const wid = sanitizeString(req.body?.walletId ?? req.body?.wallet_id ?? '');
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  try {
    const out = await executeFullPositionClose(req.params.tradeId, {
      realizedPnlUsd: optRealized,
      walletId: wid,
      password: pw,
    });
    if (!out.ok) return res.status(404).json(out);
    res.json({ ok: true, realizedPnlUsd: out.realizedPnlUsd, venueSteps: out.venueSteps, mode: out.mode });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.post('/api/positions/close-all', requireToken, async (req, res) => {
  const wid = sanitizeString(req.body?.walletId ?? req.body?.wallet_id ?? '');
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  const rows = getOpenPositionsSnapshot();
  const out = {
    ok: true,
    requested: rows.length,
    closed: [],
    failed: [],
  };
  for (const row of rows) {
    const tradeId = String(row?.tradeId || '').trim();
    if (!tradeId) continue;
    try {
      const r = await executeFullPositionClose(tradeId, {
        walletId: wid,
        password: pw,
      });
      if (r?.ok) out.closed.push({ tradeId, mode: r.mode, realizedPnlUsd: r.realizedPnlUsd });
      else out.failed.push({ tradeId, error: r?.error || 'Close failed' });
    } catch (e) {
      out.failed.push({ tradeId, error: e.message || String(e) });
    }
  }
  out.ok = out.failed.length === 0;
  res.json(out);
});

app.post('/api/monitor/run-strategy', requireToken, async (req, res) => {
  const strategyId = req.body?.strategyId ?? req.body?.strategy_id;
  const mode = req.body?.mode;
  const rawTarget = req.body?.targetTotalNotionalUsd ?? req.body?.target_total_notional_usd;
  let targetTotalNotionalUsd;
  if (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') {
    const n = Number(rawTarget);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ error: 'targetTotalNotionalUsd must be a positive number' });
    }
    targetTotalNotionalUsd = n;
  }
  if (strategyId === undefined || strategyId === null || strategyId === '') {
    return res.status(400).json({ error: 'strategyId is required' });
  }
  try {
    const relayerEnv = {};
    const wid = sanitizeString(req.body?.walletId ?? req.body?.wallet_id ?? '');
    const pw = typeof req.body?.password === 'string' ? req.body.password : '';
    if (wid) relayerEnv.NYKS_WALLET_ID = wid;
    if (pw) relayerEnv.NYKS_WALLET_PASSPHRASE = pw;
    const rawTwIdx = req.body?.twilightAccountIndex ?? req.body?.TWILIGHT_ACCOUNT_INDEX;
    if (rawTwIdx != null && rawTwIdx !== '') {
      const s = String(rawTwIdx).trim();
      if (s && /^-?\d+$/.test(s)) relayerEnv.TWILIGHT_ACCOUNT_INDEX = s;
    }
    const runOpts =
      targetTotalNotionalUsd !== undefined || Object.keys(relayerEnv).length
        ? {
            ...(targetTotalNotionalUsd !== undefined ? { targetTotalNotionalUsd } : {}),
            ...(Object.keys(relayerEnv).length ? { relayerEnv } : {}),
          }
        : undefined;
    const result = await monitor.runStrategyOnce(strategyId, mode, runOpts ?? targetTotalNotionalUsd);
    res.json(result);
  } catch (e) {
    const msg = e.message || String(e);
    if (/CONFIRM_REAL_TRADING/i.test(msg)) {
      return res.status(403).json({
        error: msg,
        code: 'CONFIRM_REAL_TRADING_REQUIRED',
        hint:
          'Enable “Allow real trading” in Twilight wallet (step 1), or set CONFIRM_REAL_TRADING=YES in .env. The dashboard reloads env when you save from the UI; on Render set the variable on the service.',
      });
    }
    if (/\[ZKOS_PREFLIGHT\]/i.test(msg)) {
      return res.status(409).json({
        error: msg,
        code: 'ZKOS_ACCOUNT_REQUIRED',
        hint:
          'ZkOS preflight failed: fund/list accounts (step 3b), use a **Coin** (idle) index for opens, or fix the index. If the message mentions Memo, the chosen index is order-locked — pick another Coin row or rotate after close.',
      });
    }
    if (/Account is locked.*Memo|io type:\s*Memo/i.test(msg)) {
      return res.status(409).json({
        error: msg,
        code: 'ZKOS_MEMO_LOCKED',
        hint:
          'That ZkOS index is Memo (locked for new opens). In ZkOS step, list accounts, select a row with io_type Coin, then run again — the dashboard sends the index in the field with each real run. Saving .env is optional for defaults.',
      });
    }
    if (/\[CEX_MIN_NOTIONAL\]/i.test(msg)) {
      return res.status(400).json({
        error: msg.replace(/^\[CEX_MIN_NOTIONAL\]\s*/i, ''),
        code: 'CEX_MIN_NOTIONAL',
      });
    }
    res.status(500).json({ error: msg });
  }
});

app.get('/api/transactions', requireToken, (_req, res) => {
  res.json({ transactions: monitor.loadPersistedTransactions() });
});

app.post('/api/monitor/start', requireToken, async (_req, res) => {
  try {
    const out = await monitor.start();
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/monitor/stop', requireToken, (_req, res) => {
  res.json(monitor.stop());
});

app.post('/api/simulation/run-once', requireToken, async (_req, res) => {
  try {
    const result = await monitor.runSimulationOnce();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/run-once', requireToken, async (_req, res) => {
  try {
    const result = await monitor.runOnce();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/portfolio/reset', requireToken, (_req, res) => {
  res.json(monitor.resetPortfolio());
});

app.get('/api/config', requireToken, (_req, res) => {
  if (!fs.existsSync(configFile)) {
    return res.status(404).json({ error: 'configs/agent.monitor.yaml not found' });
  }
  const content = fs.readFileSync(configFile, 'utf8');
  res.json({ path: configFile, content });
});

app.put('/api/config', requireToken, (req, res) => {
  const content = req.body?.content ?? req.body?.yaml;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'Send JSON { "content": "yaml string" }' });
  }
  const tmp = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, configFile);
  res.json({ ok: true, path: configFile });
});

registerAgentSettingsRoutes(app, { requireToken });
registerRelayerRoutes(app, { requireToken });
registerDashboardDataRoutes(app, { requireToken });
registerEnvRoutes(app, { requireToken });
registerTwilightBotRoutes(app, { requireToken });

app.use(express.static(path.join(__dirname, 'public')));

const onListen = () => {
  const tokenNote = TOKEN ? 'token: required' : 'token: off';
  if (HOST) {
    console.log(`[dashboard] http://${HOST}:${PORT}  (${tokenNote})`);
  } else {
    console.log(
      `[dashboard] port ${PORT}  (${tokenNote}) — try http://127.0.0.1:${PORT} or http://localhost:${PORT}`
    );
  }
};
const _autoCloseMs = Number(process.env.POSITION_AUTO_CLOSE_INTERVAL_MS);
const AUTO_CLOSE_INTERVAL_MS =
  Number.isFinite(_autoCloseMs) && _autoCloseMs >= 15000 ? _autoCloseMs : 45000;
setInterval(() => {
  runPositionAutoClosePass().then((out) => {
    if (out.skipped || (!out.closed?.length && !out.errors?.length)) return;
    if (out.closed?.length) {
      for (const c of out.closed) {
        console.log(
          `[dashboard] position auto-close ${c.tradeId}: ${(c.reasons || []).join('; ')}`
        );
      }
    }
    if (out.errors?.length) {
      for (const e of out.errors) {
        console.warn(`[dashboard] position auto-close failed ${e.tradeId}: ${e.error}`);
      }
    }
  });
}, AUTO_CLOSE_INTERVAL_MS);

if (HOST) {
  app.listen(PORT, HOST, onListen);
} else {
  app.listen(PORT, onListen);
}

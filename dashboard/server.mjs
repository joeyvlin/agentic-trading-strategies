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
import { getPositionPnlSummary, closePosition } from './lib/position-ledger.mjs';
import { registerRelayerRoutes } from './lib/relayer-routes.mjs';
import { getRepoRoot } from './lib/persistence.mjs';

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

app.post('/api/positions/:tradeId/close', requireToken, (req, res) => {
  const v = req.body?.realizedPnlUsd;
  if (v === undefined || v === null || Number.isNaN(Number(v))) {
    return res.status(400).json({ error: 'Body must include realizedPnlUsd (number)' });
  }
  const out = closePosition(req.params.tradeId, Number(v));
  if (!out.ok) return res.status(404).json(out);
  res.json({ ok: true });
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
    const result = await monitor.runStrategyOnce(strategyId, mode, targetTotalNotionalUsd);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
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
if (HOST) {
  app.listen(PORT, HOST, onListen);
} else {
  app.listen(PORT, onListen);
}

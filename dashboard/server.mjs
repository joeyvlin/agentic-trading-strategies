import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createMonitorService } from './lib/monitor-service.mjs';
import { getRepoRoot } from './lib/persistence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = getRepoRoot();
const configFile = path.join(repoRoot, 'configs', 'agent.monitor.yaml');

const monitor = createMonitorService();
const app = express();
const PORT = Number(process.env.DASHBOARD_PORT) || 3847;
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const TOKEN = process.env.DASHBOARD_TOKEN || '';

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireToken(req, res, next) {
  if (!TOKEN) return next();
  const h = req.headers['x-dashboard-token'];
  if (h !== TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing x-dashboard-token header' });
  }
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'agentic-trading-dashboard' });
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

app.get('/api/pnl', requireToken, (_req, res) => {
  res.json(monitor.getPnlSummary());
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

app.listen(PORT, HOST, () => {
  console.log(
    `[dashboard] http://${HOST}:${PORT}  (token: ${TOKEN ? 'required' : 'off'})`
  );
});

import { URL } from 'url';
import {
  getTwilightBotProcessStatus,
  registerTwilightBotProcessShutdown,
  startTwilightBot,
  stopTwilightBot,
} from './twilight-bot-process.mjs';
import { cloneTwilightBotRepo } from './twilight-bot-repo.mjs';
import { spinUpTwilightBot } from './twilight-bot-spinup.mjs';

function sanitizeBaseUrl(raw) {
  const input = String(raw || '').trim() || 'http://127.0.0.1:8787';
  const u = new URL(input);
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

function timeoutMs() {
  const n = Number(process.env.TWILIGHT_BOT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 15000;
}

async function proxyTwilightBot(req, res, path, { method = 'GET', body } = {}) {
  const base = sanitizeBaseUrl(process.env.TWILIGHT_BOT_BASE_URL);
  const token = String(process.env.TWILIGHT_BOT_API_TOKEN || '').trim();
  const url = `${base}${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs());
  try {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: ctl.signal,
    });
    const text = await r.text();
    res.status(r.status);
    if (text && text.trim()) {
      res.type('application/json').send(text);
    } else {
      res.json({});
    }
  } catch (e) {
    const timedOut = e?.name === 'AbortError';
    res.status(502).json({
      error: timedOut ? 'twilight-bot request timed out' : e?.message || String(e),
      request: { method, url },
    });
  } finally {
    clearTimeout(timer);
  }
}

function boolFromQuery(v) {
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  return undefined;
}

/**
 * @param {import('express').Express} app
 * @param {{ requireToken: import('express').RequestHandler }} opts
 */
export function registerTwilightBotRoutes(app, { requireToken }) {
  registerTwilightBotProcessShutdown();

  app.get('/api/twilight-bot/process/status', requireToken, (_req, res) => {
    res.json(getTwilightBotProcessStatus());
  });

  app.post('/api/twilight-bot/process/start', requireToken, (req, res) => {
    const repoDir = String(req.body?.repoDir || req.body?.repo_dir || '').trim();
    const command = String(req.body?.command || '').trim();
    const out = startTwilightBot({
      ...(repoDir ? { repoDir } : {}),
      ...(command ? { command } : {}),
    });
    if (!out.ok) return res.status(400).json(out);
    res.json({ ...out, status: getTwilightBotProcessStatus() });
  });

  app.post('/api/twilight-bot/process/stop', requireToken, (req, res) => {
    const out = stopTwilightBot();
    if (!out.ok) return res.status(400).json(out);
    res.json({ ...out, status: getTwilightBotProcessStatus() });
  });

  app.post('/api/twilight-bot/repo/clone', requireToken, (req, res) => {
    const gitUrl = String(req.body?.gitUrl || req.body?.git_url || '').trim();
    const destDir = String(req.body?.destDir || req.body?.dest_dir || '').trim();
    const out = cloneTwilightBotRepo({
      ...(gitUrl ? { gitUrl } : {}),
      ...(destDir ? { destDir } : {}),
    });
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  });

  app.post('/api/twilight-bot/spin-up', requireToken, (_req, res) => {
    const out = spinUpTwilightBot();
    if (!out.ok) return res.status(400).json(out);
    res.json({ ...out, status: getTwilightBotProcessStatus() });
  });

  app.get('/api/twilight-bot/healthz', requireToken, async (req, res) => {
    await proxyTwilightBot(req, res, '/healthz');
  });

  app.get('/api/twilight-bot/market', requireToken, async (req, res) => {
    await proxyTwilightBot(req, res, '/market');
  });

  app.get('/api/twilight-bot/positions', requireToken, async (req, res) => {
    const venue = String(req.query.venue || '').trim();
    const qs = venue ? `?venue=${encodeURIComponent(venue)}` : '';
    await proxyTwilightBot(req, res, `/positions${qs}`);
  });

  app.get('/api/twilight-bot/strategies', requireToken, async (req, res) => {
    const qs = new URLSearchParams();
    const category = String(req.query.category || '').trim();
    const risk = String(req.query.risk || '').trim();
    const profitable = boolFromQuery(req.query.profitable);
    const minApy = String(req.query.minApy || '').trim();
    const limit = String(req.query.limit || '').trim();
    if (category) qs.set('category', category);
    if (risk) qs.set('risk', risk);
    if (profitable !== undefined) qs.set('profitable', String(profitable));
    if (minApy) qs.set('minApy', minApy);
    if (limit) qs.set('limit', limit);
    await proxyTwilightBot(req, res, `/strategies${qs.size ? `?${qs.toString()}` : ''}`);
  });

  app.get('/api/twilight-bot/trades', requireToken, async (req, res) => {
    const qs = new URLSearchParams();
    for (const key of ['q', 'since', 'limit']) {
      const v = String(req.query[key] || '').trim();
      if (v) qs.set(key, v);
    }
    await proxyTwilightBot(req, res, `/trades${qs.size ? `?${qs.toString()}` : ''}`);
  });

  app.get('/api/twilight-bot/ticks', requireToken, async (req, res) => {
    const qs = new URLSearchParams();
    for (const key of ['skill', 'since', 'status']) {
      const v = String(req.query[key] || '').trim();
      if (v) qs.set(key, v);
    }
    await proxyTwilightBot(req, res, `/ticks${qs.size ? `?${qs.toString()}` : ''}`);
  });

  app.post('/api/twilight-bot/trades/paper', requireToken, async (req, res) => {
    await proxyTwilightBot(req, res, '/trades/paper', { method: 'POST', body: req.body || {} });
  });

  app.post('/api/twilight-bot/trades/live', requireToken, async (req, res) => {
    await proxyTwilightBot(req, res, '/trades/live', { method: 'POST', body: req.body || {} });
  });

  app.post('/api/twilight-bot/positions/:positionId/close', requireToken, async (req, res) => {
    const id = encodeURIComponent(String(req.params.positionId || '').trim());
    await proxyTwilightBot(req, res, `/positions/${id}/close`, { method: 'POST', body: req.body || {} });
  });

  app.get('/api/twilight-bot/kill-switch', requireToken, async (req, res) => {
    await proxyTwilightBot(req, res, '/kill-switch');
  });

  app.put('/api/twilight-bot/kill-switch', requireToken, async (req, res) => {
    await proxyTwilightBot(req, res, '/kill-switch', { method: 'PUT', body: req.body || {} });
  });

  app.get('/api/twilight-bot/caps', requireToken, async (req, res) => {
    await proxyTwilightBot(req, res, '/caps');
  });

  app.put('/api/twilight-bot/caps', requireToken, async (req, res) => {
    await proxyTwilightBot(req, res, '/caps', { method: 'PUT', body: req.body || {} });
  });

  app.post('/api/twilight-bot/skills/:name/enable', requireToken, async (req, res) => {
    const name = encodeURIComponent(String(req.params.name || '').trim());
    await proxyTwilightBot(req, res, `/skills/${name}/enable`, { method: 'POST', body: req.body || {} });
  });

  app.post('/api/twilight-bot/skills/:name/disable', requireToken, async (req, res) => {
    const name = encodeURIComponent(String(req.params.name || '').trim());
    await proxyTwilightBot(req, res, `/skills/${name}/disable`, { method: 'POST', body: req.body || {} });
  });
}

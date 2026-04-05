import {
  maskedExchangeKeysForClient,
  saveExchangeKeys,
} from './exchange-keys-store.mjs';
import {
  appendTradeEntry,
  deleteTradeEntry,
  getTradeJournal,
} from './trade-journal-store.mjs';
import { getStrategyApiEnv } from './env-store.mjs';

/**
 * @param {import('express').Express} app
 * @param {{ requireToken: import('express').RequestHandler }} opts
 */
export function registerDashboardDataRoutes(app, { requireToken }) {
  const getExchangeKeys = (_req, res) => {
    res.json(maskedExchangeKeysForClient());
  };
  const putExchangeKeys = (req, res) => {
    try {
      const masked = saveExchangeKeys(req.body || {});
      res.json({ ok: true, ...masked });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  };
  // Primary path avoids "exchange" in the URL (some browser extensions block that substring).
  app.get('/api/venue-api-keys', requireToken, getExchangeKeys);
  app.put('/api/venue-api-keys', requireToken, putExchangeKeys);
  app.get('/api/exchange-keys', requireToken, getExchangeKeys);
  app.put('/api/exchange-keys', requireToken, putExchangeKeys);

  app.get('/api/trade-journal', requireToken, (_req, res) => {
    res.json(getTradeJournal());
  });

  app.post('/api/trade-journal', requireToken, (req, res) => {
    try {
      const entry = appendTradeEntry(req.body || {});
      res.json({ ok: true, entry });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.delete('/api/trade-journal/:id', requireToken, (req, res) => {
    const ok = deleteTradeEntry(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  });

  app.get('/api/strategies/best', requireToken, async (req, res) => {
    const { base, key } = getStrategyApiEnv();
    if (!key) {
      return res.status(503).json({
        error:
          'Set STRATEGY_API_KEY in .env (server-side only). STRATEGY_API_BASE_URL is optional.',
      });
    }
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15));
    const profitable = req.query.profitable !== 'false';
    const qs = new URLSearchParams({ limit: String(limit) });
    if (profitable) qs.set('profitable', 'true');
    const url = `${base}/api/strategies?${qs.toString()}`;
    try {
      const r = await fetch(url, { headers: { 'x-api-key': key } });
      const text = await r.text();
      if (!r.ok) {
        return res.status(502).json({ error: `Strategy API ${r.status}: ${text.slice(0, 400)}` });
      }
      res.json(JSON.parse(text));
    } catch (e) {
      res.status(502).json({ error: e.message || String(e) });
    }
  });
}

import { STRATEGY_API_EXAMPLE_KEY } from './env-catalog.mjs';
import { getEnvFileRawForApi, getEnvStateForApi, mergeAndWriteEnv } from './env-store.mjs';
import { loadEnv } from '../../agents/twilight-strategy-monitor/src/config.js';

/**
 * @param {import('express').Express} app
 * @param {{ requireToken: import('express').RequestHandler }} opts
 */
export function registerEnvRoutes(app, { requireToken }) {
  app.get('/api/env', requireToken, (_req, res) => {
    try {
      res.json(getEnvStateForApi());
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.get('/api/env/raw', requireToken, (_req, res) => {
    try {
      res.json(getEnvFileRawForApi());
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.put('/api/env', requireToken, (req, res) => {
    try {
      const updates = req.body?.updates ?? req.body ?? {};
      if (typeof updates !== 'object' || Array.isArray(updates)) {
        return res.status(400).json({ error: 'Send JSON { "updates": { "KEY": "value" } }' });
      }
      const state = mergeAndWriteEnv(updates, {});
      res.json({ ok: true, ...state });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post('/api/env/apply-preset', requireToken, (req, res) => {
    try {
      const preset = req.body?.preset;
      if (preset !== 'mainnet' && preset !== 'testnet') {
        return res.status(400).json({ error: 'preset must be "mainnet" or "testnet"' });
      }
      const applyExampleStrategyKey = !!req.body?.applyExampleStrategyKey;
      const state = mergeAndWriteEnv({}, { preset, applyExampleStrategyKey });
      res.json({ ok: true, ...state });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post('/api/env/apply-example-strategy-key', requireToken, (_req, res) => {
    try {
      const state = mergeAndWriteEnv({ STRATEGY_API_KEY: STRATEGY_API_EXAMPLE_KEY }, {});
      res.json({ ok: true, ...state });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post('/api/env/reload', requireToken, (_req, res) => {
    try {
      loadEnv();
      res.json({ ok: true, ...getEnvStateForApi() });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });
}

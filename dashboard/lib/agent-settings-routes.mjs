import { readAgentSettings, writeAgentSettings } from './agent-settings.mjs';

/**
 * @param {import('express').Express} app
 * @param {{ requireToken: import('express').RequestHandler }} opts
 */
export function registerAgentSettingsRoutes(app, { requireToken }) {
  app.get('/api/agent/settings', requireToken, (_req, res) => {
    try {
      res.json(readAgentSettings());
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.put('/api/agent/settings', requireToken, (req, res) => {
    try {
      const next = writeAgentSettings(req.body || {});
      res.json({ ok: true, settings: next });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });
}

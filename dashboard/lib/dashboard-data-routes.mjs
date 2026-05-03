import ccxt from 'ccxt';
import {
  loadExchangeKeys,
  maskedExchangeKeysForClient,
  saveExchangeKeys,
  updateExchangeKeyLastStatus,
} from './exchange-keys-store.mjs';
import { getStrategyApiEnv } from './env-store.mjs';

/**
 * @param {import('express').Express} app
 * @param {{ requireToken: import('express').RequestHandler }} opts
 */
export function registerDashboardDataRoutes(app, { requireToken }) {
  async function testVenueApiKey(venue) {
    const saved = loadExchangeKeys() || {};
    const v = saved[venue] || {};
    const apiKey = String(v.apiKey || '').trim();
    const apiSecret = String(v.apiSecret || '').trim();
    const useTestnet = !!v.useTestnet;
    if (!apiKey || !apiSecret) {
      const message = `No saved ${venue} key/secret yet. Save keys first in section 4.`;
      updateExchangeKeyLastStatus(venue, { ok: false, message });
      return { ok: false, venue, useTestnet, message };
    }
    try {
      if (venue === 'binance') {
        const ex = new ccxt.binanceusdm({
          apiKey,
          secret: apiSecret,
          enableRateLimit: true,
          options: { defaultType: 'future' },
        });
        if (useTestnet) ex.setSandboxMode(true);
        await ex.loadMarkets();
        await ex.fetchPositions();
      } else {
        const ex = new ccxt.bybit({
          apiKey,
          secret: apiSecret,
          enableRateLimit: true,
          options: { defaultType: 'swap' },
        });
        if (useTestnet) ex.setSandboxMode(true);
        await ex.loadMarkets();
        await ex.fetchPositions();
      }
      const message = `API key check OK (${venue}${useTestnet ? ' testnet' : ' mainnet'}).`;
      updateExchangeKeyLastStatus(venue, { ok: true, message });
      return { ok: true, venue, useTestnet, message };
    } catch (e) {
      const raw = e?.message || String(e);
      const hint =
        venue === 'binance' && /-2015/.test(raw)
          ? 'Enable Binance Futures + Read permissions, ensure testnet/mainnet matches, and update IP whitelist if enabled.'
          : undefined;
      const message = hint ? `${raw}\n${hint}` : raw;
      updateExchangeKeyLastStatus(venue, { ok: false, message });
      return { ok: false, venue, useTestnet, message };
    }
  }

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
  app.post('/api/venue-api-keys/test', requireToken, async (req, res) => {
    const venue = String(req.body?.venue || '').trim().toLowerCase();
    if (venue !== 'binance' && venue !== 'bybit') {
      return res.status(400).json({ error: 'venue must be "binance" or "bybit"' });
    }
    try {
      const result = await testVenueApiKey(venue);
      res.json({ ...result, keys: maskedExchangeKeysForClient() });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });
  app.get('/api/exchange-keys', requireToken, getExchangeKeys);
  app.put('/api/exchange-keys', requireToken, putExchangeKeys);

  app.post('/api/tx-status', requireToken, async (req, res) => {
    const txHash = String(req.body?.txHash || req.body?.tx_hash || '').trim();
    if (!txHash) return res.status(400).json({ error: 'txHash is required' });
    const lcdBase = String(process.env.NYKS_LCD_BASE_URL || '').trim() || 'https://lcd.twilight.rest';
    const url = `${lcdBase.replace(/\/+$/, '')}/cosmos/tx/v1beta1/txs/${encodeURIComponent(txHash)}`;
    try {
      const r = await fetch(url);
      const text = await r.text();
      if (!r.ok) {
        return res.status(502).json({
          error: `LCD ${r.status}: ${text.slice(0, 400)}`,
          request: { method: 'GET', url },
        });
      }
      let parsed = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      const txResponse = parsed?.tx_response || {};
      res.json({
        ok: true,
        txHash,
        lcdBase,
        height: txResponse.height,
        code: txResponse.code,
        txhash: txResponse.txhash,
        rawLog: txResponse.raw_log || txResponse.rawLog || '',
        timestamp: txResponse.timestamp || '',
      });
    } catch (e) {
      res.status(502).json({
        error: e.message || String(e),
        request: { method: 'GET', url },
      });
    }
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
    const requestMeta = { method: 'GET', url };
    try {
      const r = await fetch(url, { headers: { 'x-api-key': key } });
      const text = await r.text();
      if (!r.ok) {
        return res.status(502).json({
          error: `Strategy API ${r.status}: ${text.slice(0, 400)}`,
          request: requestMeta,
        });
      }
      res.json(JSON.parse(text));
    } catch (e) {
      res.status(502).json({
        error: e.message || String(e),
        request: requestMeta,
      });
    }
  });
}

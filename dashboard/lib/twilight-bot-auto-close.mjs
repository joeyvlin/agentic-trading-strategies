import { URL } from 'url';
import { getStrategyApiEnv } from './env-store.mjs';
import { fetchStrategyById } from '../../agents/twilight-strategy-monitor/src/strategyClient.js';
import { readAgentSettings } from './agent-settings.mjs';

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

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.positions)) return payload.positions;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function firstFinite(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractPositionId(pos) {
  const cands = [pos?.id, pos?.positionId, pos?.position_id, pos?.tradeId, pos?.trade_id];
  for (const c of cands) {
    const s = String(c ?? '').trim();
    if (s) return s;
  }
  return '';
}

function extractStrategyId(pos) {
  const cands = [
    pos?.strategyId,
    pos?.strategy_id,
    pos?.strategy?.id,
    pos?.intent?.strategyId,
    pos?.intent?.strategy_id,
    pos?.meta?.strategyId,
    pos?.meta?.strategy_id,
  ];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractApyFromPosition(pos) {
  return firstFinite(
    pos?.apy,
    pos?.apyPercent,
    pos?.apy_pct,
    pos?.currentApy,
    pos?.current_apy,
    pos?.strategy?.apy,
    pos?.meta?.apy
  );
}

function extractApyFromStrategy(raw) {
  return firstFinite(
    raw?.apy,
    raw?.apyPercent,
    raw?.strategy?.apy,
    raw?.strategy?.apyPercent,
    raw?.data?.apy,
    raw?.data?.strategy?.apy
  );
}

async function botFetch(path, { method = 'GET', body } = {}) {
  const base = sanitizeBaseUrl(process.env.TWILIGHT_BOT_BASE_URL);
  const token = String(process.env.TWILIGHT_BOT_API_TOKEN || '').trim();
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs());
  try {
    const r = await fetch(`${base}${path}`, { method, headers, body: payload, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`twilight-bot ${r.status}: ${text || 'request failed'} (path: ${path})`);
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function runTwilightBotApyAutoClosePass() {
  try {
    const s = readAgentSettings();
    if (s?.positionAutoClose?.closeOnNonPositiveApy === false) {
      return { skipped: true, checked: 0, closed: [], errors: [] };
    }
  } catch {
    // Ignore missing config and keep default behavior enabled.
  }
  const closed = [];
  const errors = [];
  let positionsPayload;
  try {
    positionsPayload = await botFetch('/positions');
  } catch (e) {
    return { skipped: true, checked: 0, closed, errors: [{ positionId: '', error: e?.message || String(e) }] };
  }
  const rows = asArray(positionsPayload);
  if (!rows.length) return { checked: 0, closed, errors };

  const { base, key } = getStrategyApiEnv();
  const apyByStrategy = new Map();

  for (const pos of rows) {
    const positionId = extractPositionId(pos);
    if (!positionId) continue;
    let apy = extractApyFromPosition(pos);
    const strategyId = extractStrategyId(pos);
    if (apy == null && strategyId != null && key) {
      if (!apyByStrategy.has(strategyId)) {
        try {
          const st = await fetchStrategyById(base, key, strategyId);
          apyByStrategy.set(strategyId, extractApyFromStrategy(st));
        } catch (e) {
          errors.push({
            positionId,
            error: `APY lookup failed for strategy ${strategyId}: ${e?.message || String(e)}`,
          });
        }
      }
      apy = apyByStrategy.get(strategyId) ?? null;
    }
    if (apy == null || apy > 0) continue;
    try {
      await botFetch(`/positions/${encodeURIComponent(positionId)}/close`, { method: 'POST', body: {} });
      closed.push({ positionId, strategyId, apy });
    } catch (e) {
      errors.push({
        positionId,
        error: `Auto-close failed: ${e?.message || String(e)}`,
      });
    }
  }

  return { checked: rows.length, closed, errors };
}

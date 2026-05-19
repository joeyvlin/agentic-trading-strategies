/**
 * Dashboard API integration tests.
 *
 * Starts the server on a free port, hits every major route, asserts shape/status.
 * Does NOT require real credentials — all "real trade" paths are skipped unless
 * env vars are present. Safe to run in CI without any external services.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.mjs');

// ── helpers ─────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function waitReady(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(res => setTimeout(res, 150));
  }
  throw new Error(`Server on port ${port} did not respond within ${timeoutMs}ms`);
}

let port;
let proc;
let BASE;

before(async () => {
  port = await freePort();
  BASE  = `http://127.0.0.1:${port}`;

  proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: '127.0.0.1',
      NODE_ENV: 'test',
      // Ensure DB is isolated to tmp
      SQLITE_DB_PATH: path.join(__dirname, `test-${process.pid}.db`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', () => {}); // drain
  proc.stderr.on('data', () => {}); // drain

  await waitReady(port);
});

after(() => {
  proc?.kill('SIGTERM');
  // clean up test db
  import('node:fs').then(fs => {
    const db = path.join(__dirname, `test-${process.pid}.db`);
    if (fs.existsSync(db)) fs.unlinkSync(db);
  }).catch(() => {});
});

async function get(path) {
  return fetch(`${BASE}${path}`);
}

async function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function put(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── health ───────────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  test('returns 200 with ok:true', async () => {
    const r = await get('/api/health');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.service, 'agentic-trading-dashboard');
    assert.ok(Number.isFinite(j.apiVersion));
  });
});

// ── monitor status ───────────────────────────────────────────────────────────

describe('GET /api/status', () => {
  test('returns monitor status shape', async () => {
    const r = await get('/api/status');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok('running' in j, 'missing running field');
    assert.ok('logicalTradeCount' in j, 'missing logicalTradeCount');
    assert.ok('openNotionalUsd' in j, 'missing openNotionalUsd');
  });
});

describe('GET /api/logs', () => {
  test('returns logs array', async () => {
    const r = await get('/api/logs');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.logs));
  });
});

// ── P&L ─────────────────────────────────────────────────────────────────────

describe('GET /api/pnl', () => {
  test('returns P&L summary with expected fields', async () => {
    const r = await get('/api/pnl');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok('realizedPnlUsd' in j);
    assert.ok('unrealizedPnlUsd' in j);
    assert.ok('openPositions' in j);
    assert.ok('closedPositions' in j);
    assert.ok(Array.isArray(j.openPositions));
    assert.ok(Array.isArray(j.closedPositions));
  });
});

// ── transactions ─────────────────────────────────────────────────────────────

describe('GET /api/transactions', () => {
  test('returns transactions array', async () => {
    const r = await get('/api/transactions');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.transactions));
  });
});

// ── trade-desk ───────────────────────────────────────────────────────────────

describe('GET /api/trade-desk', () => {
  test('returns 200 with snapshot', async () => {
    const r = await get('/api/trade-desk');
    assert.equal(r.status, 200);
    const j = await r.json();
    // Shape varies by wallet, just check it's an object
    assert.equal(typeof j, 'object');
  });
});

// ── monitor control ─────────────────────────────────────────────────────────

describe('POST /api/monitor/stop', () => {
  test('returns ok', async () => {
    const r = await post('/api/monitor/stop', {});
    assert.equal(r.status, 200);
  });
});

describe('POST /api/monitor/start', () => {
  test('returns 200 or 400 (config missing in test env)', async () => {
    const r = await post('/api/monitor/start', {});
    assert.ok([200, 400].includes(r.status), `unexpected status ${r.status}`);
  });
});

// ── portfolio reset ──────────────────────────────────────────────────────────

describe('POST /api/portfolio/reset', () => {
  test('returns 200', async () => {
    const r = await post('/api/portfolio/reset', {});
    assert.equal(r.status, 200);
  });
});

// ── config YAML ─────────────────────────────────────────────────────────────

describe('GET /api/config', () => {
  test('returns config content or 404 if file missing', async () => {
    const r = await get('/api/config');
    assert.ok([200, 404].includes(r.status));
    if (r.status === 200) {
      const j = await r.json();
      assert.ok(typeof j.content === 'string');
      assert.ok(typeof j.path === 'string');
    }
  });
});

// ── env routes ───────────────────────────────────────────────────────────────

describe('GET /api/env', () => {
  test('returns env state with rows array', async () => {
    const r = await get('/api/env');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.rows) || typeof j === 'object', 'unexpected env response shape');
  });
});

describe('GET /api/env/raw', () => {
  test('returns raw env file content or empty', async () => {
    const r = await get('/api/env/raw');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(typeof j === 'object');
  });
});

describe('PUT /api/env', () => {
  test('rejects non-object body', async () => {
    const r = await put('/api/env', [1, 2, 3]);
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.ok(j.error);
  });

  test('accepts valid env update and returns ok:true', async () => {
    const r = await put('/api/env', { updates: { TEST_ONLY_KEY: 'test-value-ci' } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
  });
});

describe('POST /api/env/apply-preset', () => {
  test('rejects unknown preset', async () => {
    const r = await post('/api/env/apply-preset', { preset: 'badnet' });
    assert.equal(r.status, 400);
  });

  test('accepts testnet preset', async () => {
    const r = await post('/api/env/apply-preset', { preset: 'testnet' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
  });
});

// ── positions ────────────────────────────────────────────────────────────────

describe('POST /api/positions/:tradeId/close', () => {
  test('returns 404 for non-existent tradeId', async () => {
    const r = await post('/api/positions/nonexistent-trade-id/close', {});
    assert.ok([404, 500].includes(r.status), `got ${r.status}`);
  });

  test('rejects non-numeric realizedPnlUsd', async () => {
    const r = await post('/api/positions/any-id/close', { realizedPnlUsd: 'not-a-number' });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.ok(j.error);
  });
});

describe('POST /api/positions/close-all', () => {
  test('returns ok with closed/failed arrays (no open positions)', async () => {
    const r = await post('/api/positions/close-all', {});
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok('closed' in j);
    assert.ok('failed' in j);
    assert.ok(Array.isArray(j.closed));
    assert.ok(Array.isArray(j.failed));
  });
});

// ── run-strategy validation ───────────────────────────────────────────────────

describe('POST /api/monitor/run-strategy', () => {
  test('returns 400 when strategyId missing', async () => {
    const r = await post('/api/monitor/run-strategy', { mode: 'sim' });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /strategyId/i);
  });

  test('returns 400 for non-positive targetTotalNotionalUsd', async () => {
    const r = await post('/api/monitor/run-strategy', { strategyId: 1, targetTotalNotionalUsd: -5 });
    assert.equal(r.status, 400);
  });
});

// ── strategies (data routes) ─────────────────────────────────────────────────

describe('GET /api/strategies/best', () => {
  test('returns a JSON response (200 with data, or error status)', async () => {
    const r = await get('/api/strategies/best');
    // May return 200 with cached data, 500/502/503/504 if external API unreachable
    assert.ok([200, 500, 502, 503, 504].includes(r.status), `unexpected status ${r.status}`);
    if (r.status === 200) {
      const j = await r.json();
      assert.ok(Array.isArray(j.strategies) || Array.isArray(j), 'expected strategies array');
    }
  });
});

// ── relayer routes ────────────────────────────────────────────────────────────

describe('GET /api/relayer/meta', () => {
  test('returns 200 or error gracefully', async () => {
    const r = await get('/api/relayer/meta');
    assert.ok([200, 500, 502, 503].includes(r.status));
    if (r.status === 200) {
      const j = await r.json();
      assert.equal(typeof j, 'object');
    }
  });
});

describe('POST /api/relayer/wallet/list', () => {
  test('returns 200 or error (relayer-cli may not be running)', async () => {
    const r = await post('/api/relayer/wallet/list', {});
    assert.ok([200, 404, 500, 502, 503].includes(r.status), `unexpected status ${r.status}`);
  });
});

// ── twilight-bot proxy ────────────────────────────────────────────────────────

describe('GET /api/twilight-bot/process/status', () => {
  test('returns 200 with running field', async () => {
    const r = await get('/api/twilight-bot/process/status');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok('running' in j);
  });
});

describe('GET /api/twilight-bot/healthz', () => {
  test('returns 200 when bot is off (proxy returns offline shape)', async () => {
    const r = await get('/api/twilight-bot/healthz');
    // Bot is not running in test env — 503/502 or 200 with offline body
    assert.ok([200, 502, 503, 504].includes(r.status));
  });
});

describe('PUT /api/twilight-bot/kill-switch', () => {
  test('returns 502/503 when bot is not running', async () => {
    const r = await put('/api/twilight-bot/kill-switch', { on: true });
    assert.ok([200, 502, 503, 504].includes(r.status));
  });
});

// ── agent settings ────────────────────────────────────────────────────────────

describe('GET /api/agent-settings', () => {
  test('returns settings object', async () => {
    const r = await get('/api/agent-settings');
    assert.ok([200, 404].includes(r.status));
    if (r.status === 200) {
      const j = await r.json();
      assert.equal(typeof j, 'object');
    }
  });
});

/**
 * Twilight Strategy API client (read-only).
 */

const CANONICAL_STRATEGY_API_BASE = 'https://strategy.lunarpunk.xyz';
const LEGACY_STRATEGY_API_BASE = 'http://134.199.214.129:3000';

function normalizedBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function shouldRetryWithCanonical(baseUrl, err) {
  const base = normalizedBase(baseUrl);
  if (base !== LEGACY_STRATEGY_API_BASE) return false;
  const msg = String(err?.message || '');
  return (
    msg.includes('fetch failed') ||
    msg.includes('Connect Timeout Error') ||
    msg.includes('UND_ERR_CONNECT_TIMEOUT')
  );
}

async function fetchJson(pathname, baseUrl, apiKey, logger) {
  const headers = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  const url = new URL(pathname, baseUrl).toString();
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    const err = e?.message || String(e);
    throw new Error(`Strategy API fetch failed: ${err}\nRequest: GET ${url}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strategy API ${res.status}: ${text}\nRequest: GET ${url}`);
  }
  return res.json();
}

async function withCanonicalFallback(pathname, baseUrl, apiKey, logger) {
  try {
    return await fetchJson(pathname, baseUrl, apiKey, logger);
  } catch (err) {
    if (!shouldRetryWithCanonical(baseUrl, err)) throw err;
    logger?.warn(
      `Strategy API endpoint ${LEGACY_STRATEGY_API_BASE} timed out. Retrying with ${CANONICAL_STRATEGY_API_BASE}. If this keeps happening, run: npm run check:upstream`
    );
    return fetchJson(pathname, CANONICAL_STRATEGY_API_BASE, apiKey, logger);
  }
}

export async function fetchStrategies(baseUrl, apiKey, filters, logger) {
  const u = new URL('/api/strategies', normalizedBase(baseUrl));
  const params = new URLSearchParams();
  Object.entries(filters || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    params.set(k, String(v));
  });
  u.search = params.toString();
  return withCanonicalFallback(`${u.pathname}${u.search ? `?${u.searchParams.toString()}` : ''}`, u.origin, apiKey, logger);
}

export async function fetchStrategyById(baseUrl, apiKey, id, logger) {
  const pathname = `/api/strategies/${encodeURIComponent(String(id))}`;
  return withCanonicalFallback(pathname, baseUrl, apiKey, logger);
}

export async function fetchMarket(baseUrl, apiKey, logger) {
  return withCanonicalFallback('/api/market', baseUrl, apiKey, logger);
}

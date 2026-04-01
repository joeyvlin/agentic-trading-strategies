/**
 * Twilight Strategy API client (read-only).
 */

export async function fetchStrategies(baseUrl, apiKey, filters, logger) {
  const u = new URL('/api/strategies', baseUrl);
  const params = new URLSearchParams();
  Object.entries(filters || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    params.set(k, String(v));
  });
  u.search = params.toString();

  const headers = {};
  if (apiKey) headers['x-api-key'] = apiKey;

  const res = await fetch(u.toString(), { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strategy API ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data;
}

export async function fetchMarket(baseUrl, apiKey, logger) {
  const u = new URL('/api/market', baseUrl);
  const headers = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  const res = await fetch(u.toString(), { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Market API ${res.status}: ${text}`);
  }
  return res.json();
}

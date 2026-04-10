/**
 * Testnet faucet HTTP — matches nyks-wallet `wallet/faucet.rs` (`/faucet`, `/mint`).
 */

function summarizeFaucetErrorBody(text) {
  const raw = String(text || '').trim();
  if (!raw) return '(empty body)';
  try {
    const j = JSON.parse(raw);
    if (typeof j.message === 'string' && j.message.trim()) return j.message.trim();
    if (typeof j.error === 'string' && j.error.trim()) return j.error.trim();
    if (typeof j.msg === 'string' && j.msg.trim()) return j.msg.trim();
  } catch {
    /* plain text */
  }
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}

export async function postFaucet(baseUrl, path, recipientAddress) {
  const root = String(baseUrl).replace(/\/$/, '');
  const url = `${root}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ recipientAddress }),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = summarizeFaucetErrorBody(text);
    throw new Error(`${path} → HTTP ${res.status}: ${detail}`);
  }
  return { status: res.status, body: text };
}

export function requestNyksTokens(baseUrl, recipientAddress) {
  return postFaucet(baseUrl, '/faucet', recipientAddress);
}

export function requestTestSats(baseUrl, recipientAddress) {
  return postFaucet(baseUrl, '/mint', recipientAddress);
}

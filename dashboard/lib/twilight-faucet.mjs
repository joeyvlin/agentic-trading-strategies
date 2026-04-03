/**
 * Testnet faucet HTTP — matches nyks-wallet `wallet/faucet.rs` (`/faucet`, `/mint`).
 */

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
    throw new Error(`Faucet ${path} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return { status: res.status, body: text };
}

export function requestNyksTokens(baseUrl, recipientAddress) {
  return postFaucet(baseUrl, '/faucet', recipientAddress);
}

export function requestTestSats(baseUrl, recipientAddress) {
  return postFaucet(baseUrl, '/mint', recipientAddress);
}

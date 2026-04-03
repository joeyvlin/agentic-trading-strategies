/**
 * Parse human-oriented relayer-cli stdout for dashboard use.
 */

export function parseTwilightAddressFromBalanceStdout(stdout) {
  const m = String(stdout).match(/Address:\s*(\S+)/);
  return m ? m[1] : null;
}

/**
 * Parses `wallet list` table output (wallet list ignores JSON flag).
 */
export function parseWalletListStdout(stdout) {
  const lines = String(stdout).split('\n');
  let pastSep = false;
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^[-]{10,}/.test(t)) {
      pastSep = true;
      continue;
    }
    if (!pastSep) continue;
    const trimmed = line.trimEnd();
    const parts = trimmed.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [walletId, createdAt] = parts;
    if (walletId === 'WALLET ID' || walletId.startsWith('Total:')) continue;
    out.push({ walletId, createdAt });
  }
  return out;
}

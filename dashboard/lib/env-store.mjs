import fs from 'fs';
import path from 'path';
import { getRepoRoot } from './persistence.mjs';
import { loadEnv } from '../../agents/twilight-strategy-monitor/src/config.js';
import {
  ENV_DEFS,
  ENV_GROUPS,
  PRESET_EXTRA_NOTES,
  PRESET_MAINNET,
  PRESET_SOURCE_BLURB,
  PRESET_TESTNET,
  STRATEGY_API_EXAMPLE_KEY,
} from './env-catalog.mjs';

function envPath() {
  return path.join(getRepoRoot(), '.env');
}

function parseEnvLine(line) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const eq = t.indexOf('=');
  if (eq <= 0) return null;
  const key = t.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let val = t.slice(eq + 1).trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return [key, val];
}

export function readEnvFile() {
  const p = envPath();
  if (!fs.existsSync(p)) return {};
  const text = fs.readFileSync(p, 'utf8');
  const entries = {};
  for (const line of text.split('\n')) {
    const parsed = parseEnvLine(line);
    if (parsed) entries[parsed[0]] = parsed[1];
  }
  return entries;
}

const DEFAULT_STRATEGY_API_BASE = 'http://134.199.214.129:3000';

/**
 * Strategy API URL + key: use non-empty `process.env`, else values from repo `.env` on disk.
 * Covers dotenv not overriding an empty exported `STRATEGY_*` in the shell.
 */
export function getStrategyApiEnv() {
  const file = readEnvFile();
  const baseRaw =
    process.env.STRATEGY_API_BASE_URL || file.STRATEGY_API_BASE_URL || DEFAULT_STRATEGY_API_BASE;
  const base = String(baseRaw).replace(/\/$/, '');
  let key = process.env.STRATEGY_API_KEY;
  if (key == null || String(key).trim() === '') {
    key = file.STRATEGY_API_KEY || '';
  }
  key = String(key).trim();
  return { base, key };
}

/** Raw file text for the dashboard "view .env" action (same auth as other /api/env routes). */
export function getEnvFileRawForApi() {
  const p = envPath();
  if (!fs.existsSync(p)) {
    return { path: p, content: '', exists: false };
  }
  return { path: p, content: fs.readFileSync(p, 'utf8'), exists: true };
}

export function guessRelayerBinaryPath() {
  try {
    const root = getRepoRoot();
    const sibling = path.join(path.dirname(root), 'nyks-wallet', 'target', 'release', 'relayer-cli');
    if (fs.existsSync(sibling)) return sibling;
  } catch {
    /* ignore */
  }
  return '';
}

function escapeEnvValue(v) {
  if (/[\s#"']/.test(v)) return `"${String(v).replace(/"/g, '\\"')}"`;
  return String(v);
}

/**
 * Write merged env object. Known keys first (catalog order), then unknown keys.
 */
export function writeEnvFile(merged) {
  const knownOrder = ENV_DEFS.map((d) => d.key);
  const knownSet = new Set(knownOrder);
  const lines = [];
  lines.push('# Environment — managed from dashboard (Control desk → Environment)');
  lines.push('# Do not commit this file.');
  lines.push('');

  const pushPair = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    lines.push(`${k}=${escapeEnvValue(String(v))}`);
  };

  for (const k of knownOrder) pushPair(k, merged[k]);
  for (const [k, v] of Object.entries(merged)) {
    if (knownSet.has(k)) continue;
    pushPair(k, v);
  }

  const content = lines.join('\n') + '\n';
  const p = envPath();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* windows */
  }
  loadEnv();
}

export function maskSecret(key, value) {
  if (value === undefined || value === null || value === '') {
    return { hasValue: false, value: '', masked: false, hint: '' };
  }
  const def = ENV_DEFS.find((d) => d.key === key);
  const secret =
    def?.secret || /SECRET|PASSPHRASE|TOKEN|API_KEY/i.test(key);
  const s = String(value);
  if (!secret) return { hasValue: true, value: s, masked: false, hint: '' };
  return {
    hasValue: true,
    value: '',
    masked: true,
    hint: s.length > 4 ? `saved (…${s.slice(-4)})` : '(saved)',
  };
}

export function getEnvStateForApi() {
  const entries = readEnvFile();
  const relayerGuess = guessRelayerBinaryPath();
  const rows = ENV_DEFS.map((def) => {
    const raw = entries[def.key];
    const m = maskSecret(def.key, raw);
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      help: def.help,
      secret: !!def.secret,
      type: def.type || 'text',
      options: def.options,
      hideFromEnvForm: !!def.hideFromEnvForm,
      hasValue: m.hasValue,
      value: m.masked ? '' : m.value,
      masked: m.masked,
      hint: m.hint,
    };
  });
  const unknown = Object.keys(entries).filter((k) => !ENV_DEFS.find((d) => d.key === k));
  const setCount = rows.filter((r) => r.hasValue).length;
  const unsetKeys = rows.filter((r) => !r.hasValue).map((r) => r.key);
  /** Omit empty FAUCET from mainnet object for display — merge removes that key on apply. */
  const mainnetPresetDisplay = { ...PRESET_MAINNET };
  delete mainnetPresetDisplay.FAUCET_BASE_URL;
  return {
    groups: ENV_GROUPS,
    envPath: envPath(),
    relayerGuess,
    entries: rows,
    unknownKeys: unknown,
    stats: {
      total: rows.length,
      set: setCount,
      unset: unsetKeys.length,
      unsetKeys,
    },
    presetMeta: {
      sourceBlurb: PRESET_SOURCE_BLURB,
      notes: PRESET_EXTRA_NOTES,
      /** Keys and values written when you click Apply (mainnet omits FAUCET row; that key is removed on disk). */
      values: {
        testnet: PRESET_TESTNET,
        mainnet: mainnetPresetDisplay,
      },
      mainnetFaucetBehavior:
        'On mainnet apply, any existing `FAUCET_BASE_URL` line is removed from `.env` (not set to an empty string in the merged write).',
    },
  };
}

/**
 * @param {Record<string, string>} updates
 * @param {{ preset?: 'mainnet'|'testnet', applyExampleStrategyKey?: boolean }} opts
 */
export function mergeAndWriteEnv(updates = {}, opts = {}) {
  let merged = { ...readEnvFile() };

  if (opts.preset === 'mainnet') {
    merged = { ...merged, ...PRESET_MAINNET };
    delete merged.FAUCET_BASE_URL;
  } else if (opts.preset === 'testnet') {
    merged = { ...merged, ...PRESET_TESTNET };
  }

  if (opts.applyExampleStrategyKey) {
    merged.STRATEGY_API_KEY = STRATEGY_API_EXAMPLE_KEY;
  }

  const guess = guessRelayerBinaryPath();
  if (!merged.TWILIGHT_RELAYER_CLI && guess) merged.TWILIGHT_RELAYER_CLI = guess;
  if (!merged.RELAYER_PROGRAM_JSON_PATH) merged.RELAYER_PROGRAM_JSON_PATH = './relayerprogram.json';

  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    if (v === '' || v === null) {
      delete merged[k];
    } else {
      merged[k] = String(v);
    }
  }

  writeEnvFile(merged);
  return getEnvStateForApi();
}

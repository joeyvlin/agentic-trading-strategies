import { spawn } from 'child_process';
import { execSync } from 'child_process';
import fs from 'fs';
import { URL } from 'url';
import { getDefaultTwilightBotRepoDir } from './twilight-bot-paths.mjs';
import { getRepoRoot } from './persistence.mjs';

const MAX_LOG_LINES = 120;
const BOT_STATE_FILE = `${getRepoRoot()}/data/twilight-bot-process.json`;

/** @type {import('child_process').ChildProcess | null} */
let child = null;
let startedAt = null;
/** @type {number | null} */
let lastExitCode = null;
/** @type {number | null} */
let lastPid = null;

const logs = [];

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePortFromBaseUrl() {
  try {
    const raw = String(process.env.TWILIGHT_BOT_BASE_URL || '').trim() || 'http://127.0.0.1:8787';
    const u = new URL(raw);
    const host = String(u.hostname || '').trim().toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost') return null;
    if (u.port) {
      const p = Number(u.port);
      return Number.isFinite(p) && p > 0 ? p : null;
    }
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function getListenerPidForPort(port) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return null;
  try {
    const out = execSync(`lsof -nP -iTCP:${p} -sTCP:LISTEN -Fp`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const pidLine = String(out || '')
      .split(/\r?\n/)
      .find((line) => line.startsWith('p'));
    if (!pidLine) return null;
    const pid = Number(pidLine.slice(1));
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function detectExternalBotProcess() {
  const base = String(process.env.TWILIGHT_BOT_BASE_URL || '').trim() || 'http://127.0.0.1:8787';
  const port = parsePortFromBaseUrl();
  if (!port) return null;
  const pid = getListenerPidForPort(port);
  if (!pid || !isPidAlive(pid)) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1200);
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/healthz`, { signal: ctl.signal });
    if (!r.ok) return null;
    return { pid, source: 'port-healthz', baseUrl: base };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function loadPersistedState() {
  if (!fs.existsSync(BOT_STATE_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(BOT_STATE_FILE, 'utf8'));
    const pid = Number(raw?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      pid,
      startedAt: typeof raw?.startedAt === 'string' ? raw.startedAt : null,
      repoDir: typeof raw?.repoDir === 'string' ? raw.repoDir : null,
      command: typeof raw?.command === 'string' ? raw.command : null,
    };
  } catch {
    return null;
  }
}

function persistState({ pid, startedAt, repoDir, command }) {
  try {
    fs.mkdirSync(`${getRepoRoot()}/data`, { recursive: true });
    fs.writeFileSync(
      BOT_STATE_FILE,
      JSON.stringify({ pid: Number(pid), startedAt, repoDir, command, savedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {
    /* ignore */
  }
}

function clearPersistedState() {
  try {
    if (fs.existsSync(BOT_STATE_FILE)) fs.unlinkSync(BOT_STATE_FILE);
  } catch {
    /* ignore */
  }
}

function pushLog(stream, text) {
  const line = String(text || '').trim();
  if (!line) return;
  logs.push(`[${stream}] ${line}`);
  if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
}

function requireSpawnAllowed() {
  return null;
}

function isProcessRunning(proc) {
  if (!proc) return false;
  return proc.exitCode === null && proc.signalCode == null;
}

export async function getTwilightBotProcessStatus() {
  const envRepo = String(process.env.TWILIGHT_BOT_REPO_DIR || '').trim();
  const configuredRepoDir = envRepo || getDefaultTwilightBotRepoDir();
  const configuredCommand = String(process.env.TWILIGHT_BOT_SPAWN || 'npm start').trim() || 'npm start';
  const attachedRunning = isProcessRunning(child);
  const persisted = attachedRunning ? null : loadPersistedState();
  const detected = attachedRunning || persisted ? null : await detectExternalBotProcess();
  const externalRunning = !attachedRunning && (persisted ? isPidAlive(persisted.pid) : !!detected);
  const externalPid = persisted?.pid || detected?.pid || null;
  const running = attachedRunning || externalRunning;
  const pid = attachedRunning && child ? child.pid : externalRunning ? externalPid : null;
  const started = attachedRunning ? startedAt : externalRunning ? persisted?.startedAt || null : null;
  const repoDir = externalRunning ? persisted?.repoDir || configuredRepoDir : configuredRepoDir;
  const command = externalRunning ? persisted?.command || configuredCommand : configuredCommand;
  return {
    running,
    attached: attachedRunning,
    managed: attachedRunning || externalRunning,
    external: !attachedRunning && externalRunning,
    pid: pid ?? null,
    startedAt: started,
    lastPid,
    lastExitCode,
    spawnAllowed: process.env.TWILIGHT_BOT_ALLOW_DASHBOARD_SPAWN === 'YES',
    repoDir: repoDir || null,
    repoDirFromEnv: envRepo || null,
    repoDirExists: repoDir ? fs.existsSync(repoDir) : false,
    command,
    recentLogs: [...logs],
  };
}

function wireChild(proc) {
  child = proc;
  startedAt = new Date().toISOString();
  lastExitCode = null;
  lastPid = proc.pid ?? null;
  persistState({ pid: proc.pid ?? null, startedAt, repoDir: null, command: null });

  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) pushLog('stdout', line);
  });
  proc.stderr?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) pushLog('stderr', line);
  });
  proc.on('exit', (code, signal) => {
    lastExitCode = code ?? (signal ? -1 : null);
    lastPid = proc.pid ?? lastPid;
    pushLog('sys', `exited code=${code} signal=${signal || ''}`.trim());
    child = null;
    startedAt = null;
    clearPersistedState();
  });
  proc.on('error', (err) => {
    pushLog('sys', err?.message || String(err));
    child = null;
    startedAt = null;
    clearPersistedState();
  });
}

/**
 * @param {{ repoDir?: string, command?: string }=} overrides
 */
export function startTwilightBot(overrides = {}) {
  const gate = requireSpawnAllowed();
  if (gate) return { ok: false, error: gate };
  if (isProcessRunning(child)) {
    return { ok: false, error: 'twilight-bot process already running (pid ' + child.pid + ')' };
  }

  const repoDir = String(overrides.repoDir || process.env.TWILIGHT_BOT_REPO_DIR || '').trim() || getDefaultTwilightBotRepoDir();
  if (!repoDir) {
    return { ok: false, error: 'Could not resolve twilight-bot directory (set TWILIGHT_BOT_REPO_DIR or add submodule at external/twilight-bot).' };
  }
  if (!fs.existsSync(repoDir)) {
    return { ok: false, error: `TWILIGHT_BOT_REPO_DIR does not exist: ${repoDir}` };
  }

  const command = String(overrides.command || process.env.TWILIGHT_BOT_SPAWN || 'npm start').trim() || 'npm start';

  let proc;
  try {
    proc = spawn(command, {
      cwd: repoDir,
      env: { ...process.env },
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }

  wireChild(proc);
  persistState({ pid: proc.pid ?? null, startedAt, repoDir, command });
  pushLog('sys', `spawned pid=${proc.pid} cwd=${repoDir} cmd=${command}`);
  return { ok: true, pid: proc.pid, cwd: repoDir, command };
}

export async function stopTwilightBot() {
  if (isProcessRunning(child) && child) {
    try {
      child.kill('SIGTERM');
      pushLog('sys', 'sent SIGTERM');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  const persisted = loadPersistedState();
  if (persisted?.pid && isPidAlive(persisted.pid)) {
    try {
      process.kill(persisted.pid, 'SIGTERM');
      pushLog('sys', `sent SIGTERM to external pid=${persisted.pid}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  const detected = await detectExternalBotProcess();
  if (detected?.pid && isPidAlive(detected.pid)) {
    try {
      process.kill(detected.pid, 'SIGTERM');
      pushLog('sys', `sent SIGTERM to detected external pid=${detected.pid}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  return { ok: false, error: 'twilight-bot is not running from this dashboard' };
}

/**
 * @param {string} command
 * @param {{ appendNewline?: boolean }=} opts
 */
export function sendTwilightBotCommand(command, opts = {}) {
  if (!isProcessRunning(child) || !child) {
    const persisted = loadPersistedState();
    if (persisted?.pid && isPidAlive(persisted.pid)) {
      return {
        ok: false,
        error: 'twilight-bot is running but not attached to this dashboard process; restart via dashboard spin-up to enable stdin commands',
      };
    }
    return { ok: false, error: 'twilight-bot is not running from this dashboard' };
  }
  const raw = String(command || '');
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'command is required' };
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
    return { ok: false, error: 'twilight-bot stdin is not writable' };
  }
  const appendNewline = opts.appendNewline !== false;
  const toSend = appendNewline ? `${raw.replace(/\r?\n$/, '')}\n` : raw;
  try {
    child.stdin.write(toSend);
    pushLog('stdin', trimmed);
    return { ok: true, sent: trimmed, pid: child.pid ?? null };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

let shutdownHooked = false;

export function registerTwilightBotProcessShutdown() {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const down = () => {
    if (isProcessRunning(child) && child) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  };
  process.on('SIGTERM', down);
  process.on('SIGINT', down);
}

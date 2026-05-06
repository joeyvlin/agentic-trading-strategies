import { spawn } from 'child_process';
import fs from 'fs';
import { getDefaultTwilightBotRepoDir } from './twilight-bot-paths.mjs';

const MAX_LOG_LINES = 120;

/** @type {import('child_process').ChildProcess | null} */
let child = null;
let startedAt = null;
/** @type {number | null} */
let lastExitCode = null;
/** @type {number | null} */
let lastPid = null;

const logs = [];

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

export function getTwilightBotProcessStatus() {
  const envRepo = String(process.env.TWILIGHT_BOT_REPO_DIR || '').trim();
  const repoDir = envRepo || getDefaultTwilightBotRepoDir();
  const command = String(process.env.TWILIGHT_BOT_SPAWN || 'npm start').trim() || 'npm start';
  const running = isProcessRunning(child);
  return {
    running,
    pid: running && child ? child.pid : null,
    startedAt: running ? startedAt : null,
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
  });
  proc.on('error', (err) => {
    pushLog('sys', err?.message || String(err));
    child = null;
    startedAt = null;
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
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }

  wireChild(proc);
  pushLog('sys', `spawned pid=${proc.pid} cwd=${repoDir} cmd=${command}`);
  return { ok: true, pid: proc.pid, cwd: repoDir, command };
}

export function stopTwilightBot() {
  if (!isProcessRunning(child) || !child) {
    return { ok: false, error: 'twilight-bot is not running from this dashboard' };
  }
  try {
    child.kill('SIGTERM');
    pushLog('sys', 'sent SIGTERM');
    return { ok: true };
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

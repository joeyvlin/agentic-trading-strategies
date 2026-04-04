import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import { getRepoRoot } from './persistence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAYER_PTY_HELPER = path.join(__dirname, 'relayer-pty-helper.py');

/**
 * relayer-cli `wallet create` prints the mnemonic via `print_secret_to_tty` (opens /dev/tty).
 * Node's default spawn (piped stdio) leaves no controlling TTY → macOS errno 6 "Device not configured".
 * We run relayer under a real PTY via Python `pty.fork()` (works without a parent TTY), then node-pty,
 * then the system `script` utility.
 */
function pseudoTtySpawnArgs(bin, argv) {
  const platform = os.platform();
  if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') {
    const scriptBin = fs.existsSync('/usr/bin/script') ? '/usr/bin/script' : 'script';
    return { file: scriptBin, args: ['-q', '/dev/null', bin, ...argv] };
  }
  if (platform === 'linux') {
    const scriptBin = fs.existsSync('/usr/bin/script') ? '/usr/bin/script' : 'script';
    const q = (s) => {
      const x = String(s);
      if (/^[a-zA-Z0-9/._@-]+$/.test(x)) return x;
      return `'${x.replace(/'/g, `'\\''`)}'`;
    };
    const cmdline = [q(bin), ...argv.map(q)].join(' ');
    return { file: scriptBin, args: ['-q', '-e', '-c', cmdline, '/dev/null'] };
  }
  return null;
}

/**
 * Resolve relayer-cli: env TWILIGHT_RELAYER_CLI, then sibling `../nyks-wallet/target/release/relayer-cli`, else PATH.
 */
export function getRelayerBinary() {
  const fromEnv = process.env.TWILIGHT_RELAYER_CLI;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  try {
    const root = getRepoRoot();
    const sibling = path.join(path.dirname(root), 'nyks-wallet', 'target', 'release', 'relayer-cli');
    if (fs.existsSync(sibling)) return sibling;
  } catch {
    /* ignore */
  }
  return 'relayer-cli';
}

function resolveRelayerExecutable(bin) {
  const b = String(bin || '').trim();
  if (!b) return b;
  try {
    if (path.isAbsolute(b) && fs.existsSync(b)) return fs.realpathSync(b);
  } catch {
    return b;
  }
  try {
    const line = execFileSync('which', [b], { encoding: 'utf8' }).trim().split('\n')[0];
    if (line) return line;
  } catch {
    /* ignore */
  }
  return b;
}

function findPythonWithPty() {
  for (const cmd of ['python3', 'python']) {
    try {
      execFileSync(cmd, ['-c', 'import pty'], { stdio: 'ignore' });
      return cmd;
    } catch {
      /* try next */
    }
  }
  return null;
}

function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function runRelayerCliPipe(argv, bin, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`relayer-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        ok: code === 0,
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runRelayerCliWithPty(argv, cwd, timeoutMs) {
  const bin = getRelayerBinary();
  const resolved = resolveRelayerExecutable(bin);
  const runCwd = cwd || process.cwd();
  const platform = os.platform();

  if (platform !== 'win32' && fs.existsSync(RELAYER_PTY_HELPER)) {
    const py = findPythonWithPty();
    if (py) {
      const helperArgv = [RELAYER_PTY_HELPER, runCwd, resolved, ...argv];
      try {
        return await runRelayerCliPipe(helperArgv, py, runCwd, timeoutMs);
      } catch (e) {
        if (process.env.DASHBOARD_DEBUG_RELAYER_TTY === '1') {
          console.warn('[dashboard] Python PTY helper failed, trying fallbacks:', e?.message || e);
        }
      }
    }
  }

  let ptySpawn;
  try {
    const mod = await import('node-pty');
    ptySpawn = typeof mod.spawn === 'function' ? mod.spawn : mod.default?.spawn;
  } catch {
    ptySpawn = null;
  }
  if (ptySpawn && platform !== 'win32' && fs.existsSync('/bin/bash')) {
    const inner = `exec ${shSingleQuote(resolved)} ${argv.map(shSingleQuote).join(' ')}`;
    let proc;
    try {
      proc = ptySpawn('/bin/bash', ['-c', inner], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: runCwd,
        env: { ...process.env },
      });
    } catch {
      proc = null;
    }
    if (proc) {
      return ptyProcessToResult(proc, timeoutMs);
    }
  }
  if (ptySpawn) {
    let proc;
    try {
      proc = ptySpawn(resolved, argv, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: runCwd,
        env: { ...process.env },
      });
    } catch {
      proc = null;
    }
    if (proc) {
      return ptyProcessToResult(proc, timeoutMs);
    }
  }

  const ttyWrap = pseudoTtySpawnArgs(resolved, argv);
  if (!ttyWrap) {
    throw new Error(
      'Wallet create needs a pseudo-TTY: ensure Python 3 is installed, or run `relayer-cli wallet create` in a terminal, or use wallet import.'
    );
  }
  return runRelayerCliPipe(ttyWrap.args, ttyWrap.file, runCwd, timeoutMs);
}

function ptyProcessToResult(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`relayer-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.onData((d) => {
      stdout += d.toString();
    });
    proc.onExit((e) => {
      clearTimeout(timer);
      const code = e.exitCode;
      const c = typeof code === 'number' ? code : -1;
      resolve({ code: c, ok: c === 0, stdout, stderr: '' });
    });
  });
}

/**
 * Run relayer-cli with argv. Uses repo cwd + process.env (incl. .env loaded by monitor).
 * Passwords are never logged.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string; timeoutMs?: number; allocatePseudoTty?: boolean }} [options]
 */
export function runRelayerCli(argv, options = {}) {
  const bin = getRelayerBinary();
  const cwd = options.cwd;
  const timeoutMs = options.timeoutMs ?? 120000;
  if (options.allocatePseudoTty) {
    return runRelayerCliWithPty(argv, cwd, timeoutMs);
  }
  return runRelayerCliPipe(argv, bin, cwd, timeoutMs);
}

export function sanitizeString(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\0/g, '').trim();
}

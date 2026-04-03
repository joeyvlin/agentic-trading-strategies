import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getRepoRoot } from './persistence.mjs';

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

/**
 * Run relayer-cli with argv. Uses repo cwd + process.env (incl. .env loaded by monitor).
 * Passwords are never logged.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string; timeoutMs?: number }} [options]
 */
export function runRelayerCli(argv, options = {}) {
  const bin = getRelayerBinary();
  const cwd = options.cwd;
  const timeoutMs = options.timeoutMs ?? 120000;

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

export function sanitizeString(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\0/g, '').trim();
}

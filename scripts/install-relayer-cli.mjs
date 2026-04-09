#!/usr/bin/env node
/**
 * Optional relayer-cli bootstrap for deploys where you cannot SSH in.
 *
 * Resolution order:
 * 1. SKIP_RELAYER_CLI_INSTALL=1 → no-op
 * 2. TWILIGHT_RELAYER_CLI points at an existing file → no-op
 * 3. tools/relayer-cli already exists → no-op
 * 4. RELAYER_CLI_URL → download (HTTPS) to tools/relayer-cli
 * 5. RELAYER_CLI_BUILD=1 and cargo in PATH → git clone nyks-wallet + cargo build --release --bin relayer-cli
 * 6. Else: print hint, exit 0 (do not fail npm install)
 */
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const binPath = path.join(repoRoot, 'tools', 'relayer-cli');

function log(...a) {
  console.log('[install-relayer-cli]', ...a);
}

function warn(...a) {
  console.warn('[install-relayer-cli]', ...a);
}

function ensureToolsDir() {
  const dir = path.dirname(binPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        return download(new URL(loc, url).href, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} → HTTP ${res.statusCode}`));
        return;
      }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => {
        f.close((err) => (err ? reject(err) : resolve()));
      });
    }).on('error', reject);
  });
}

function hasCargo() {
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildWithCargo() {
  if (!hasGit()) {
    warn('RELAYER_CLI_BUILD=1 but git not found');
    return false;
  }
  if (!hasCargo()) {
    warn('RELAYER_CLI_BUILD=1 but cargo not found');
    return false;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nyks-wallet-'));
  const cloneDir = path.join(work, 'nyks-wallet');
  log('cloning nyks-wallet →', cloneDir);
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/twilight-project/nyks-wallet.git', cloneDir], {
    stdio: 'inherit',
  });
  log('cargo build --release --bin relayer-cli (this may take several minutes)');
  execFileSync('cargo', ['build', '--release', '--bin', 'relayer-cli'], {
    cwd: cloneDir,
    stdio: 'inherit',
    env: { ...process.env },
  });
  const built = path.join(cloneDir, 'target', 'release', 'relayer-cli');
  if (!fs.existsSync(built)) {
    warn('Build finished but binary not found at', built);
    return false;
  }
  ensureToolsDir();
  fs.copyFileSync(built, binPath);
  fs.chmodSync(binPath, 0o755);
  log('installed →', binPath);
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return true;
}

async function main() {
  if (process.env.SKIP_RELAYER_CLI_INSTALL === '1') {
    log('SKIP_RELAYER_CLI_INSTALL=1 — skipping');
    return;
  }
  const envPath = process.env.TWILIGHT_RELAYER_CLI?.trim();
  if (envPath && fs.existsSync(envPath)) {
    log('TWILIGHT_RELAYER_CLI already set to an existing file');
    return;
  }
  if (fs.existsSync(binPath)) {
    try {
      fs.chmodSync(binPath, 0o755);
    } catch {
      /* ignore */
    }
    log('already present:', binPath);
    return;
  }

  const url = process.env.RELAYER_CLI_URL?.trim();
  if (url) {
    ensureToolsDir();
    log('downloading RELAYER_CLI_URL →', binPath);
    try {
      await download(url, binPath);
      fs.chmodSync(binPath, 0o755);
      log('downloaded OK');
    } catch (e) {
      warn('download failed:', e.message || e);
    }
    return;
  }

  if (process.env.RELAYER_CLI_BUILD === '1') {
    buildWithCargo();
    return;
  }

  warn(
    'No relayer-cli installed. Options: (1) set RELAYER_CLI_URL to a HTTPS URL of a Linux relayer-cli binary, ' +
      '(2) set RELAYER_CLI_BUILD=1 with cargo+git+build deps, (3) set TWILIGHT_RELAYER_CLI in .env, ' +
      '(4) use the repo Dockerfile on Render. See docs/deploy-relayer.md'
  );
}

main().catch((e) => {
  warn('error:', e.message || e);
  process.exitCode = 0;
});

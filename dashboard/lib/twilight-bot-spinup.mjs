import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getRepoRoot } from './persistence.mjs';
import { mergeAndWriteEnv } from './env-store.mjs';
import { getDefaultTwilightBotRepoDir, TWILIGHT_BOT_SUBMODULE_REL } from './twilight-bot-paths.mjs';
import { startTwilightBot } from './twilight-bot-process.mjs';
import { STRATEGY_API_EXAMPLE_KEY } from './env-catalog.mjs';

function requireSpawnAllowed() {
  return null;
}

function gitmodulesListsSubmodule() {
  const p = path.join(getRepoRoot(), '.gitmodules');
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, 'utf8');
  return (
    text.includes(`path = ${TWILIGHT_BOT_SUBMODULE_REL}`) ||
    text.includes(`path=${TWILIGHT_BOT_SUBMODULE_REL}`)
  );
}

/**
 * Init submodule (if this repo uses it), npm install, then spawn `npm start`.
 * Uses `TWILIGHT_BOT_REPO_DIR` when set; otherwise `<repo>/external/twilight-bot`.
 */
export function spinUpTwilightBot() {
  const gate = requireSpawnAllowed();
  if (gate) return { ok: false, error: gate, steps: [] };

  const repoRoot = getRepoRoot();
  const defaultDir = getDefaultTwilightBotRepoDir();
  const envDir = String(process.env.TWILIGHT_BOT_REPO_DIR || '').trim();
  const target = path.resolve(envDir || defaultDir);
  const useSubmodulePath = !envDir || path.resolve(envDir) === path.resolve(defaultDir);

  /** @type {{ step: string, ok: boolean, detail?: string }[]} */
  const steps = [];

  if (String(process.env.TWILIGHT_BOT_ALLOW_DASHBOARD_SPAWN || '').trim().toUpperCase() !== 'YES') {
    try {
      mergeAndWriteEnv({ TWILIGHT_BOT_ALLOW_DASHBOARD_SPAWN: 'YES' });
      steps.push({
        step: 'enable one-click run',
        ok: true,
        detail: 'wrote TWILIGHT_BOT_ALLOW_DASHBOARD_SPAWN=YES to main .env',
      });
    } catch (e) {
      steps.push({
        step: 'enable one-click run',
        ok: false,
        detail: e?.message || String(e),
      });
      return { ok: false, error: 'Could not enable one-click run in .env', steps };
    }
  }

  const strategyApiKey = String(process.env.STRATEGY_API_KEY || '').trim();
  if (!strategyApiKey) {
    try {
      mergeAndWriteEnv({ STRATEGY_API_KEY: STRATEGY_API_EXAMPLE_KEY });
      steps.push({
        step: 'set STRATEGY_API_KEY (example)',
        ok: true,
        detail: 'was missing; wrote documented example key to main .env (replace for production)',
      });
    } catch (e) {
      steps.push({
        step: 'set STRATEGY_API_KEY (example)',
        ok: false,
        detail: e?.message || String(e),
      });
      return {
        ok: false,
        error: 'STRATEGY_API_KEY missing and could not auto-write example key to .env',
        steps,
      };
    }
  }

  if (useSubmodulePath && gitmodulesListsSubmodule()) {
    const r = spawnSync('git', ['submodule', 'update', '--init', '--depth', '1', TWILIGHT_BOT_SUBMODULE_REL], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 300000,
      env: { ...process.env },
    });
    const detail = [r.stderr, r.stdout].filter(Boolean).join('\n').trim().slice(0, 4000);
    steps.push({
      step: 'git submodule update --init',
      ok: r.status === 0,
      detail: detail || `(exit ${r.status})`,
    });
    if (r.status !== 0) {
      return {
        ok: false,
        error: 'git submodule update failed — run `git submodule update --init` from the repo root or clone with --recurse-submodules',
        steps,
      };
    }
  } else {
    steps.push({
      step: 'git submodule update --init',
      ok: true,
      detail: useSubmodulePath
        ? 'skipped (no .gitmodules entry — not using bundled submodule path)'
        : 'skipped (TWILIGHT_BOT_REPO_DIR points outside default submodule)',
    });
  }

  if (!fs.existsSync(target)) {
    return {
      ok: false,
      error: `twilight-bot directory missing: ${target}`,
      steps,
    };
  }

  const pkg = path.join(target, 'package.json');
  if (!fs.existsSync(pkg)) {
    return {
      ok: false,
      error: `No package.json in ${target} — submodule not checked out or wrong path`,
      steps,
    };
  }

  const npm = spawnSync('npm', ['install'], {
    cwd: target,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 600000,
    env: { ...process.env },
  });
  const npmDetail = [npm.stderr, npm.stdout].filter(Boolean).join('\n').trim().slice(0, 4000);
  steps.push({
    step: 'npm install',
    ok: npm.status === 0,
    detail: npmDetail || `(exit ${npm.status})`,
  });
  if (npm.status !== 0) {
    return { ok: false, error: 'npm install failed in twilight-bot directory', steps };
  }

  const build = spawnSync('npm', ['run', 'build'], {
    cwd: target,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 300000,
    env: { ...process.env },
  });
  const buildDetail = [build.stderr, build.stdout].filter(Boolean).join('\n').trim().slice(0, 4000);
  steps.push({
    step: 'npm run build',
    ok: build.status === 0,
    detail: buildDetail || `(exit ${build.status})`,
  });
  if (build.status !== 0) {
    return { ok: false, error: 'npm run build failed (twilight-bot needs dist/ before npm start)', steps };
  }

  try {
    if (!envDir) {
      mergeAndWriteEnv({ TWILIGHT_BOT_REPO_DIR: target });
    }
  } catch (e) {
    steps.push({
      step: 'write TWILIGHT_BOT_REPO_DIR',
      ok: false,
      detail: e?.message || String(e),
    });
  }

  const start = startTwilightBot({ repoDir: target });
  steps.push({
    step: 'spawn process',
    ok: start.ok,
    detail: start.ok ? `pid ${start.pid}` : start.error,
  });
  if (!start.ok) {
    return { ok: false, error: start.error, steps };
  }

  return { ok: true, steps, pid: start.pid, repoDir: target };
}

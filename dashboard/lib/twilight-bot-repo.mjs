import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getRepoRoot } from './persistence.mjs';
import { getDefaultTwilightBotRepoDir } from './twilight-bot-paths.mjs';
import { mergeAndWriteEnv } from './env-store.mjs';

const DEFAULT_GIT_URL = 'https://github.com/runnerelectrode/twilight-bot.git';

/** Only https GitHub clone URLs (no credentials in URL). */
export function isAllowedTwilightBotGitUrl(url) {
  const u = String(url || '').trim();
  return /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/i.test(u);
}

function requireCloneAllowed() {
  if (process.env.TWILIGHT_BOT_ALLOW_DASHBOARD_CLONE !== 'YES') {
    return 'Set TWILIGHT_BOT_ALLOW_DASHBOARD_CLONE=YES in .env to enable cloning from the dashboard.';
  }
  return null;
}

/**
 * Clone twilight-bot into TWILIGHT_BOT_REPO_DIR if set, else `<repo>/external/twilight-bot`.
 * Writes TWILIGHT_BOT_REPO_DIR to `.env` on success.
 * @param {{ gitUrl?: string, destDir?: string }=} opts
 */
export function cloneTwilightBotRepo(opts = {}) {
  const gate = requireCloneAllowed();
  if (gate) return { ok: false, error: gate };

  const gitUrl = String(opts.gitUrl || process.env.TWILIGHT_BOT_GIT_URL || DEFAULT_GIT_URL).trim();
  if (!isAllowedTwilightBotGitUrl(gitUrl)) {
    return {
      ok: false,
      error:
        'Clone URL must be an https://github.com/org/repo or org/repo.git URL (no embedded credentials). Set TWILIGHT_BOT_GIT_URL.',
    };
  }

  const dest = path.resolve(String(opts.destDir || process.env.TWILIGHT_BOT_REPO_DIR || getDefaultTwilightBotRepoDir()).trim());
  const parent = path.dirname(dest);
  const base = path.basename(dest);

  if (!base || base === '.' || base === path.sep) {
    return { ok: false, error: 'Invalid clone destination path.' };
  }

  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Could not create parent directory: ${e?.message || e}` };
  }

  if (fs.existsSync(dest)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dest);
    } catch {
      /* ignore */
    }
    if (entries.length > 0) {
      return {
        ok: false,
        error: `Destination already exists and is not empty: ${dest}. Remove it or set TWILIGHT_BOT_REPO_DIR to a new path.`,
      };
    }
    try {
      fs.rmSync(dest, { recursive: true });
    } catch (e) {
      return { ok: false, error: `Could not clear empty destination: ${e?.message || e}` };
    }
  }

  const r = spawnSync('git', ['clone', '--depth', '1', gitUrl, dest], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180000,
    env: { ...process.env },
    cwd: parent,
  });

  if (r.status !== 0) {
    const err = [r.stderr, r.stdout].filter(Boolean).join('\n').trim() || `git exited ${r.status}`;
    return { ok: false, error: err, gitUrl, dest };
  }

  try {
    mergeAndWriteEnv({ TWILIGHT_BOT_REPO_DIR: dest });
  } catch (e) {
    return {
      ok: false,
      error: `Cloned to ${dest} but failed to write TWILIGHT_BOT_REPO_DIR to .env: ${e?.message || e}`,
      gitUrl,
      dest,
    };
  }

  return { ok: true, gitUrl, dest, message: 'Clone complete; TWILIGHT_BOT_REPO_DIR written to .env.' };
}

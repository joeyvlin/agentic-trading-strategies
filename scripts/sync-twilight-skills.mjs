#!/usr/bin/env node
/**
 * Verify or refresh verbatim mirrors under skills/twilight-protocol-agentskill/
 * from twilight-project/agentskill and twilight-project/nyks-wallet.
 *
 * Usage (from repo root):
 *   node scripts/sync-twilight-skills.mjs           # default: --check
 *   node scripts/sync-twilight-skills.mjs --check # exit 1 if any file differs
 *   node scripts/sync-twilight-skills.mjs --apply # overwrite mirrors; update SHAs in UPSTREAM_SYNC.md
 *
 * Requires: git, network (clone).
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(REPO_ROOT, 'skills', 'twilight-protocol-agentskill');
const UPSTREAM_SYNC = path.join(SKILL_DIR, 'UPSTREAM_SYNC.md');

const CLONES = {
  agentskill: {
    url: 'https://github.com/twilight-project/agentskill.git',
    /** @type {string|null} */
    dir: null,
  },
  nyks_wallet: {
    url: 'https://github.com/twilight-project/nyks-wallet.git',
    dir: null,
  },
};

/** @type {{ key: keyof typeof CLONES; src: string; dest: string[] }[]} */
const MIRRORS = [
  {
    key: 'agentskill',
    src: '.claude/skills/twilight-trader.md',
    dest: ['reference-trader.md'],
  },
  {
    key: 'agentskill',
    src: '.claude/skills/twilight-strategies.md',
    dest: ['reference-strategies.md'],
  },
  {
    key: 'nyks_wallet',
    src: 'docs/relayer-cli.md',
    dest: ['reference-relayer-cli-full.md'],
  },
  {
    key: 'nyks_wallet',
    src: 'docs/cli-command-rules.md',
    dest: ['reference-cli-command-rules-full.md'],
  },
  {
    key: 'nyks_wallet',
    src: 'docs/order-lifecycle.md',
    dest: ['reference-order-lifecycle-full.md'],
  },
  {
    key: 'nyks_wallet',
    src: 'docs/btc-onboarding.md',
    dest: ['reference-btc-onboarding-full.md', 'reference-btc-onboarding.md'],
  },
];

function ensureClone(tmp, key) {
  const c = CLONES[key];
  if (c.dir) return c.dir;
  const dir = path.join(tmp, key);
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync('git', ['clone', '--depth', '1', c.url, dir], { stdio: 'inherit' });
  c.dir = dir;
  return dir;
}

function revParse(repoDir) {
  return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function filesEqual(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function updateUpstreamSyncMd(agentskillSha, nyksSha, modeLabel) {
  let text = fs.readFileSync(UPSTREAM_SYNC, 'utf8');
  const stamp = new Date().toISOString();
  const block = `Commits last verified (UTC ${stamp}, ${modeLabel}):

- \`twilight-project/agentskill\`: \`${agentskillSha}\`
- \`twilight-project/nyks-wallet\`: \`${nyksSha}\`
`;
  if (/<!-- SYNC_SHAS_START -->/.test(text)) {
    text = text.replace(
      /<!-- SYNC_SHAS_START -->[\s\S]*?<!-- SYNC_SHAS_END -->/,
      `<!-- SYNC_SHAS_START -->\n${block}<!-- SYNC_SHAS_END -->`
    );
  } else {
    text += `\n<!-- SYNC_SHAS_START -->\n${block}<!-- SYNC_SHAS_END -->\n`;
  }
  fs.writeFileSync(UPSTREAM_SYNC, text, 'utf8');
}

function main() {
  const apply = process.argv.includes('--apply');

  if (!fs.existsSync(SKILL_DIR)) {
    console.error(`Missing skill dir: ${SKILL_DIR}`);
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-skills-'));
  try {
    for (const key of Object.keys(CLONES)) {
      ensureClone(tmp, /** @type {keyof typeof CLONES} */ (key));
    }

    const agentskillDir = CLONES.agentskill.dir;
    const nyksDir = CLONES.nyks_wallet.dir;
    const agentskillSha = revParse(agentskillDir);
    const nyksSha = revParse(nyksDir);

    const drift = [];

    for (const m of MIRRORS) {
      const root = m.key === 'agentskill' ? agentskillDir : nyksDir;
      const src = path.join(root, m.src);
      if (!fs.existsSync(src)) {
        drift.push({ reason: 'missing-upstream', src, dest: m.dest[0] });
        continue;
      }
      for (const name of m.dest) {
        const dest = path.join(SKILL_DIR, name);
        if (!fs.existsSync(dest) || !filesEqual(src, dest)) {
          drift.push({ reason: 'diff', src, dest });
        }
      }
    }

    if (apply) {
      let missing = false;
      for (const m of MIRRORS) {
        const root = m.key === 'agentskill' ? agentskillDir : nyksDir;
        const src = path.join(root, m.src);
        if (!fs.existsSync(src)) {
          console.error(`[apply] Missing upstream file: ${src}`);
          missing = true;
          continue;
        }
        for (const name of m.dest) {
          const dest = path.join(SKILL_DIR, name);
          fs.copyFileSync(src, dest);
          console.log(`[apply] ${m.src} → ${name}`);
        }
      }
      if (missing) process.exit(1);
      if (fs.existsSync(UPSTREAM_SYNC)) {
        updateUpstreamSyncMd(agentskillSha, nyksSha, 'apply');
        console.log(`[apply] Updated SHAs in UPSTREAM_SYNC.md`);
      } else {
        console.warn(`[apply] No ${path.basename(UPSTREAM_SYNC)} — add it to record SHAs.`);
      }
      console.log(`[apply] Done. agentskill @ ${agentskillSha} · nyks-wallet @ ${nyksSha}`);
      return;
    }

    if (drift.length) {
      console.error(`[sync-twilight-skills] Drift detected (${drift.length} issue(s)):`);
      for (const d of drift) {
        console.error(`  - ${d.reason}: ${path.basename(d.src)} → ${path.relative(REPO_ROOT, d.dest)}`);
      }
      console.error('\nRun: npm run skills:apply   (or node scripts/sync-twilight-skills.mjs --apply)');
      process.exit(1);
    }

    console.log(`[sync-twilight-skills] OK — mirrors match upstream (check).`);
    console.log(`  agentskill @ ${agentskillSha}`);
    console.log(`  nyks-wallet @ ${nyksSha}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();

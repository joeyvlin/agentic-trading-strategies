#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const LOCAL_BASE_CANDIDATES = [
  path.join(repoRoot, 'configs', 'env.example'),
  path.join(repoRoot, 'skills', 'twilight-protocol-agentskill', 'SKILL.md'),
];

const UPSTREAM_URL =
  'https://raw.githubusercontent.com/twilight-project/agentskill/main/README.md';

function firstHttpsUrl(text) {
  const m = text.match(/https:\/\/[^\s`")]+/);
  return m ? m[0] : '';
}

function readLocalBases() {
  const values = [];
  for (const p of LOCAL_BASE_CANDIDATES) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    const fromEnv = text.match(/STRATEGY_API_BASE_URL=([^\s#]+)/);
    if (fromEnv?.[1]) values.push(fromEnv[1].trim());
    const fromDoc = text.match(/Strategy API\s*\|\s*`([^`]+)`/);
    if (fromDoc?.[1]) values.push(fromDoc[1].trim());
    const fromBase = text.match(/\*\*Base\*\*:\s*`([^`]+)`/);
    if (fromBase?.[1]) values.push(fromBase[1].trim());
  }
  return [...new Set(values.filter(Boolean))];
}

async function main() {
  const localBases = readLocalBases();
  if (localBases.length === 0) {
    console.log('Could not detect local Strategy API base.');
    process.exit(1);
  }

  const res = await fetch(UPSTREAM_URL);
  if (!res.ok) {
    console.log(`Failed to fetch upstream skill README: HTTP ${res.status}`);
    process.exit(1);
  }
  const text = await res.text();
  const upstreamBase = firstHttpsUrl(
    text.split('**Base URL**:').slice(1).join('**Base URL**:')
  );

  if (!upstreamBase) {
    console.log('Could not detect upstream Strategy API base URL.');
    process.exit(1);
  }

  const mismatch = localBases.every((v) => v !== upstreamBase);
  console.log(`Upstream Strategy API base: ${upstreamBase}`);
  console.log(`Local detected base(s): ${localBases.join(', ')}`);

  if (mismatch) {
    console.log(
      'Mismatch detected. Update STRATEGY_API_BASE_URL and local Twilight skill references.'
    );
    process.exit(2);
  }

  console.log('Local defaults match upstream.');
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { getRepoRoot } from './persistence.mjs';

function configPath() {
  return path.join(getRepoRoot(), 'configs', 'agent.monitor.yaml');
}

export function readAgentSettings() {
  const p = configPath();
  if (!fs.existsSync(p)) {
    throw new Error('configs/agent.monitor.yaml not found');
  }
  const raw = fs.readFileSync(p, 'utf8');
  const doc = yaml.load(raw) || {};
  return {
    pollIntervalMs: Number(doc.pollIntervalMs ?? 60000),
    strategyFilters: doc.strategyFilters || { profitable: true, limit: 5 },
    risk: doc.risk || {},
    execution: doc.execution || { mode: 'simulation' },
    automation: doc.automation || {},
    positionAutoClose: doc.positionAutoClose || {},
  };
}

/**
 * Shallow merge into agent.monitor.yaml (comments are not preserved).
 */
export function writeAgentSettings(partial) {
  const p = configPath();
  const raw = fs.readFileSync(p, 'utf8');
  const doc = yaml.load(raw) || {};
  if (partial.pollIntervalMs != null) doc.pollIntervalMs = Number(partial.pollIntervalMs);
  if (partial.strategyFilters && typeof partial.strategyFilters === 'object') {
    doc.strategyFilters = { ...doc.strategyFilters, ...partial.strategyFilters };
    const r = doc.strategyFilters.risk;
    if (r === '' || r == null || String(r).trim().toLowerCase() === 'any') {
      delete doc.strategyFilters.risk;
    }
    const al = doc.strategyFilters.riskAllowlist;
    if (al === '' || al == null || (typeof al === 'string' && !al.trim())) {
      delete doc.strategyFilters.riskAllowlist;
    }
  }
  if (partial.risk && typeof partial.risk === 'object') {
    doc.risk = { ...doc.risk, ...partial.risk };
  }
  if (partial.execution && typeof partial.execution === 'object') {
    doc.execution = { ...doc.execution, ...partial.execution };
  }
  if (partial.automation && typeof partial.automation === 'object') {
    doc.automation = { ...(doc.automation || {}), ...partial.automation };
  }
  if (partial.positionAutoClose != null && typeof partial.positionAutoClose === 'object') {
    const src = partial.positionAutoClose;
    const cur = { ...(doc.positionAutoClose || {}) };
    const norm = (v) => {
      if (v === '' || v === undefined || v === null) return null;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    if ('lossPctOfInitialNotional' in src) cur.lossPctOfInitialNotional = norm(src.lossPctOfInitialNotional);
    if ('profitPctOfInitialNotional' in src)
      cur.profitPctOfInitialNotional = norm(src.profitPctOfInitialNotional);
    if ('maxHoldMinutes' in src) cur.maxHoldMinutes = norm(src.maxHoldMinutes);
    const kept = Object.fromEntries(Object.entries(cur).filter(([, v]) => v != null));
    if (Object.keys(kept).length) doc.positionAutoClose = kept;
    else delete doc.positionAutoClose;
  }
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, yaml.dump(doc, { lineWidth: 120, noRefs: true, sortKeys: false }), 'utf8');
  fs.renameSync(tmp, p);
  return readAgentSettings();
}

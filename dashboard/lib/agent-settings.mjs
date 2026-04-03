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
  }
  if (partial.risk && typeof partial.risk === 'object') {
    doc.risk = { ...doc.risk, ...partial.risk };
  }
  if (partial.execution && typeof partial.execution === 'object') {
    doc.execution = { ...doc.execution, ...partial.execution };
  }
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, yaml.dump(doc, { lineWidth: 120, noRefs: true, sortKeys: false }), 'utf8');
  fs.renameSync(tmp, p);
  return readAgentSettings();
}

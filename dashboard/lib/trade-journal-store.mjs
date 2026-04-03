import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getRepoRoot } from './persistence.mjs';

function journalPath() {
  return path.join(getRepoRoot(), 'data', 'trade-journal.json');
}

function ensureDir() {
  const dir = path.join(getRepoRoot(), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadRaw() {
  const p = journalPath();
  if (!fs.existsSync(p)) return { entries: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { entries: Array.isArray(j.entries) ? j.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function atomicWrite(obj) {
  ensureDir();
  const p = journalPath();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function summarize(entries) {
  let sumPnl = 0;
  let sumFees = 0;
  for (const e of entries) {
    if (e.pnlUsd != null && !Number.isNaN(Number(e.pnlUsd))) sumPnl += Number(e.pnlUsd);
    if (e.feesUsd != null && !Number.isNaN(Number(e.feesUsd))) sumFees += Number(e.feesUsd);
  }
  return { count: entries.length, sumPnlUsd: sumPnl, sumFeesUsd: sumFees };
}

export function getTradeJournal() {
  const { entries } = loadRaw();
  const sorted = [...entries].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { entries: sorted, summary: summarize(sorted) };
}

/**
 * @param {object} fields
 */
export function appendTradeEntry(fields) {
  const data = loadRaw();
  const entry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    label: String(fields.label || '').slice(0, 200) || 'Trade',
    venue: String(fields.venue || 'other').slice(0, 64),
    side: String(fields.side || 'n/a').slice(0, 32),
    notionalUsd:
      fields.notionalUsd === '' || fields.notionalUsd == null ? null : Number(fields.notionalUsd),
    pnlUsd: fields.pnlUsd === '' || fields.pnlUsd == null ? null : Number(fields.pnlUsd),
    feesUsd: fields.feesUsd === '' || fields.feesUsd == null ? null : Number(fields.feesUsd),
    walletId: fields.walletId ? String(fields.walletId).slice(0, 200) : null,
    note: String(fields.note || '').slice(0, 2000),
  };
  data.entries.unshift(entry);
  atomicWrite(data);
  return entry;
}

export function deleteTradeEntry(id) {
  const data = loadRaw();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.id !== id);
  if (data.entries.length === before) return false;
  atomicWrite(data);
  return true;
}

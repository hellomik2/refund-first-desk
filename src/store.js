// One JSON file is the whole database. The desk is a demo; what matters is that every record a
// judge sees on screen can be opened as plain data.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function emptyState(policy) {
  return {
    seq: 0,
    clockOffsetMs: 0, // demo fast-forward; see domain/clock.js
    buyers: {},
    mandates: {},
    orders: {},
    cases: {},
    ledger: [],
    reserve: { startCents: policy.reserveStartCents, allocations: {} },
    paypalCalls: [],
    aiCalls: [],
  };
}

export function createDb({ dataDir = null, policy, fresh = false }) {
  const file = dataDir ? join(dataDir, 'db.json') : null;
  let data = emptyState(policy);
  if (file && !fresh && existsSync(file)) {
    data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) };
  }
  const db = {
    data,
    nextId(prefix) {
      data.seq += 1;
      // Random suffix keeps PayPal invoice ids unique across database resets.
      return `${prefix}${String(data.seq).padStart(4, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    },
    save() {
      if (!file) return;
      mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 1));
      renameSync(tmp, file);
    },
  };
  return db;
}

// Turns one measured 30-case run (the evidence file scripts/loop.mjs writes) into the small file the case book
// shows as "after 30 cases": scenarios/casebook-measured.json. Only what the book needs is kept (no PayPal ids).
//
// Usage: node scripts/casebook-snapshot.mjs <loop evidence .json> [engine commit]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ROOT } from '../src/config.js';
import { toRecord } from '../src/domain/casebook.js';

const [file, engine = null] = process.argv.slice(2);
if (!file) throw new Error('Usage: node scripts/casebook-snapshot.mjs <loop evidence .json> [engine commit]');
const run = JSON.parse(readFileSync(file, 'utf8'));
const prepared = new Map(JSON.parse(readFileSync(join(ROOT, 'scenarios', 'cases.json'), 'utf8')).cases.map((c) => [c.id, c]));
const cases = Object.values(run.cases);

const records = run.results.map((row) => {
  const kase = cases.find((c) => c.id === row.caseId);
  if (!kase) throw new Error(`${row.id}: case ${row.caseId} is not in the evidence file`);
  const sc = prepared.get(row.id);
  return toRecord({ kase, scenarioId: row.id, title: row.title, store: sc.store, amountCents: Math.round(Number(row.amount) * 100) });
});

const out = {
  _note: 'Made by scripts/casebook-snapshot.mjs from one measured run of the 30 prepared cases. The cases, agent logs and answer key are written by us.',
  source: { file: basename(file), ranAt: run.summary.ranAt, environment: run.summary.environment, aiProvider: run.summary.aiProvider, engine },
  records,
};
const target = join(ROOT, 'scenarios', 'casebook-measured.json');
writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${records.length} records -> ${target}`);

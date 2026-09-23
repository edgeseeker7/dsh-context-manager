/* Offline validation for the skill-promoter: scan every session log in this
 * workspace for notes_read({ id }) calls, rebuild the fetch statistics the
 * plugin would have collected had it existed, and run the deterministic gate
 * against the real diaries. Read-only — prints the candidate shortlist,
 * writes nothing. */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SESSIONS_DIR = `${process.env.HOME}/.dsh/sessions/--home-liudi--`;
const { NotesStore } = await import('../lib/notes.js');
const { deterministicGate, MIN_FETCHES, MIN_DAYS, MIN_AGE_DAYS } = await import('../lib/promote.js');

const fetches = new Map(); // key -> [iso timestamps]
let callsTotal = 0;
for (const dir of readdirSync(SESSIONS_DIR)) {
  const file = join(SESSIONS_DIR, dir, 'session.v3.jsonl.zstd');
  let text;
  try {
    text = execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 }).toString();
  } catch {
    continue;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"notes_read"') || !line.includes('tool/call')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type !== 'tool/call' || ev?.data?.name !== 'notes_read') continue;
    let args;
    try {
      args = JSON.parse(ev.data.arguments ?? '{}');
    } catch {
      continue;
    }
    if (typeof args?.id !== 'string' || args.id.trim().length === 0) continue;
    callsTotal += 1;
    const target = typeof args.session === 'string' && args.session.trim().length > 0 ? args.session.trim() : dir;
    const key = `${target}::${args.id.trim()}`;
    const iso = new Date(ev.time ?? Date.now()).toISOString();
    if (!fetches.has(key)) fetches.set(key, []);
    fetches.get(key).push(iso);
  }
}

console.log(`scanned ${readdirSync(SESSIONS_DIR).length} session logs, ${callsTotal} by-id notes_read calls, ${fetches.size} distinct notes touched\n`);

const store = new NotesStore(8000);
const rows = [];
for (const [key, stamps] of fetches) {
  const [sessionId, id] = key.split('::');
  const days = new Set(stamps.map((s) => s.slice(0, 10))).size;
  const found = store.inspect(sessionId, id);
  if (found === null) {
    rows.push({ key, fetches: stamps.length, days, verdict: 'note gone', preview: '' });
    continue;
  }
  const stats = { fetches: stamps.length, days };
  const gate = deterministicGate({ note: found.entry, superseded: found.superseded, stats });
  rows.push({
    key,
    fetches: stamps.length,
    days,
    ageDays: found.entry.ts ? Math.floor((Date.now() - Date.parse(found.entry.ts)) / 86400000) : 0,
    verdict: gate.eligible ? '★ CANDIDATE' : gate.reason,
    preview: found.entry.text.replace(/\s+/g, ' ').slice(0, 90),
  });
}
rows.sort((a, b) => b.fetches - a.fetches);
console.log(`gate: ≥${MIN_FETCHES} fetches, ≥${MIN_DAYS} distinct days, age ≥${MIN_AGE_DAYS}d, active\n`);
for (const row of rows) {
  console.log(
    `${row.verdict.padEnd(14)} ${String(row.fetches).padStart(3)}f ${String(row.days).padStart(2)}d  ${row.key.padEnd(52)} ${row.preview}`,
  );
}

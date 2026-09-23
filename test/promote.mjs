/* dsh-context-manager skill-promoter (v1.12.0): fetch statistics, the
 * deterministic gate, the Jev content gate (injectable fetch), and the
 * suggest-only hint. DSH_HOME redirected to a temp dir so nothing touches
 * real user data. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-cm-promote-'));
process.env.DSH_HOME = home;

const { NotesStore } = await import('../lib/notes.js');
const { jevJudgePromotable, JEV_PROMOTE_THRESHOLD } = await import('../lib/jev.js');
const {
  COOLDOWN_DAYS,
  MIN_AGE_DAYS,
  MIN_DAYS,
  MIN_FETCHES,
  deterministicGate,
  maybeSuggest,
  recordFetch,
  statsFor,
} = await import('../lib/promote.js');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) {
    passed += 1;
    console.log(`  ok ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const SESSION = 'sess-promote';
const store = new NotesStore(8000);
await store.append(SESSION, '发布链流程: git push 到 edgeseeker7，然后 npm publish，先跑 pnpm run check', {
  tags: ['release'],
});
ok(true, 'seed note appended');

// ── inspect: entry + chain status ─────────────────────────────────────────
const found = store.inspect(SESSION, 'n1');
ok(found !== null && found.entry.id === 'n1' && found.superseded === false, 'inspect returns entry and active status');
ok(store.inspect(SESSION, 'n99') === null, 'inspect returns null for unknown id');

// ── recordFetch: accumulation and day counting ────────────────────────────
const KEY = `${SESSION}::n1`;
await recordFetch(KEY);
await recordFetch(KEY);
const after2 = statsFor(KEY);
ok(after2.fetches === 2 && after2.days === 1, 'two fetches on one day → fetches=2 days=1');

// ── deterministicGate ─────────────────────────────────────────────────────
const OLD = new Date(Date.now() - (MIN_AGE_DAYS + 2) * 86400000).toISOString();
const YOUNG = new Date().toISOString();
const note = { id: 'n1', ts: OLD, text: 'x' };
const hot = { fetches: MIN_FETCHES + 2, days: MIN_DAYS + 1 };
ok(deterministicGate({ note, superseded: false, stats: hot }).eligible === true, 'hot old active note is eligible');
ok(
  deterministicGate({ note, superseded: true, stats: hot }).reason === 'superseded',
  'superseded note is never a candidate',
);
ok(
  deterministicGate({ note: { ...note, ts: YOUNG }, superseded: false, stats: hot }).reason.includes('too young'),
  'young note is blocked however hot',
);
ok(
  deterministicGate({ note, superseded: false, stats: { fetches: MIN_FETCHES - 1, days: 9 } }).reason.includes('fetches'),
  'below fetch threshold is blocked',
);
ok(
  deterministicGate({ note, superseded: false, stats: { fetches: 9, days: MIN_DAYS - 1 } }).reason.includes('days'),
  'single-day burst is blocked (distinct days required)',
);
const recent = new Date().toISOString();
ok(
  deterministicGate({ note, superseded: false, stats: { ...hot, lastSuggested: recent } }).reason === 'cooldown',
  'suggested recently → cooldown',
);
const stale = new Date(Date.now() - (COOLDOWN_DAYS + 1) * 86400000).toISOString();
ok(
  deterministicGate({ note, superseded: false, stats: { ...hot, lastSuggested: stale } }).eligible === true,
  'expired cooldown unblocks',
);

// ── Jev judge (fake fetch) ────────────────────────────────────────────────
const highFetch = async () => ({ ok: true, json: async () => ({ answers: { candidate: { noul: 0.91 } } }) });
const p1 = await jevJudgePromotable({ apiKey: 'k', noteText: 'procedure', evidence: 'fetched 6 times', fetchImpl: highFetch });
ok(p1 === 0.91, 'judge returns the probability');
const degraded = [];
const badFetch = async () => ({ ok: false, status: 503 });
const p2 = await jevJudgePromotable({
  apiKey: 'k',
  noteText: 'x',
  evidence: 'y',
  fetchImpl: badFetch,
  onDegrade: (reason) => degraded.push(reason),
});
ok(p2 === null && degraded.some((reason) => reason.includes('503')), 'http failure degrades to null with the reason recorded');
const p3 = await jevJudgePromotable({ apiKey: '', noteText: 'x', evidence: 'y', fetchImpl: highFetch });
ok(p3 === null, 'missing key degrades to null');

// ── maybeSuggest: full pipeline over a fabricated stats file ──────────────
for (let i = 0; i < MIN_FETCHES; i += 1) await recordFetch(KEY);
const realStats = statsFor(KEY);
ok(realStats.fetches >= MIN_FETCHES + 2, 'stats accumulated past the fetch threshold');
// Same-day fetches mean days=1 < MIN_DAYS: the honest result is NO suggestion.
const oldNote = { ...found.entry, ts: OLD };
const blocked = await maybeSuggest({
  key: KEY,
  note: oldNote,
  superseded: false,
  jevApiKey: 'k',
  session: SESSION,
});
ok(blocked === undefined, 'same-day burst yields no suggestion even with an old note');

// Fabricate an eligible stats entry (fetches spread over 4 days), then drive
// the full gate → judge → hint path with an injected fetch.
const { dshHomePath } = await import('@deepseek-ai/dsh-home-paths');
const { writeFileSync, mkdirSync } = await import('node:fs');
const { dirname } = await import('node:path');
const statsFile = dshHomePath('context-manager', 'note-stats.json');
const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString();
const eligible = {
  version: 1,
  notes: { [KEY]: { fetches: [day(5), day(4), day(4), day(3), day(1), day(0)] } },
};
mkdirSync(dirname(statsFile), { recursive: true });
writeFileSync(statsFile, JSON.stringify(eligible));

const hintOut = await maybeSuggest({
  key: KEY,
  note: oldNote,
  superseded: false,
  jevApiKey: 'k',
  session: SESSION,
  fetchImpl: highFetch,
});
ok(typeof hintOut === 'string' && hintOut.includes('📌') && hintOut.includes('n1') && hintOut.includes('p=0.91'), 'eligible + Jev approval → crystallization hint');
ok(hintOut.includes('ask_user_question') && hintOut.includes('SKILL.md') && hintOut.includes('supersedes'), 'hint lays out the human-gated flow');
ok(statsFor(KEY).lastSuggested !== undefined, 'suggestion stamps the cooldown');

// Cooldown now blocks an immediate re-suggestion.
const again = await maybeSuggest({
  key: KEY,
  note: oldNote,
  superseded: false,
  jevApiKey: 'k',
  session: SESSION,
  fetchImpl: highFetch,
});
ok(again === undefined, 'cooldown suppresses the immediate re-suggestion');

// Jev rejection also cools down (content verdict, not timing).
writeFileSync(statsFile, JSON.stringify(eligible));
const lowFetch = async () => ({ ok: true, json: async () => ({ answers: { candidate: { noul: 0.2 } } }) });
const rejected = await maybeSuggest({
  key: KEY,
  note: oldNote,
  superseded: false,
  jevApiKey: 'k',
  session: SESSION,
  fetchImpl: lowFetch,
});
ok(rejected === undefined && statsFor(KEY).lastSuggested !== undefined, 'Jev rejection yields no hint and cools down');

// Judge outage → no hint, no crash.
writeFileSync(statsFile, JSON.stringify(eligible));
const outage = await maybeSuggest({
  key: KEY,
  note: oldNote,
  superseded: false,
  jevApiKey: 'k',
  session: SESSION,
  fetchImpl: badFetch,
});
ok(outage === undefined, 'judge outage degrades to silence (logged, never spam)');

ok(JEV_PROMOTE_THRESHOLD === 0.7, 'promote threshold is the calibrated 0.7');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

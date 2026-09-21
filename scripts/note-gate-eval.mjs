/**
 * Note-gate evaluation — measures the Jev content gate behind the memory nudge
 * against real session logs, with a rule-based labeller as ground truth.
 *
 * It is NOT part of `npm run check` (it needs JEV_API_KEY and this machine's
 * session logs). Run it by hand after touching the note gate, the span
 * slicing, or the threshold:
 *
 *   JEV_API_KEY=... node scripts/note-gate-eval.mjs
 *
 * What it reports:
 *  - precision/recall/F1 of the gate against rule labels, across thresholds
 *  - excerpt fidelity: would the note that gets written actually carry a fact
 *  - how much an existing diary suppresses the score (already-recorded check)
 *  - the disagreements themselves, so a human can adjudicate
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { deltaSpans } from '../lib/malloc.js';
import { jevSelectNoteSpans, JEV_NOTE_THRESHOLD } from '../lib/jev.js';

const SESSIONS_DIR = '/home/liudi/.dsh/sessions/--home-liudi--';
const NOTES_DIR = '/home/liudi/.dsh/context-manager/notes';
const SESSIONS = [
  'session-adae3ece-cc42-4b80-ad95-ccb27ea9bcb1',
  'session-3fb3e646-7f34-4de6-84ce-7610e0ce40b7',
  'session-a74b5cac-afca-4ca2-bcad-96e1d098e87f',
  'session-412bbe85-ca4c-488e-8c57-079e4402c171',
];
const DURABLE =
  /(决定|结论|改成|换成|改为|禁止|必须|不能|失败|反向|发现|踩|坑|未提交|还没|待办|钉死|固定|改用|回退|路径|版本|v\d+\.\d+\.\d+|[0-9a-f]{8,40}|~\/[\w./-]{4,}|\/[\w.-]+\/[\w./-]{4,}|[A-Z][A-Z_]{4,})/;
const CHURN = /(biome|ruff|format|lint|npm run check|全绿|0 失败|pytest|ls |grep |重跑|测试通过|读了一遍|看了一下|wc -l)/g;

const hits = (re, text) => (text.match(re) ?? []).length;
const labelOf = (span) =>
  hits(DURABLE, `${span.excerpt} ${span.digest}`) - hits(CHURN, span.excerpt) >= 1 ? 'durable' : 'churn';
const fresh = () => new RegExp(DURABLE.source);

const usage = { in: 0, out: 0, calls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await realFetch(...args);
  try {
    const body = await response.clone().json();
    usage.in += body?.usage?.input_tokens ?? 0;
    usage.out += body?.usage?.output_tokens ?? 0;
    usage.calls += 1;
  } catch {
    /* a non-JSON response is the plugin's problem, not the eval's */
  }
  return response;
};

const rows = [];
for (const id of SESSIONS) {
  const log = `${SESSIONS_DIR}/${id}/session.v3.jsonl.zstd`;
  if (!existsSync(log)) {
    console.log(`skip ${id.slice(7, 15)} (no log)`);
    continue;
  }
  const lines = execFileSync('zstd', ['-dc', log], { maxBuffer: 1024 * 1024 * 512 })
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-300);
  const events = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const session = {
    id,
    header: { cwd: '/home/liudi' },
    seq: events.length,
    eventAt: (seq) => events[Number(seq)],
    deriveEventMessage: () => null,
  };
  const spans = deltaSpans(session, Math.max(0, events.length - 260));
  if (spans.length === 0) continue;
  const notesPath = `${NOTES_DIR}/${id}.jsonl`;
  const diary = existsSync(notesPath) ? readFileSync(notesPath, 'utf8').slice(0, 3000) : '(no diary)';
  const noteCount = existsSync(notesPath)
    ? readFileSync(notesPath, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
  const withoutMemory = await jevSelectNoteSpans({
    apiKey: process.env.JEV_API_KEY,
    recorded: '(nothing recorded about this work yet)',
    spans,
  });
  const withDiary = await jevSelectNoteSpans({ apiKey: process.env.JEV_API_KEY, recorded: diary, spans });
  spans.forEach((span, index) => {
    rows.push({
      session: id.slice(7, 15),
      notes: noteCount,
      label: labelOf(span),
      signal: fresh().test(span.excerpt),
      p1: withoutMemory?.[index]?.probability ?? null,
      p2: withDiary?.[index]?.probability ?? null,
      excerpt: span.excerpt.slice(0, 96).replace(/\s+/g, ' '),
    });
  });
  console.log(`${id.slice(7, 15)} notes=${noteCount} spans=${spans.length}`);
}

const durable = rows.filter((row) => row.label === 'durable');
console.log(`\nsample: ${rows.length} spans (${durable.length} durable / ${rows.length - durable.length} churn, rule-labelled)`);
console.log('thr   TP  FP  FN  TN   precision  recall   F1');
for (const threshold of [0.5, 0.6, 0.7, 0.8]) {
  const tp = durable.filter((row) => row.p1 >= threshold).length;
  const fp = rows.filter((row) => row.label === 'churn' && row.p1 >= threshold).length;
  const fn = durable.filter((row) => row.p1 < threshold).length;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const mark = threshold === JEV_NOTE_THRESHOLD ? ' ←' : '';
  console.log(
    `${threshold.toFixed(1)}   ${String(tp).padStart(2)}  ${String(fp).padStart(2)}  ${String(fn).padStart(2)}  ${String(rows.length - tp - fp - fn).padStart(2)}   ${precision.toFixed(2)}       ${recall.toFixed(2)}     ${f1.toFixed(2)}${mark}`,
  );
}
const written = rows.filter((row) => row.p1 >= JEV_NOTE_THRESHOLD);
console.log(`\nnotes that would be written: ${written.length}/${rows.length}`);
console.log(`  carrying a durable signal in the quote: ${written.filter((row) => row.signal).length}/${written.length}  (note precision)`);
const withSignal = durable.filter((row) => row.signal);
console.log(`  durable facts missed: ${withSignal.filter((row) => row.p1 < JEV_NOTE_THRESHOLD).length}/${withSignal.length}  (miss rate)`);
const mean = (list) => (list.length === 0 ? 0 : list.reduce((sum, value) => sum + value, 0) / list.length);
const heavy = rows.filter((row) => row.notes >= 10);
const light = rows.filter((row) => row.notes <= 4);
console.log(
  `\nalready-recorded suppression: heavy diaries ${mean(heavy.map((r) => r.p1)).toFixed(2)} → ${mean(heavy.map((r) => r.p2)).toFixed(2)}; light diaries ${mean(light.map((r) => r.p1)).toFixed(2)} → ${mean(light.map((r) => r.p2)).toFixed(2)}`,
);
console.log('\nfalse positives (churn flagged):');
for (const row of rows.filter((r) => r.label === 'churn' && r.p1 >= JEV_NOTE_THRESHOLD))
  console.log(`  ${row.session} p=${row.p1.toFixed(2)}  ${row.excerpt}`);
console.log('false negatives (durable with a signal, not flagged):');
for (const row of withSignal.filter((r) => r.p1 < JEV_NOTE_THRESHOLD))
  console.log(`  ${row.session} p=${row.p1.toFixed(2)}  ${row.excerpt}`);
console.log(`\nJev usage: ${usage.calls} calls, in=${usage.in} out=${usage.out} tokens`);

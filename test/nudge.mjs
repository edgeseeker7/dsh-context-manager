/* dsh-context-manager smart nudge: information-driven trigger, adaptive
 * backoff, content-directed candidates, token-meter fallback to cadence. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-cm-nudge-'));
process.env.DSH_HOME = home;

const { PinStore, installMalloc } = await import('../lib/malloc.js');
const { NotesStore } = await import('../lib/notes.js');

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

/** Harness: a mock agent whose tools/post-execute hook we can drive manually. */
function harness({
  window = 128000,
  nudgeEvery = 2,
  anchors = [],
  tokensAvailable = true,
  jevApiKey,
  events = [],
  notes = '',
  notesImpl,
  sessionId = 'nudge-session',
} = {}) {
  const hooks = {};
  let totalTokens = 0;
  const agent = {
    session: {
      id: sessionId,
      header: { cwd: '/nudge' },
      get seq() {
        return events.length;
      },
      eventAt: (seq) => events[Number(seq)],
      deriveEventMessage: () => null,
    },
    ctx: {
      systemPrompt: { section: () => {} },
      tools: { register: () => {} },
      on: (event, fn) => {
        hooks[event] = fn;
      },
    },
  };
  const store = new PinStore({ pinMaxChars: 4000, pinsMaxChars: 100000, windowRatio: 0.05, suggestCount: 1 });
  installMalloc(agent, store, {
    resolveWindow: async () => window,
    cachedWindow: () => window,
    nudgeEvery,
    measureTokens: tokensAvailable ? () => totalTokens : undefined,
    suggestAnchors: () => anchors,
    logger: { warn: () => {} },
    jevApiKey,
    notesStore: notesImpl ?? { read: () => notes },
  });
  /** Drive one tool execution; returns the attached contexts (empty = no nudge). */
  const run = async (name, downstream = { kind: 'result', additionalContexts: [] }) => {
    const result = await hooks['tools/post-execute']({ name }, undefined, async () => downstream);
    return result.additionalContexts ?? [];
  };
  return {
    run,
    setTokens: (value) => {
      totalTokens = value;
    },
    /** The session log grows with the work — push more events. */
    grow: (n = 12) => {
      events.push(...workEvents(n, '后续工作'));
    },
  };
}

const userMessage = (text) => ({
  type: 'user/message',
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const workEvents = (n, tag = '工作记录') =>
  Array.from({ length: n }, (_, i) => userMessage(`${tag} ${i}: 改了什么、决定了什么、排除了什么`));

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

/** Answer every span question with the same noul score. */
const jevFetch = (noul, onBody) => async (_url, init) => {
  const body = JSON.parse(init.body);
  onBody?.(body);
  const answers = {};
  for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul };
  return { ok: true, json: async () => ({ answers }) };
};

// ── trigger: fires on information produced, not on tool-call count ────────
const h = harness({ anchors: ['74e4ee3c-6c01-4fd9-8452-84f10a7270d5'] });
h.setTokens(0);
await h.run('bash'); // establishes the baseline, no fire
h.setTokens(3000);
ok((await h.run('bash')).length === 0, 'below the token threshold: no nudge');
h.setTokens(7000); // produced 7000 ≥ threshold 6400 (128000 × 5%)
const fired = await h.run('bash');
ok(fired.length === 1, 'crossing 5% of the window fires the nudge');
ok(fired[0].content[0].text.includes('74e4ee3c-6c01-4fd9-8452-84f10a7270d5'), 'the nudge names concrete pin candidates');
ok(fired[0].content[0].text.includes('skipping is the norm'), 'the nudge keeps the honest out');
ok(fired[0].content[0].text.includes('~7K tokens'), 'the nudge states the information volume');

// generic text when there are no candidates
const g = harness({ anchors: [] });
g.setTokens(0);
await g.run('bash');
g.setTokens(7000);
const generic = await g.run('bash');
ok(generic.length === 1 && generic[0].content[0].text.includes('pin verbatim-critical facts'), 'no candidates → generic nudge text');

// nudge also attaches to a BLOCKED tool result
const bl = harness({ anchors: [] });
bl.setTokens(0);
await bl.run('bash');
bl.setTokens(7000);
const blocked = await bl.run('bash', { kind: 'block', feedback: 'no', additionalContexts: [] });
ok(blocked.length === 1, 'nudge attaches to blocked results too');

// ── backoff: ignored nudges double their threshold, productive ones reset ──
const b = harness();
b.setTokens(0);
await b.run('bash'); // baseline
b.setTokens(7000);
await b.run('bash'); // fires #1 (produced 7000 ≥ 6400), actedSinceNudge=false
b.setTokens(14000); // produced 7000 ≥ 6400 → fires #2, streak=1 → threshold 12800
ok((await b.run('bash')).length === 1, 'second trigger fires (streak 1)');
b.setTokens(20000); // produced 6000 < 12800
ok((await b.run('bash')).length === 0, 'backed-off threshold suppresses the nudge');
b.setTokens(27000); // produced 13000 ≥ 12800 → fires #3, streak=2 → threshold 25600
ok((await b.run('bash')).length === 1, 'third trigger fires at the doubled threshold');
b.setTokens(40000); // produced 13000 < 25600
ok((await b.run('bash')).length === 0, 'twice-doubled threshold suppresses');
await b.run('context_alloc'); // memory op → reset streak/threshold, lastMemoryTokens=40000
b.setTokens(47000); // produced 7000 ≥ 6400 (reset)
ok((await b.run('bash')).length === 1, 'a memory operation resets the backoff');

// ── fallback: no token meter → fixed cadence ──────────────────────────────
const f = harness({ tokensAvailable: false, nudgeEvery: 2 });
ok((await f.run('bash')).length === 0, 'cadence fallback: first call quiet');
ok((await f.run('bash')).length === 1, 'cadence fallback: nudgeEvery-th call fires');

// ── Jev content gate: the model is only interrupted when Jev finds content ─
{
  const events = workEvents(20);
  let sent = null;
  const j = harness({ jevApiKey: 'test-key', events });
  j.setTokens(0);
  await j.run('bash'); // baseline
  j.setTokens(2500); // ≥ the 2000 floor; below the 6400 volume threshold
  const fired = await withFetch(jevFetch(0.9, (body) => (sent = body)), () => j.run('bash'));
  ok(fired.length === 1, 'Jev verdict above threshold fires the nudge below the volume threshold');
  ok(fired[0].content[0].text.includes('look unrecorded'), 'the nudge names the flagged stretch');
  ok(/seq \d+\.\.\d+/.test(fired[0].content[0].text), 'the flagged stretch carries its seq range');
  ok(fired[0].content[0].text.includes('skipping is the norm'), 'the honest out survives');
  ok(sent !== null && Object.keys(sent.questions).length === 3, 'the delta was sliced into spans (rule side)');
  ok(sent.state.length > 0 && String(Object.values(sent.questions)[0].instructions.span).includes('seq '), 'Jev saw the spans, not the request alone');
}

// ── Jev content gate: nothing worth recording → silence, and no backoff ───
{
  const j = harness({ jevApiKey: 'test-key', events: workEvents(20) });
  j.setTokens(0);
  await j.run('bash');
  j.setTokens(2500);
  const quiet = await withFetch(jevFetch(0.05), () => j.run('bash'));
  ok(quiet.length === 0, 'a Jev "nothing to record" verdict stays silent');
  j.setTokens(5000); // produced 2500 < 6400: an un-asked turn must not tighten the backoff
  const stillQuiet = await withFetch(jevFetch(0.05), () => j.run('bash'));
  ok(stillQuiet.length === 0, 'the volume trigger was not armed by the silent check');
  // A later, honest volume-sized delta that Jev flags still fires at the base threshold.
  j.grow(12);
  j.setTokens(9000);
  const later = await withFetch(jevFetch(0.9), () => j.run('bash'));
  ok(later.length === 1, 'the next flagged delta still fires');
}

// ── Jev content gate: rate limit — one check per turn's worth of events ───
{
  let calls = 0;
  const j = harness({ jevApiKey: 'test-key', events: workEvents(20) });
  j.setTokens(0);
  await j.run('bash');
  j.setTokens(2500);
  await withFetch(jevFetch(0.05, () => (calls += 1)), () => j.run('bash'));
  j.setTokens(5000); // 2500 more tokens, but the same 20 events: no new content
  await withFetch(jevFetch(0.05, () => (calls += 1)), () => j.run('bash'));
  ok(calls === 1, 'the rate rule spends at most one Jev note check per 12 events');
}

// ── the measured band: churn stays below, durable clears 0.7 ──────────────
{
  const quiet = harness({ jevApiKey: 'test-key', events: workEvents(20) });
  quiet.setTokens(0);
  await quiet.run('bash');
  quiet.setTokens(2500);
  ok((await withFetch(jevFetch(0.65), () => quiet.run('bash'))).length === 0, 'churn-level spans (0.65) stay silent');
  const loud = harness({ jevApiKey: 'test-key', events: workEvents(20) });
  loud.setTokens(0);
  await loud.run('bash');
  loud.setTokens(2500);
  ok((await withFetch(jevFetch(0.75), () => loud.run('bash'))).length === 1, 'durable-level spans (0.75) fire');
}

// ── extractive auto-note: Jev selects, the rule copies verbatim ───────────
{
  const notes = new NotesStore(8000, {});
  const sid = 'auto-note-session';
  const events = workEvents(20);
  const h = harness({ jevApiKey: 'test-key', events, notesImpl: notes, sessionId: sid });
  h.setTokens(0);
  await h.run('bash');
  h.setTokens(2500);
  const out = await withFetch(jevFetch(0.9), () => h.run('bash'));
  const written = notes.entries(sid);
  ok(written.length >= 1, 'a flagged span is saved without asking the model');
  ok(/^seq \d+\.\.\d+ 原文摘录：/.test(written[0].text), 'the note opens with its provenance marker');
  ok(written[0].text.includes(events[0].data.content[0].text), 'the excerpt is copied VERBATIM, not paraphrased');
  ok(
    (written[0].tags ?? []).includes('auto') && (written[0].tags ?? []).includes('jev-extract'),
    'the auto note is tagged for one-command cleanup',
  );
  ok(written[0].sourceSeq === 0, 'the note points back at the log event');
  ok(
    out.length === 1 && out[0].content[0].text.includes('already saved as notes') && out[0].content[0].text.includes(written[0].id),
    'the model is only informed, and told which note ids exist',
  );
}

// ── extractive auto-note: at most two per check ──────────────────────────
{
  const notes = new NotesStore(8000, {});
  const sid = 'auto-note-cap';
  const h = harness({ jevApiKey: 'test-key', events: workEvents(60), notesImpl: notes, sessionId: sid });
  h.setTokens(0);
  await h.run('bash');
  h.setTokens(2500);
  const out = await withFetch(jevFetch(0.9), () => h.run('bash'));
  ok(notes.entries(sid).length === 2, 'a single check writes at most two notes');
  ok(out.length === 1 && out[0].content[0].text.includes('2 stretch(es)'), 'the nudge reports the saved stretches');
}

// ── extractive auto-note: one span is written once, across restarts ───────
{
  const notes = new NotesStore(8000, {});
  const sid = 'auto-note-dedupe';
  const events = workEvents(6); // one span → one note, so the dedupe is unambiguous
  const first = harness({ jevApiKey: 'test-key', events, notesImpl: notes, sessionId: sid });
  first.setTokens(0);
  await first.run('bash');
  first.setTokens(2500);
  await withFetch(jevFetch(0.9), () => first.run('bash'));
  ok(notes.entries(sid).length === 1, 'the first check writes the extract');
  // A fresh install (restart) sees the same delta again — the marker must hold.
  const second = harness({ jevApiKey: 'test-key', events, notesImpl: notes, sessionId: sid });
  second.setTokens(0);
  await second.run('bash');
  second.setTokens(2500);
  const out2 = await withFetch(jevFetch(0.9), () => second.run('bash'));
  ok(notes.entries(sid).length === 1, 'the same span is never written twice');
  ok(out2.length === 1 && out2[0].content[0].text.includes('look unrecorded'), 'a duplicate is handed back to the model instead');
}

// ── extractive auto-note: silence and outage write nothing ───────────────
{
  const notesQuiet = new NotesStore(8000, {});
  const quiet = harness({ jevApiKey: 'test-key', events: workEvents(20), notesImpl: notesQuiet, sessionId: 'auto-note-quiet' });
  quiet.setTokens(0);
  await quiet.run('bash');
  quiet.setTokens(2500);
  await withFetch(jevFetch(0.05), () => quiet.run('bash'));
  ok(notesQuiet.entries('auto-note-quiet').length === 0, 'a "nothing to record" verdict writes nothing');
  const notesDown = new NotesStore(8000, {});
  const down = harness({ jevApiKey: 'test-key', events: workEvents(20), notesImpl: notesDown, sessionId: 'auto-note-down' });
  down.setTokens(0);
  await down.run('bash');
  down.setTokens(7000);
  await withFetch(
    async () => {
      throw new Error('gateway down');
    },
    () => down.run('bash'),
  );
  ok(notesDown.entries('auto-note-down').length === 0, 'a Jev outage writes nothing (the volume nudge still asks)');
}

// ── excerpt hygiene: reasoning never becomes the quote (eval-found bug) ───
{
  const notes = new NotesStore(8000, {});
  const sid = 'excerpt-reasoning';
  const reasoning = '我在想这个用户到底要什么，先看看文件，再看看日志，然后再决定要不要动插件。'.repeat(4);
  const answer = '结论：发布必须走仓库自带脚本（~/dsh-subagent-progress/bin/publish.sh），禁止手敲。';
  const events = [
    {
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model' },
          content: [
            { type: 'reasoning', text: reasoning },
            { type: 'text', text: answer },
          ],
        },
      },
    },
  ];
  const h = harness({ jevApiKey: 'test-key', events, notesImpl: notes, sessionId: sid });
  h.setTokens(0);
  await h.run('bash');
  h.setTokens(2500);
  await withFetch(jevFetch(0.9), () => h.run('bash'));
  const written = notes.entries(sid);
  ok(written.length === 1 && written[0].text.includes('发布必须走仓库自带脚本'), 'the quote is the ANSWER block');
  ok(!written[0].text.includes('我在想这个用户到底要什么'), 'the reasoning block never leaks into the diary');
}

// ── excerpt hygiene: injected envelopes are stripped ─────────────────────
{
  const notes = new NotesStore(8000, {});
  const sid = 'excerpt-envelope';
  const envelope = `<system-reminder> ${'无关的目录清单与工具说明 '.repeat(30)} </system-reminder>`;
  const ask = '请把发布流程钉死成：一律走仓库脚本，不许手敲 docker。';
  const events = [
    {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `${envelope}\n${ask}` }] },
    },
  ];
  const h = harness({ jevApiKey: 'test-key', events, notesImpl: notes, sessionId: sid });
  h.setTokens(0);
  await h.run('bash');
  h.setTokens(2500);
  await withFetch(jevFetch(0.9), () => h.run('bash'));
  const written = notes.entries(sid);
  ok(written.length === 1 && written[0].text.includes('一律走仓库脚本'), 'the real ask survives');
  ok(!written[0].text.includes('无关的目录清单'), 'the system-reminder envelope is stripped');
}

// ── excerpt hygiene: a machine-only stretch writes nothing ───────────────
{
  const notes = new NotesStore(8000, {});
  const sid = 'excerpt-machine-only';
  const events = [
    {
      type: 'request/header',
      data: { header: { config: { provider: 'x', model: 'y' }, tools: [{ name: 'bash', description: 'zz'.repeat(500) }] } },
    },
    {
      type: 'tool/result',
      data: { message: { role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'Q'.repeat(4000) }] }] } },
    },
  ];
  const h = harness({ jevApiKey: 'test-key', events, notesImpl: notes, sessionId: sid });
  h.setTokens(0);
  await h.run('bash');
  h.setTokens(2500);
  const out = await withFetch(jevFetch(0.9), () => h.run('bash'));
  ok(notes.entries(sid).length === 0, 'a stretch with nothing quotable writes no note');
  ok(!(out[0]?.content?.[0]?.text ?? '').includes('already saved'), 'and the nudge never claims a save');
}

// ── degrade: Jev unreachable → the volume trigger still interrupts ────────
{
  const j = harness({ jevApiKey: 'test-key', events: workEvents(20) });
  j.setTokens(0);
  await j.run('bash');
  j.setTokens(7000); // ≥ 6400: the fallback threshold
  const out = await withFetch(
    async () => {
      throw new Error('gateway down');
    },
    () => j.run('bash'),
  );
  ok(out.length === 1 && out[0].content[0].text.includes('~7K tokens'), 'a Jev outage falls back to the volume nudge');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

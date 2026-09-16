/* dsh-context-manager smart nudge: information-driven trigger, adaptive
 * backoff, content-directed candidates, token-meter fallback to cadence. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-cm-nudge-'));
process.env.DSH_HOME = home;

const { PinStore, installMalloc } = await import('../lib/malloc.js');

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
function harness({ window = 128000, nudgeEvery = 2, anchors = [], tokensAvailable = true } = {}) {
  const hooks = {};
  let totalTokens = 0;
  const agent = {
    session: { id: 'nudge-session', header: { cwd: '/nudge' } },
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
  };
}

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

/* dsh-context-manager smoke test: pure-store semantics, no harness needed.
 * DSH_HOME is redirected to a temp dir so nothing touches real user data. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-cm-smoke-'));
process.env.DSH_HOME = home;

const { PinStore, workspaceSlug } = await import('../lib/malloc.js');
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

const SESSION = 'sess-1';
const CWD = '/home/dev';

// ── workspaceSlug ─────────────────────────────────────────────────────────
ok(workspaceSlug('/home/dev') === 'home-liudi', 'slug basic');
ok(workspaceSlug(undefined) === 'global', 'slug fallback');
ok(workspaceSlug('/a/b/../C D') === 'a-b-c-d', 'slug normalization');

// ── PinStore basics ───────────────────────────────────────────────────────
const store = new PinStore({ pinMaxChars: 100, pinsMaxChars: 300, windowRatio: 0.05, suggestCount: 2 });

const a1 = store.alloc({
  sessionId: SESSION,
  cwd: CWD,
  text: 'api endpoint: https://example.com/v1',
  label: 'API 端点',
  scope: 'task',
});
ok(a1.accepted === true && a1.handle === 't1', 'alloc task → t1');

const a2 = store.alloc({ sessionId: SESSION, cwd: CWD, text: 'palette: only --dsw-* vars', scope: 'permanent' });
ok(a2.accepted === true && a2.handle === 'w1', 'alloc permanent → w1');

const a3 = store.alloc({ sessionId: SESSION, cwd: CWD, text: 'x'.repeat(101), scope: 'task' });
ok(a3.accepted === false && a3.reason.includes('per-pin cap'), 'per-pin cap rejects');

// quota gate (total cap 300): used = 27 + 26 = 53; three 100-char pins walk to the cap
const b1 = store.alloc({ sessionId: SESSION, cwd: CWD, text: 'y'.repeat(100), scope: 'task' });
ok(b1.accepted === true && b1.handle === 't2', 'alloc under quota → t2');
const b2 = store.alloc({ sessionId: SESSION, cwd: CWD, text: 'y'.repeat(100), scope: 'task' });
ok(b2.accepted === true && b2.handle === 't3', 'alloc under quota → t3');
const b3 = store.alloc({ sessionId: SESSION, cwd: CWD, text: 'y'.repeat(100), scope: 'task' });
ok(b3.accepted === false && b3.reason.includes('quota exceeded'), 'quota rejects at 353 > 300');
ok(b3.reason.includes('[t1] API 端点'), 'quota rejection names oldest task pins');
ok(!b3.reason.includes('w1'), 'suggestions stay within task scope');

// window-ratio gate on a big-cap store with its own session file:
// 5% of 32000 tokens × 3 = 4800 chars — five 900-char pins fit, the sixth doesn't
const store2 = new PinStore({ pinMaxChars: 1000, pinsMaxChars: 100000, windowRatio: 0.05, suggestCount: 2 });
let ratioOk = true;
for (let i = 0; i < 5; i += 1) {
  ratioOk =
    store2.alloc({ sessionId: 'sess-ratio', cwd: CWD, text: 'z'.repeat(900), scope: 'task' }, 32000).accepted &&
    ratioOk;
}
ok(ratioOk, 'ratio store: 5 × 900 chars fit under the 4800 ratio cap');
const c6 = store2.alloc({ sessionId: 'sess-ratio', cwd: CWD, text: 'z'.repeat(900), scope: 'task' }, 32000);
ok(c6.accepted === false && c6.reason.includes('quota exceeded'), 'window-ratio gate rejects the 6th (5400 > 4800)');
const c7 = store2.alloc({ sessionId: 'sess-ratio', cwd: CWD, text: 'z'.repeat(900), scope: 'task' }, 200000);
ok(c7.accepted === true, 'same pin accepted under a big window (ratio gate relaxed)');

// ── free / handle monotonicity ────────────────────────────────────────────
const f1 = store.free({ sessionId: SESSION, cwd: CWD, handle: 't1' });
ok(f1.accepted === true && f1.freed === 't1', 'free t1');
const f2 = store.free({ sessionId: SESSION, cwd: CWD, handle: 't1' });
ok(f2.accepted === false && f2.reason.includes('not pinned'), 'double free rejected');
const f3 = store.free({ sessionId: SESSION, cwd: CWD, handle: 'bogus' });
ok(f3.accepted === false, 'bogus handle rejected');
const a7 = store.alloc({ sessionId: SESSION, cwd: CWD, text: 'after free', scope: 'task' });
ok(a7.handle === 't4', 'handles monotonic — freed t1 never reused');

// ── render ────────────────────────────────────────────────────────────────
const rendered = store.render(SESSION, CWD);
ok(rendered.includes('[w1] palette: only --dsw-* vars') && rendered.includes('[t2]'), 'render shows both scopes');
ok(rendered.indexOf('w1') < rendered.indexOf('t2'), 'workspace pins render before task pins');
ok(store.render('empty-session', '/nowhere') === '', 'empty vault → empty section');

// ── clearTask (/reset bulk-free): t1 freed earlier, so t2/t3/t4 = 3 pins ──
const cleared = store.clearTask(SESSION);
ok(cleared === 3, 'clearTask counts remaining task pins');
ok(store.render(SESSION, CWD).includes('[w1]'), 'workspace pins survive clearTask');
ok(!store.render(SESSION, CWD).includes('[t2]'), 'task pins gone after clearTask');
const a8 = store.alloc({ sessionId: SESSION, cwd: CWD, text: 'post-reset pin', scope: 'task' });
ok(a8.handle === 't5', 'handle counter survives clearTask — no ABA across /reset');

// ── workspace isolation & sharing ─────────────────────────────────────────
ok(store.render('another-session', CWD).includes('[w1]'), 'same workspace, other session sees w1');
ok(store.render('another-session', '/elsewhere').includes('w1') === false, 'other workspace does not see w1');

// ── NotesStore + legacy migration ─────────────────────────────────────────
const notes = new NotesStore(200);
ok(notes.read(SESSION) === '', 'notes empty initially');
notes.append(SESSION, 'decision: pin quota is dual-gated');
ok(notes.read(SESSION).includes('dual-gated'), 'notes append/read');
// legacy path migration (dsh-context-reset → dsh-context-manager)
const legacyDir = join(home, 'context-reset', 'notes');
mkdirSync(legacyDir, { recursive: true });
writeFileSync(join(legacyDir, 'legacy-session.md'), 'old note from context-reset era');
ok(notes.read('legacy-session').includes('old note'), 'legacy notes migrate lazily');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

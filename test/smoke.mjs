/* dsh-context-manager smoke test: pure-store semantics, no harness needed.
 * DSH_HOME is redirected to a temp dir so nothing touches real user data. */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
const WS_DIR = join(home, 'context-manager', 'pins', 'ws');

// ── workspaceSlug: hashed, normalized, collision-free ─────────────────────
ok(/^[0-9a-f]{16}$/.test(workspaceSlug(CWD)), 'slug is a 16-hex sha256 prefix');
ok(workspaceSlug(CWD) === workspaceSlug(`${CWD}/`), 'hash is stable across a trailing slash');
ok(workspaceSlug('/a/b') !== workspaceSlug('/a-b'), 'hash separates /a/b from /a-b');
ok(workspaceSlug('/Repo') !== workspaceSlug('/repo'), 'hash keeps case-sensitive paths apart');
ok(workspaceSlug(undefined) === workspaceSlug(process.cwd()), 'missing cwd resolves to the process cwd, not a shared "global" bucket');

// ── PinStore basics ───────────────────────────────────────────────────────
const store = new PinStore({ pinMaxChars: 200, pinsMaxChars: 300, windowRatio: 0.05, suggestCount: 2 });

const a1 = await store.alloc({ sessionId: SESSION, cwd: CWD, text: 'api endpoint: https://example.com/v1', label: 'API 端点', scope: 'task' });
ok(a1.accepted === true && a1.handle === 't1', 'alloc task → t1');

const a2 = await store.alloc({ sessionId: SESSION, cwd: CWD, text: 'palette: only --dsw-* vars', scope: 'permanent' });
ok(a2.accepted === true && a2.handle === 'w1', 'alloc permanent → w1');

const a3 = await store.alloc({ sessionId: SESSION, cwd: CWD, text: 'x'.repeat(250), scope: 'task' });
ok(a3.accepted === false && a3.reason.includes('per-pin cap'), 'per-pin cap rejects');

// Billed usage = text + label + handle row; the fallback cap is 300 chars here.
const b1 = await store.alloc({ sessionId: SESSION, cwd: CWD, text: 'y'.repeat(100), scope: 'task' });
ok(b1.accepted === true && b1.handle === 't2' && b1.chars === 146, 'alloc under quota → t2 (100 text + 40 label + 6 row)');
const b2 = await store.alloc({ sessionId: SESSION, cwd: CWD, text: 'z'.repeat(20), scope: 'task' });
ok(b2.accepted === true && b2.handle === 't3', 'alloc under quota → t3');
const b3 = await store.alloc({ sessionId: SESSION, cwd: CWD, text: 'q'.repeat(5), scope: 'task' });
ok(b3.accepted === false && b3.reason.includes('quota exceeded'), 'quota rejects at 305 > 300');
ok(b3.reason.includes('[t1] API 端点'), 'quota rejection names oldest task pins');
ok(!b3.reason.includes('w1'), 'suggestions stay within task scope');
ok(store.list({ sessionId: SESSION, cwd: CWD }, undefined).quota === 300, 'unresolved window falls back to pinsMaxChars');

// ── Quota 2: window-derived, label capped and billed ──────────────────────
// 5% of a 4096-token window = 614 chars: the old Math.max(1000, …) floor is gone.
const small = new PinStore({ pinMaxChars: 4000, pinsMaxChars: 100000, windowRatio: 0.05, suggestCount: 1 });
ok(small.list({ sessionId: 'sess-small', cwd: CWD }, 4096).quota === 614, 'quota is derived from the window with no absolute floor (4096 → 614)');
const s1 = await small.alloc({ sessionId: 'sess-small', cwd: CWD, text: 'q'.repeat(500), label: 'small', scope: 'task' }, 4096);
ok(s1.accepted === true && s1.quota === 614, 'a 511-char-billed pin fits the 614-char window quota');
const s2 = await small.alloc({ sessionId: 'sess-small', cwd: CWD, text: 'q'.repeat(620), label: 'small', scope: 'task' }, 4096);
ok(s2.accepted === false && s2.reason.includes('per-pin cap'), 'window-derived per-pin cap rejects it (no 1000-char floor)');

// A label is capped at 200 chars and billed together with the handle overhead.
const labelStore = new PinStore({ pinMaxChars: 4000, pinsMaxChars: 1000, windowRatio: 0.05, suggestCount: 1 });
const l1 = await labelStore.alloc({ sessionId: 'sess-label', cwd: CWD, text: 'k', label: 'L'.repeat(500), scope: 'task' });
ok(l1.accepted === true && l1.chars === 207, 'a 500-char label is capped at 200 and billed (1 + 200 + 6)');
const tight = new PinStore({ pinMaxChars: 4000, pinsMaxChars: 206, windowRatio: 0.05, suggestCount: 1 });
const t1 = await tight.alloc({ sessionId: 'sess-tight', cwd: CWD, text: 'k', label: 'L'.repeat(500), scope: 'task' });
ok(t1.accepted === false && t1.reason.includes('quota exceeded'), 'label and handle-row overhead count toward used (207 > 206)');

// window-ratio gate on a big-cap store with its own session file:
// 5% of 32000 tokens × 3 = 4800 chars — five 946-char-billed pins fit, the sixth doesn't
const store2 = new PinStore({ pinMaxChars: 1000, pinsMaxChars: 100000, windowRatio: 0.05, suggestCount: 2 });
let ratioOk = true;
for (let i = 0; i < 5; i += 1) {
  ratioOk =
    (await store2.alloc({ sessionId: 'sess-ratio', cwd: CWD, text: 'z'.repeat(900), scope: 'task' }, 32000)).accepted &&
    ratioOk;
}
ok(ratioOk, 'ratio store: 5 × 900 chars fit under the 4800 ratio cap');
const c6 = await store2.alloc({ sessionId: 'sess-ratio', cwd: CWD, text: 'z'.repeat(900), scope: 'task' }, 32000);
ok(c6.accepted === false && c6.reason.includes('quota exceeded'), 'window-ratio gate rejects the 6th (5676 > 4800)');
const c7 = await store2.alloc({ sessionId: 'sess-ratio', cwd: CWD, text: 'z'.repeat(900), scope: 'task' }, 200000);
ok(c7.accepted === true, 'same pin accepted under a big window (ratio gate relaxed)');

// ── free / handle monotonicity ────────────────────────────────────────────
const f1 = await store.free({ sessionId: SESSION, cwd: CWD, handle: 't1' });
ok(f1.accepted === true && f1.freed === 't1', 'free t1');
const f2 = await store.free({ sessionId: SESSION, cwd: CWD, handle: 't1' });
ok(f2.accepted === false && f2.reason.includes('not pinned'), 'double free rejected');
const f3 = await store.free({ sessionId: SESSION, cwd: CWD, handle: 'bogus' });
ok(f3.accepted === false, 'bogus handle rejected');
const a7 = await store.alloc({ sessionId: SESSION, cwd: CWD, text: 'after free', scope: 'task' });
ok(a7.handle === 't4', 'handles monotonic — freed t1 never reused');

// ── render ────────────────────────────────────────────────────────────────
const rendered = store.render(SESSION, CWD);
ok(rendered.includes('[w1] palette: only --dsw-* vars') && rendered.includes('[t2]'), 'render shows both scopes');
ok(rendered.indexOf('w1') < rendered.indexOf('t2'), 'workspace pins render before task pins');
ok(store.render('empty-session', '/nowhere') === '', 'empty vault → empty section');

// ── clearTask (/reset bulk-free): t1 freed earlier, so t2/t3/t4 = 3 pins ──
const cleared = await store.clearTask(SESSION);
ok(cleared.cleared === 3 && cleared.error === undefined, 'clearTask reports the real number freed');
ok(store.render(SESSION, CWD).includes('[w1]'), 'workspace pins survive clearTask');
ok(!store.render(SESSION, CWD).includes('[t2]'), 'task pins gone after clearTask');
const a8 = await store.alloc({ sessionId: SESSION, cwd: CWD, text: 'post-reset pin', scope: 'task' });
ok(a8.handle === 't5', 'handle counter survives clearTask — no ABA across /reset');

// ── corrupt store: quarantined, counter salvaged, never silently reset ────
const warnings = [];
const noisy = new PinStore({
  pinMaxChars: 4000,
  pinsMaxChars: 100000,
  windowRatio: 0.05,
  suggestCount: 1,
  logger: { warn: (message) => warnings.push(String(message)) },
});
const corruptPath = noisy.taskFile('sess-corrupt');
mkdirSync(dirname(corruptPath), { recursive: true });
writeFileSync(corruptPath, '{"nextHandle": 7, "pins": [ {"handle": "t1", "text": "broken"');
const salvaged = await noisy.alloc({ sessionId: 'sess-corrupt', cwd: CWD, text: 'after corruption', scope: 'task' });
ok(salvaged.accepted === true && salvaged.handle === 't7', 'corrupt store: nextHandle salvaged, handles not reused');
ok(warnings.some((w) => w.includes('corrupt pin store')), 'corrupt store is reported with a warning');
const quarantined = readdirSync(dirname(corruptPath)).filter((name) => name.startsWith('sess-corrupt.json.corrupt-'));
ok(quarantined.length === 1, 'corrupt store is quarantined, not overwritten');
ok(readFileSync(join(dirname(corruptPath), quarantined[0]), 'utf8').includes('broken'), 'quarantine keeps the original bytes');

const garbagePath = noisy.taskFile('sess-garbage');
writeFileSync(garbagePath, 'not json at all');
const restarted = await noisy.alloc({ sessionId: 'sess-garbage', cwd: CWD, text: 'restart', scope: 'task' });
ok(restarted.handle === 't1', 'unparseable store restarts the counter at 1');
ok(warnings.some((w) => w.includes('could not be salvaged')), 'the lost handle counter is called out in the warning');

const repairPath = noisy.taskFile('sess-repair');
writeFileSync(repairPath, JSON.stringify({ nextHandle: 1, pins: [{ handle: 't4', label: 'old', text: 'old', createdAt: 0 }] }));
const repaired = await noisy.alloc({ sessionId: 'sess-repair', cwd: CWD, text: 'new', scope: 'task' });
ok(repaired.handle === 't5', 'a counter below an existing handle is raised instead of reusing it');

// ── workspace isolation, sharing, and v1.1.0 slug migration ───────────────
ok(store.render('another-session', CWD).includes('[w1]'), 'same workspace, other session sees w1');
ok(store.render('another-session', '/elsewhere').includes('w1') === false, 'other workspace does not see w1');

const LEGACY_CWD = '/legacy-ws';
const legacyFile = join(WS_DIR, 'legacy-ws.json');
mkdirSync(WS_DIR, { recursive: true });
writeFileSync(legacyFile, JSON.stringify({ nextHandle: 5, pins: [{ handle: 'w4', label: 'legacy pin', text: 'kept verbatim', createdAt: 0 }] }));
const migrated = store.render('mig-session', LEGACY_CWD);
ok(migrated.includes('[w4] legacy pin') && migrated.includes('kept verbatim'), 'legacy slug file is migrated, pins kept');
ok(existsSync(legacyFile) === false, 'legacy slug file is renamed away');
ok(existsSync(join(WS_DIR, `${workspaceSlug(LEGACY_CWD)}.json`)), 'hashed workspace file exists after migration');
const afterMigrate = await store.alloc({ sessionId: 'mig-session', cwd: LEGACY_CWD, text: 'new ws pin', scope: 'permanent' });
ok(afterMigrate.handle === 'w5', 'migrated workspace file keeps its handle counter');

// ── cross-process and overlapping mutations (lockfile) ────────────────────
const overlapping = await Promise.all(
  Array.from({ length: 10 }, (_, i) => store.alloc({ sessionId: 'sess-concurrent', cwd: '/concurrent', text: `pin ${i}`, scope: 'task' })),
);
ok(overlapping.every((result) => result.accepted), 'overlapping in-process allocs are all accepted');
ok(new Set(overlapping.map((result) => result.handle)).size === 10, 'overlapping allocs get 10 distinct handles');
ok(store.list({ sessionId: 'sess-concurrent', cwd: '/concurrent' }, undefined).task.length === 10, 'no lost update under overlapping allocs');

const wide = new PinStore({ pinMaxChars: 4000, pinsMaxChars: 100000, windowRatio: 0.05, suggestCount: 1 });
const childSource = `const { PinStore } = await import(${JSON.stringify(new URL('../lib/malloc.js', import.meta.url).href)});
const store = new PinStore({ pinMaxChars: 4000, pinsMaxChars: 100000, windowRatio: 0.05, suggestCount: 1 });
for (let i = 0; i < 5; i += 1) {
  const result = await store.alloc({ sessionId: 'sess-multi', cwd: '/multi', text: 'child pin ' + i, scope: 'task' });
  if (!result.accepted) throw new Error('child alloc rejected: ' + result.reason);
}`;
const runChild = () =>
  new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', childSource], { env: process.env, stdio: 'inherit' });
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited with ${code}`))));
  });
await Promise.all([runChild(), runChild(), runChild(), runChild()]);
const multi = wide.list({ sessionId: 'sess-multi', cwd: '/multi' }, undefined).task;
ok(multi.length === 20, 'four processes × 5 allocs all survive (cross-process lockfile)');
ok(new Set(multi.map((pin) => pin.handle)).size === 20, 'cross-process handles are unique');

// ── NotesStore + legacy migration ─────────────────────────────────────────
const notes = new NotesStore(200);
ok(notes.read(SESSION) === '', 'notes empty initially');
await notes.append(SESSION, 'decision: pin quota is dual-gated');
ok(notes.read(SESSION).includes('dual-gated'), 'notes append/read');
// legacy path migration (dsh-context-reset → dsh-context-manager)
const legacyDir = join(home, 'context-reset', 'notes');
mkdirSync(legacyDir, { recursive: true });
writeFileSync(join(legacyDir, 'legacy-session.md'), 'old note from context-reset era');
ok(notes.read('legacy-session').includes('old note'), 'legacy notes migrate lazily');

// Migration must run BEFORE the first append, or the new file hides the legacy note.
writeFileSync(join(legacyDir, 'append-first.md'), 'legacy note that must not be hidden');
await notes.append('append-first', 'new note appended first');
const appendFirst = notes.read('append-first');
ok(appendFirst.includes('legacy note that must not be hidden'), 'migration runs before the first append (legacy text kept)');
ok(appendFirst.includes('new note appended first'), 'the append-first session keeps the new note too');

// A file the new build already wrote is never clobbered: legacy text is prepended.
const notesDir = join(home, 'context-manager', 'notes');
mkdirSync(notesDir, { recursive: true });
writeFileSync(join(notesDir, 'both.md'), 'note written by the new build');
writeFileSync(join(legacyDir, 'both.md'), 'note from the old build');
await notes.append('both', 'third note');
const both = notes.read('both');
ok(
  both.includes('note from the old build') && both.includes('note written by the new build') && both.includes('third note'),
  'an existing new notes file is merged, never clobbered',
);
ok(both.split('note from the old build').length === 2, 'the merge guard does not duplicate legacy text');
const truncatedNotes = new NotesStore(20);
await truncatedNotes.append('trunc-session', 'x'.repeat(100));
ok(
  truncatedNotes.read('trunc-session').includes('earlier chars not shown'),
  'notes truncation states how much was dropped',
);

// ── v1.4.2: clearTask surfaces a quarantined store instead of "none pinned" ──
const corruptTaskPath = noisy.taskFile('sess-clearcorrupt');
writeFileSync(corruptTaskPath, '{"nextHandle": 3, "pins": [BROKEN');
const clearedCorrupt = await noisy.clearTask('sess-clearcorrupt');
ok(clearedCorrupt.cleared === 0 && typeof clearedCorrupt.quarantined === 'string', 'clearTask reports the quarantine, not "no pins"');

// ── v1.4.2: a clipped nextHandle is raised over the highest visible handle ──
const clippedPath = noisy.taskFile('sess-clipped');
writeFileSync(clippedPath, '{"nextHandle": 1, "pins": [ {"handle": "t9", "text": "x", "label": "", "createdAt": 0}');
const clippedAlloc = await noisy.alloc({ sessionId: 'sess-clipped', cwd: CWD, text: 'after clip', scope: 'task' });
ok(clippedAlloc.accepted === true && clippedAlloc.handle === 't10', 'clipped counter raised above the highest visible handle (no re-issue)');

// ── v1.4.2: a failed quarantine rename warns once per file, not per load ──
const stormDir = dirname(noisy.taskFile('sess-storm'));
const stormPath = noisy.taskFile('sess-storm');
writeFileSync(stormPath, 'NOT JSON');
chmodSync(stormDir, 0o555);
warnings.length = 0;
noisy.load(stormPath);
noisy.load(stormPath);
noisy.load(stormPath);
chmodSync(stormDir, 0o755);
ok(warnings.filter((w) => w.includes('sess-storm')).length === 1, 'failed quarantine rename warns once per file per process');

// ── v1.5.0: render-time cap omits overflowing pins LOUDLY ────────────────
const capStore = new PinStore({ pinMaxChars: 4000, pinsMaxChars: 100000, windowRatio: 0.05, suggestCount: 1 });
await capStore.alloc({ sessionId: 'cap-session', cwd: '/cap', text: 'small fact one', label: 'one', scope: 'permanent' });
await capStore.alloc({ sessionId: 'cap-session', cwd: '/cap', text: 'y'.repeat(300), label: 'big', scope: 'task' });
await capStore.alloc({ sessionId: 'cap-session', cwd: '/cap', text: 'small fact two', label: 'two', scope: 'task' });
const capped = capStore.render('cap-session', '/cap', 120);
ok(capped.includes('[w1]'), 'the first pin always renders');
ok(capped.includes('vault overflow'), 'overflowing pins produce a loud overflow line');
ok(!capped.includes('y'.repeat(300)), 'the oversized pin body is omitted');
ok(capped.includes('small fact two'), 'pins under the cap still render after an omission');
ok(/t1/.test(capped.split('vault overflow')[1] ?? ''), 'the overflow line names the omitted handles');
ok(capStore.render('cap-session', '/cap').includes('y'.repeat(300)), 'without a cap everything still renders (backward compatible)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);


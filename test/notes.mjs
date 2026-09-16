/* dsh-context-manager structured notes (v1.4.0): supersedes chains, tag
 * buckets, sourceSeq provenance, JSONL migration. DSH_HOME redirected to a
 * temp dir so nothing touches real user data. */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-cm-notes-'));
process.env.DSH_HOME = home;

const { NotesStore, parseLegacyMarkdown } = await import('../lib/notes.js');

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

const SESSION = 'sess-notes';
const store = new NotesStore(8000);

// ── sequential ids and basic render ───────────────────────────────────────
const a1 = await store.append(SESSION, 'first decision: use JSONL');
ok(a1.accepted === true && a1.id === 'n1', 'first note gets n1');
const a2 = await store.append(SESSION, 'second decision: derived views only, because a stored copy rots whenever the log and the copy drift apart');
ok(a2.id === 'n2', 'second note gets n2');
ok(a2.fileChars > 0 && a2.viewChars > 0, 'append reports file and view sizes');
const view = store.read(SESSION);
ok(view.includes('[n1') && view.includes('first decision') && view.includes('[n2'), 'both notes render with ids');

// ── supersedes: the version chain folds the old note ──────────────────────
const a3 = await store.append(SESSION, 'corrected: views are derived, not stored', { supersedes: ['n2'] });
ok(a3.accepted === true && a3.id === 'n3', 'correction appends as n3');
const folded = store.read(SESSION);
ok(!folded.includes('drift apart'), 'superseded note folds to an 80-char preview (tail leaves the view)');
ok(folded.includes('[n2 → n3]'), 'folded audit line points at the successor');
ok(folded.includes('corrected: views are derived'), 'the correction is active');

// ── chain: ultimate successor wins ────────────────────────────────────────
await store.append(SESSION, 'final wording: the log is truth, views derive', { supersedes: ['n3'] });
const chained = store.read(SESSION);
ok(chained.includes('[n2 → n4]') && chained.includes('[n3 → n4]'), 'chain folds both ancestors to the ultimate successor');
const expanded = store.read(SESSION, { includeSuperseded: true });
ok(expanded.includes('second decision: derived views only'), 'includeSuperseded expands the folded text back');

// ── supersedes validation: dangling and malformed edges reject ────────────
const bad1 = await store.append(SESSION, 'dangling', { supersedes: ['n99'] });
ok(bad1.accepted === false && bad1.reason.includes('n99'), 'unknown supersedes target rejects with the id named');
const bad2 = await store.append(SESSION, 'malformed', { supersedes: ['x1'] });
ok(bad2.accepted === false && bad2.reason.includes('x1'), 'malformed supersedes id rejects');
const bad3 = await store.append(SESSION, '   ');
ok(bad3.accepted === false, 'empty note rejects');

// ── tags: hash buckets the model invents ──────────────────────────────────
await store.append(SESSION, 'eval result: reset arm 70%', { tags: ['Eval', 'pcg'] });
await store.append(SESSION, 'deploy note: chamber serves the page', { tags: ['deploy'] });
const evalBucket = store.read(SESSION, { tag: 'eval' });
ok(evalBucket.includes('reset arm 70%') && !evalBucket.includes('chamber'), 'tag filter reads one bucket only');
ok(store.read(SESSION, { tag: 'no-such-tag' }) === '', 'an unknown bucket reads empty');
const allTags = store.read(SESSION);
ok(allTags.includes('#eval #pcg'), 'tags render normalized (lowercase) next to the note id');

// ── sourceSeq: provenance pointer renders ─────────────────────────────────
await store.append(SESSION, 'fact with provenance', { sourceSeq: 179 });
ok(store.read(SESSION).includes('seq:179'), 'sourceSeq renders as a seq pointer');
const badSeq = await store.append(SESSION, 'bad provenance', { sourceSeq: -3 });
ok(badSeq.accepted === true && !store.read(SESSION).includes('seq:-3'), 'negative sourceSeq is ignored, note still records');

// ── legacy markdown parsing (incl. leading marker) ────────────────────────
const parsed = parseLegacyMarkdown('<!-- 2026-09-11T01:00:00.000Z -->\nalpha note\n\n<!-- 2026-09-12T02:00:00.000Z -->\nbeta note\n');
ok(parsed.length === 2 && parsed[0].text === 'alpha note' && parsed[0].ts.startsWith('2026-09-11'), 'leading-marker markdown parses into dated entries');
ok(!parsed[0].text.includes('<!--'), 'the marker never leaks into entry text');
ok(parseLegacyMarkdown('hand-written, no markers').length === 1, 'marker-less text becomes one entry');

// ── v1 markdown migration ─────────────────────────────────────────────────
const migDir = join(home, 'context-manager', 'notes');
mkdirSync(migDir, { recursive: true });
writeFileSync(join(migDir, 'mig-session.md'), '\n\n<!-- 2026-09-11T01:00:00.000Z -->\nold decision one\n\n<!-- 2026-09-12T02:00:00.000Z -->\nold decision two\n');
const migView = store.read('mig-session');
ok(migView.includes('old decision one') && migView.includes('[n1') && migView.includes('[n2'), 'v1 markdown migrates to numbered entries');
const continued = await store.append('mig-session', 'new note after migration');
ok(continued.id === 'n3', 'the id counter continues after migration');
ok(readFileSync(join(migDir, 'mig-session.md'), 'utf8').includes('old decision one'), 'the original markdown is left untouched');

// ── corrupt line: skipped with a warning, survivors readable ─────────────
const warnings = [];
const noisy = new NotesStore(8000, { logger: { warn: (m) => warnings.push(String(m)) } });
const corruptPath = join(migDir, 'corrupt-session.jsonl');
writeFileSync(corruptPath, '{"id":"n1","ts":"","text":"good note"}\n{"id":"n2",BROKEN\n{"id":"n3","ts":"","text":"survivor"}\n');
const corruptView = noisy.read('corrupt-session');
ok(corruptView.includes('good note') && corruptView.includes('survivor'), 'corrupt line skipped, valid notes survive');
ok(warnings.some((w) => w.includes('corrupt note line')), 'the corrupt line is reported, not silent');
const afterCorrupt = await noisy.append('corrupt-session', 'fresh note');
ok(afterCorrupt.id === 'n4', 'id counter survives corrupt lines (max id wins)');

// ── truncation safety valve still works on the structured view ────────────
const tiny = new NotesStore(60);
await tiny.append('tiny-session', 'x'.repeat(200));
ok(tiny.read('tiny-session').includes('earlier chars not shown'), 'over-budget views truncate with an explicit marker');

// ── v1.4.1: truncation drops whole oldest entries, never mid-entry ────────
const bounded = new NotesStore(75);
await bounded.append('bounded-session', 'oldest note body aaa');
await bounded.append('bounded-session', 'middle note body bbb');
await bounded.append('bounded-session', 'newest note body ccc');
const boundedView = bounded.read('bounded-session');
ok(boundedView.includes('newest note body ccc'), 'the newest note survives truncation');
ok(!boundedView.includes('oldest note body aaa'), 'the oldest note drops whole');
ok(/older notes? (dropped|truncated)/.test(boundedView), 'the drop marker states what happened');
ok(/\[n\d/.test(boundedView.split('\n')[1] ?? ''), 'the view resumes at an entry boundary, not mid-text');

// ── v1.4.1: wholly corrupt jsonl → quarantined, reseeded from markdown ────
const rescueWarnings = [];
const rescue = new NotesStore(8000, { logger: { warn: (m) => rescueWarnings.push(String(m)) } });
const rescueDir = join(home, 'context-manager', 'notes');
writeFileSync(join(rescueDir, 'rescue-session.md'), '<!-- 2026-09-10T00:00:00.000Z -->\nmarkdown original survives\n');
writeFileSync(join(rescueDir, 'rescue-session.jsonl'), 'GARBAGE\n{BROKEN\n');
const rescuedView = rescue.read('rescue-session');
ok(rescuedView.includes('markdown original survives'), 'wholly corrupt jsonl reseeds from the markdown');
ok(rescueWarnings.some((w) => w.includes('quarantined')), 'the corrupt store is quarantined with a warning');
const quarantineFiles = readdirSync(rescueDir).filter((name) => name.startsWith('rescue-session.jsonl.corrupt-'));
ok(quarantineFiles.length === 1, 'the corrupt store bytes are kept in quarantine');

// ── v1.4.1: newer markdown merges into an existing store (cross-version) ──
const mergeMd = join(rescueDir, 'merge-session.md');
writeFileSync(mergeMd, '<!-- 2026-09-15T00:00:00.000Z -->\nbase note from the v1 era\n');
store.read('merge-session'); // migrates the base note into the store
// …then an old (pre-v1.4.0) process appends another note to the markdown:
writeFileSync(
  mergeMd,
  '<!-- 2026-09-15T00:00:00.000Z -->\nbase note from the v1 era\n\n<!-- 2026-09-17T00:00:00.000Z -->\nlate note appended by an old process\n',
);
const future = new Date(Date.now() + 60000);
utimesSync(mergeMd, future, future);
const mergedView = store.read('merge-session');
ok(mergedView.includes('late note appended by an old process'), 'newer markdown entries merge into the store');
ok(mergedView.split('base note from the v1 era').length === 2, 'already-migrated entries are not duplicated');
const remerge = store.read('merge-session');
ok(remerge.split('late note appended by an old process').length === 2, 'a second read does not re-merge (idempotent)');

// ── v1.4.1: fetch one note by id, including its chain status ─────────────
const byId = store.read(SESSION, { id: 'n2' });
ok(byId.includes('second decision') && byId.includes('superseded by n4'), 'notes_read by id returns the verbatim note plus chain status');
ok(store.read(SESSION, { id: 'n4' }).includes('final wording') && !store.read(SESSION, { id: 'n4' }).includes('superseded by'), 'an active note fetched by id carries no chain caveat');
ok(store.read(SESSION, { id: 'n999' }) === '', 'an unknown id reads empty');

// ── v1.4.2: multiple successors all surface in the audit trail ────────────
const multi = new NotesStore(8000);
await multi.append('fork-session', 'original claim');
await multi.append('fork-session', 'correction A', { supersedes: ['n1'] });
await multi.append('fork-session', 'correction B', { supersedes: ['n1'] });
const forkView = multi.read('fork-session');
ok(forkView.includes('[n1 → n2, n3]'), 'both successors render in the folded audit line');
ok(multi.read('fork-session', { id: 'n1' }).includes('superseded by n2, n3'), 'by-id read reports every successor');

// ── v1.4.2: folded and by-id rows carry tags/seq metadata ────────────────
const meta = new NotesStore(8000);
await meta.append('meta-session', 'tagged claim', { tags: ['eval'], sourceSeq: 42 });
await meta.append('meta-session', 'updated claim', { supersedes: ['n1'] });
const metaFolded = meta.read('meta-session');
ok(metaFolded.includes('[n1 → n2 #eval seq:42]'), 'the folded line keeps tags and sourceSeq');
ok(meta.read('meta-session', { id: 'n1' }).includes('#eval seq:42'), 'the by-id read keeps tags and sourceSeq');

// ── v1.4.2: invalid tags reject honestly instead of dropping silently ─────
const spacey = await meta.append('meta-session', 'note', { tags: ['my bucket'] });
ok(spacey.accepted === false && spacey.reason.includes('my bucket'), 'a tag with spaces rejects with the tag named');
const tooMany = await meta.append('meta-session', 'note', { tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] });
ok(tooMany.accepted === false && tooMany.reason.includes('at most 8'), 'more than 8 tags rejects');

// ── v1.4.2: append persists the newer-markdown merge under the lock ───────
const persistMd = join(rescueDir, 'persist-session.md');
writeFileSync(persistMd, '<!-- 2026-09-15T00:00:00.000Z -->\nbase note\n');
store.read('persist-session');
writeFileSync(
  persistMd,
  '<!-- 2026-09-15T00:00:00.000Z -->\nbase note\n\n<!-- 2026-09-17T01:00:00.000Z -->\nlate md note\n',
);
utimesSync(persistMd, future, future);
ok(store.read('persist-session').includes('late md note'), 'read path views the merge in memory');
ok(!readFileSync(join(rescueDir, 'persist-session.jsonl'), 'utf8').includes('late md note'), 'read path does not persist the merge');
await store.append('persist-session', 'fresh note');
ok(readFileSync(join(rescueDir, 'persist-session.jsonl'), 'utf8').includes('late md note'), 'append persists the merge under the lock');
ok(store.read('persist-session').split('late md note').length === 2, 'persisted merge does not duplicate on later reads');

// ── v1.5.0: listTags enumerates the buckets ───────────────────────────────
const buckets = store.read(SESSION, { listTags: true });
ok(buckets.includes('#eval') && buckets.includes('#pcg'), 'listTags shows the invented buckets');
ok(/#eval \(\d+ active\)/.test(buckets), 'listTags counts active notes per bucket');
ok(!buckets.includes('#deploy (0'), 'buckets with only superseded notes are not listed as active');
ok(store.read('empty-tags-session', { listTags: true }) === '(no tags yet)', 'listTags on an empty diary says so');

// ── v1.5.0: the truncation marker names the dropped ids and the way back ──
const named = new NotesStore(75);
await named.append('named-session', 'first body aaa');
await named.append('named-session', 'second body bbb');
await named.append('named-session', 'third body ccc');
const namedView = named.read('named-session');
ok(namedView.includes('(n1)'), 'the drop marker lists the dropped note ids');
ok(namedView.includes('notes_read({ id })'), 'the drop marker teaches the by-id escape hatch');
ok(named.read('named-session', { id: 'n1' }).includes('first body aaa'), 'a dropped note is still reachable by id');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

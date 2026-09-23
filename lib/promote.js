import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { JEV_PROMOTE_THRESHOLD, jevJudgePromotable, jevLog } from './jev.js';
import { withFileLock } from './lock.js';

/**
 * dsh-context-manager — skill promoter ("the fifth layer precipitates").
 *
 * The memory pyramid is log → note → skill: a note the model keeps
 * re-fetching is procedural knowledge riding the diary forever, when it
 * should crystallize into an on-demand skill file (one catalog line, body
 * loaded only when triggered). This module is the deterministic half of the
 * pipeline — "triggers ungated, content gated" (the Jev half lives in
 * jev.js):
 *
 *   notes_read({ id }) → record the fetch (workspace-level stats file)
 *     → deterministic gate: fetches ≥ MIN_FETCHES across ≥ MIN_DAYS distinct
 *       days, note age ≥ MIN_AGE_DAYS, not superseded, no suggestion in the
 *       last COOLDOWN_DAYS
 *     → Jev content gate: is this a reusable PROCEDURE (not a fact,
 *       credential pointer, or one-off conclusion)?
 *     → suggest: a hint appended to the notes_read result. Suggest-only —
 *       the model drafts the SKILL.md, the user approves, and a superseding
 *       note sheds the diary weight. Nothing is written but the stats file.
 *
 * Stats live workspace-level (skills are workspace-level too):
 * <dsh home>/context-manager/note-stats.json, one entry per
 * `${sessionId}::${noteId}`. The file is rewritten whole under the shared
 * lockfile — it stays tiny (fetch arrays are capped, entries are a few
 * hundred bytes).
 * @module dsh-context-manager/promote
 */

/** Deterministic gate constants (measured against the author's own diary). */
export const MIN_FETCHES = 4;
export const MIN_DAYS = 3;
export const MIN_AGE_DAYS = 3;
export const COOLDOWN_DAYS = 7;
/** Keep at most this many fetch timestamps per entry (the gate needs days, not history). */
const MAX_FETCH_STAMPS = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

function statsPath() {
  return dshHomePath('context-manager', 'note-stats.json');
}

function loadStats() {
  const path = statsPath();
  try {
    if (!existsSync(path)) return { version: 1, notes: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed?.notes !== 'object' || parsed.notes === null) return { version: 1, notes: {} };
    return { version: 1, notes: parsed.notes };
  } catch {
    // A corrupt stats file must never break a read — statistics are
    // derivable by simply living longer. Start over.
    return { version: 1, notes: {} };
  }
}

/** Persist stats atomically (tmp + rename). Callers MUST hold the lock. */
function saveStats(stats) {
  const path = statsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stats)}\n`);
  renameSync(tmp, path);
}

function dayOf(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '';
}

/**
 * Record one by-id fetch and return the candidate evaluation, atomically.
 *
 * @param {string} key - `${sessionId}::${noteId}`.
 * @returns {Promise<{fetches: number, days: number, lastSuggested?: string}>}
 */
export async function recordFetch(key, { logger } = {}) {
  return await withFileLock(
    statsPath(),
    () => {
      const stats = loadStats();
      const entry = stats.notes[key] ?? { fetches: [] };
      entry.fetches = [...(Array.isArray(entry.fetches) ? entry.fetches : []), new Date().toISOString()].slice(
        -MAX_FETCH_STAMPS,
      );
      stats.notes[key] = entry;
      saveStats(stats);
      return summarize(entry);
    },
    { logger },
  );
}

/** Read-only view of one stats entry (for tests and the gate). */
export function statsFor(key) {
  const entry = loadStats().notes[key];
  return entry === undefined ? { fetches: 0, days: 0 } : summarize(entry);
}

function summarize(entry) {
  const stamps = Array.isArray(entry.fetches) ? entry.fetches : [];
  return {
    fetches: stamps.length,
    days: new Set(stamps.map(dayOf).filter((day) => day.length > 0)).size,
    ...(typeof entry.suggested === 'string' ? { lastSuggested: entry.suggested } : {}),
  };
}

/** Mark a suggestion as given (starts the cooldown). Callers MUST NOT hold the lock. */
export async function markSuggested(key, { logger } = {}) {
  await withFileLock(
    statsPath(),
    () => {
      const stats = loadStats();
      const entry = stats.notes[key] ?? { fetches: [] };
      entry.suggested = new Date().toISOString();
      stats.notes[key] = entry;
      saveStats(stats);
    },
    { logger },
  );
}

/**
 * The deterministic gate. `note` is the NotesStore entry ({ id, ts, text })
 * plus its chain status; `stats` is the summarize() shape.
 *
 * @returns {{eligible: boolean, reason: string}}
 */
export function deterministicGate({ note, superseded, stats }, now = Date.now()) {
  if (superseded) return { eligible: false, reason: 'superseded' };
  const ageMs = note.ts ? now - Date.parse(note.ts) : 0;
  if (!(ageMs >= MIN_AGE_DAYS * DAY_MS)) return { eligible: false, reason: `too young (< ${MIN_AGE_DAYS}d)` };
  if (stats.fetches < MIN_FETCHES) return { eligible: false, reason: `fetches ${stats.fetches} < ${MIN_FETCHES}` };
  if (stats.days < MIN_DAYS) return { eligible: false, reason: `days ${stats.days} < ${MIN_DAYS}` };
  if (stats.lastSuggested !== undefined) {
    const since = now - Date.parse(stats.lastSuggested);
    if (since < COOLDOWN_DAYS * DAY_MS) return { eligible: false, reason: 'cooldown' };
  }
  return { eligible: true, reason: 'ok' };
}

/** The suggestion appended to a notes_read result (suggest-only, human-gated). */
export function suggestionText({ id, stats, probability }) {
  return (
    `\n\n📌 skill-promoter: note ${id} has been fetched ${stats.fetches} times across ${stats.days} distinct days, ` +
    `and Jev judges it a reusable procedure (p=${probability.toFixed(2)}). Consider crystallizing it into an on-demand skill:\n` +
    `1. ask_user_question to confirm with the user (creating a skill modifies the workspace — never do it uninvited);\n` +
    `2. on approval, write ~/.agents/skills/<kebab-name>/SKILL.md with YAML frontmatter (name, description carrying the trigger conditions) and the procedure as the body;\n` +
    `3. notes_append({ supersedes: ["${id}"], text: "已固化为 skill <name>: <one-line summary + path>" }) so the diary sheds the body and keeps a pointer.\n` +
    `Doing nothing is fine — this candidate snoozes for ${COOLDOWN_DAYS} days automatically.`
  );
}

/**
 * Full promote check for one by-id read: deterministic gate, then the Jev
 * content gate, then the suggestion text (and the cooldown stamp). Returns
 * undefined when there is nothing to suggest — the common path by far. Jev
 * failure degrades to NO suggestion and is logged, per the recorded-degrade
 * rule; a judge outage must never turn into suggestion spam.
 */
export async function maybeSuggest({ key, note, superseded, jevApiKey, session, logger, fetchImpl }) {
  const stats = statsFor(key);
  const gate = deterministicGate({ note, superseded, stats });
  if (!gate.eligible) return undefined;
  const evidence = `fetched ${stats.fetches} times across ${stats.days} distinct days (thresholds: ${MIN_FETCHES} fetches / ${MIN_DAYS} days)`;
  const probability = await jevJudgePromotable({
    apiKey: jevApiKey,
    noteText: note.text.slice(0, 2000),
    evidence,
    fetchImpl,
    onDegrade: (reason) => jevLog(`promote judge degraded (${reason}) — no suggestion for ${key}`, session),
  });
  if (probability === null) return undefined;
  if (probability < JEV_PROMOTE_THRESHOLD) {
    jevLog(`promote judge rejected ${key} (p=${probability.toFixed(2)} < ${JEV_PROMOTE_THRESHOLD})`, session);
    // A content rejection is a verdict about the note, not about timing —
    // cool down so the judge is not re-asked on every later fetch.
    await markSuggested(key, { logger });
    return undefined;
  }
  await markSuggested(key, { logger });
  jevLog(
    `promote suggested ${key} (fetches=${stats.fetches}, days=${stats.days}, p=${probability.toFixed(2)})`,
    session,
  );
  return suggestionText({ id: note.id, stats, probability });
}

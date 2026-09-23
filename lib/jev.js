import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

/**
 * Jev (TypeSafe System One) relevance reranker for the retrieval pipeline.
 *
 * The pipeline's strength gate is a score threshold; Jev replaces "how high"
 * with "is it actually relevant" — one HTTP call judges every candidate in
 * parallel (the questions map fans out per candidate). Any failure returns
 * null so the pipeline falls back to the plain score gate: Jev is a
 * refinement, never a point of failure.
 */

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 8000;

/**
 * Short tag for one session id: `session-e589b4cd-…` → `e589b4cd`. The log is
 * shared by every session in the workspace, so a line without it can only be
 * attributed by guessing from timestamps.
 *
 * @param {object|string} [session] - a session, or a session id.
 * @returns {string} the tag, or '' when there is nothing to tag.
 */
function sessionTag(session) {
  const id = typeof session === 'string' ? session : session?.id;
  if (typeof id !== 'string' || id.length === 0) return '';
  return id.replace(/^session-/, '').slice(0, 8);
}

/**
 * Record one Jev decision (enabled/disabled state, kept counts, degrade
 * reasons) where a human can actually see it: the terminal AND
 * `<dsh home>/context-manager/jev.log`. `ctx.logger` alone was not enough —
 * the harness registers no console exporter for it, so a line that only went
 * to the logger's in-memory ring buffer was unverifiable in practice.
 * Diagnostics must never break the pipeline: every failure is swallowed.
 *
 * @param {string} line - one line, without timestamp or prefix.
 * @param {object|string} [session] - session (or id) the line belongs to; its
 *   short tag is prefixed so interleaved sessions stay readable.
 */
export function jevLog(line, session) {
  const tag = sessionTag(session);
  const text = tag.length === 0 ? line : `[${tag}] ${line}`;
  console.log(`[context-manager] ${text}`);
  try {
    const file = dshHomePath('context-manager', 'jev.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {
    /* a full disk or a read-only home must not fail a turn */
  }
}

/**
 * @param {object} input
 * @param {string} input.apiKey - Bearer key (test or production).
 * @param {string} input.request - the latest user message.
 * @param {Array<{seq: number, snippet: string}>} input.candidates - pipeline hits to judge.
 * @param {function} [input.fetchImpl] - injectable for tests; defaults to global fetch.
 * @returns {Promise<Array<{seq: number, probability: number}> | null>} null on any failure.
 */
export async function jevRerank({ apiKey, request, candidates, fetchImpl, onDegrade }) {
  const degrade = (reason) => {
    onDegrade?.(reason);
    return null;
  };
  if (!apiKey) return degrade('no api key');
  if (candidates.length === 0) return degrade('no candidates');
  let lastError = 'unknown';
  const doFetch = fetchImpl ?? fetch;
  const questions = {};
  for (const candidate of candidates) {
    questions[`cand_${candidate.seq}`] = {
      type: 'noul',
      instructions: {
        context:
          "The `request` is the user's latest message to an AI assistant. The `history_hit` is a snippet retrieved from their long conversation history with that assistant.",
        question:
          'Is `history_hit` materially relevant to fulfilling `request` — does it contain specific facts from the shared history that a good answer should use, rather than being unrelated or merely topically similar?',
        request,
        history_hit: candidate.snippet,
      },
    };
  }
  const body = JSON.stringify({ state: request, model: JEV_MODEL, questions });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await doFetch(JEV_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      if (!response.ok) return degrade(`http ${response.status}`);
      const payload = await response.json();
      const answers = payload?.answers;
      if (answers === undefined || answers === null) return degrade('malformed payload (no answers)');
      const out = [];
      for (const candidate of candidates) {
        const answer = answers[`cand_${candidate.seq}`];
        if (typeof answer?.noul !== 'number')
          return degrade(`malformed payload (missing noul for seq ${candidate.seq})`);
        out.push({ seq: candidate.seq, probability: answer.noul });
      }
      return out;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return degrade(`network error: ${lastError}`);
}

/** Default relevance threshold; below this a hit is treated as noise. */
export const JEV_RELEVANCE_THRESHOLD = 0.5;

/**
 * Note-worthiness threshold — deliberately higher than the relevance one.
 * Measured (one fanned-out call, 10 spans, 2026-09-21): durable content scores
 * 0.81–0.89 (mean 0.85) while routine churn scores 0.21–0.61 (mean 0.35), so
 * 0.7 sits inside the empty band and separates them 5/5 vs 0/5. Relevance is
 * "does this help answer?"; a note must survive a future session, so the bar is
 * "would a future session be worse off without this?" — ask less, record better.
 */
export const JEV_NOTE_THRESHOLD = 0.7;

/**
 * Page selection: which history strata ("pages") are worth reading for this
 * request — ReadAgent's choose-pages as a calibrated judgment instead of a
 * keyword guess. One fanned-out noul call, one question per page.
 *
 * @param {object} input
 * @param {string} input.apiKey
 * @param {string} input.request - the latest user message.
 * @param {Array<{fromSeq: number, toSeq: number, digest: string}>} input.pages
 * @param {function} [input.fetchImpl]
 * @returns {Promise<Array<{fromSeq: number, toSeq: number, probability: number}> | null>}
 */
export async function jevSelectPages({ apiKey, request, pages, fetchImpl, onDegrade }) {
  const degrade = (reason) => {
    onDegrade?.(reason);
    return null;
  };
  if (!apiKey) return degrade('no api key');
  if (pages.length === 0) return degrade('no pages');
  let lastError = 'unknown';
  const doFetch = fetchImpl ?? fetch;
  const questions = {};
  pages.forEach((page, index) => {
    questions[`page_${index}`] = {
      type: 'noul',
      instructions: {
        context:
          "The `request` is the user's latest message to an AI assistant. Their long conversation history is split into chronological pages; `page_digest` lists the most frequent keywords and entities of one page (the assistant cannot see the history itself).",
        question:
          'Does the history page described by `page_digest` likely contain specific facts or content needed to fulfill `request` well — is it worth re-reading that page before answering?',
        request,
        page_digest: page.digest,
      },
    };
  });
  const body = JSON.stringify({ state: request, model: JEV_MODEL, questions });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await doFetch(JEV_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      if (!response.ok) return degrade(`http ${response.status}`);
      const payload = await response.json();
      const answers = payload?.answers;
      if (answers === undefined || answers === null) return degrade('malformed payload (no answers)');
      const out = [];
      for (const [index, page] of pages.entries()) {
        const answer = answers[`page_${index}`];
        if (typeof answer?.noul !== 'number') return degrade(`malformed payload (missing noul for page_${index})`);
        out.push({ fromSeq: page.fromSeq, toSeq: page.toSeq, probability: answer.noul });
      }
      return out;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return degrade(`network error: ${lastError}`);
}

/**
 * Skill-promotion threshold — same calibrated band as the note gate (see
 * JEV_NOTE_THRESHOLD): a false positive here pesters the user with a skill
 * suggestion, a false negative only keeps a hot note in the diary.
 */
export const JEV_PROMOTE_THRESHOLD = 0.7;

/**
 * Promotability: is a frequently re-fetched note a REUSABLE PROCEDURE that
 * should crystallize into a skill file? The deterministic half (fetch count,
 * distinct days, age, cooldown) decides WHEN asking is affordable; this is
 * the content gate — facts, credentials and one-off conclusions must stay
 * notes/pins and never become skills.
 *
 * @param {object} input
 * @param {string} input.apiKey - Bearer key.
 * @param {string} input.noteText - the candidate note, verbatim.
 * @param {string} input.evidence - fetch statistics rendered for the judge.
 * @param {function} [input.fetchImpl] - injectable for tests.
 * @returns {Promise<number | null>} probability, or null on any failure.
 */
export async function jevJudgePromotable({ apiKey, noteText, evidence, fetchImpl, onDegrade }) {
  const degrade = (reason) => {
    onDegrade?.(reason);
    return null;
  };
  if (!apiKey) return degrade('no api key');
  let lastError = 'unknown';
  const doFetch = fetchImpl ?? fetch;
  const questions = {
    candidate: {
      type: 'noul',
      instructions: {
        context:
          'The `note` is one durable memory entry the assistant keeps re-fetching (`evidence` = how often). Recurring PROCEDURES belong in an on-demand skill file; facts do not.',
        question:
          'Is `note` a reusable PROCEDURE or workflow — repeatable steps, a how-to, an operational runbook the assistant will need to PERFORM again — rather than a fact, credential location, preference, experiment conclusion, or one-off project state that should stay a plain note?',
        note: noteText,
        evidence,
      },
    },
  };
  const body = JSON.stringify({ state: noteText, model: JEV_MODEL, questions });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await doFetch(JEV_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      if (!response.ok) return degrade(`http ${response.status}`);
      const payload = await response.json();
      const answer = payload?.answers?.candidate;
      if (typeof answer?.noul !== 'number') return degrade('malformed payload (missing noul for candidate)');
      return answer.noul;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return degrade(`network error: ${lastError}`);
}

/**
 * Note-worthiness: which stretches of the work just finished hold facts the
 * assistant's recorded memory does not already carry. This is the content gate
 * behind the memory nudge — the rule half (a token floor and a rate limit)
 * only decides when asking is affordable.
 *
 * The shape matters more than the model here. A judge asked "does the request
 * need history?" was measured INVERTED (zero-retrieval questions score lower —
 * their defining feature is the absence of a surface signal), so triggers are
 * never judged from the request. Note-worthiness is asked the way Jev is
 * calibrated: a contrastive pick over concrete spans, against the memory that
 * already exists, with the honest alternative (routine churn) spelled out.
 *
 * @param {object} input
 * @param {string} input.apiKey - Bearer key.
 * @param {string} input.recorded - rendered memory so far (diary + vault).
 * @param {Array<{fromSeq: number, toSeq: number, digest: string, excerpt: string}>} input.spans
 * @param {function} [input.fetchImpl] - injectable for tests.
 * @returns {Promise<Array<{fromSeq: number, toSeq: number, probability: number}> | null>} null on any failure.
 */
export async function jevSelectNoteSpans({ apiKey, recorded, spans, fetchImpl, onDegrade }) {
  const degrade = (reason) => {
    onDegrade?.(reason);
    return null;
  };
  if (!apiKey) return degrade('no api key');
  if (spans.length === 0) return degrade('no spans');
  let lastError = 'unknown';
  const doFetch = fetchImpl ?? fetch;
  const questions = {};
  spans.forEach((span, index) => {
    questions[`span_${index}`] = {
      type: 'noul',
      instructions: {
        context:
          'The `recorded_memory` is what the assistant has already written down about this work: its diary notes and its pinned vault. The `span` is one contiguous slice of the work it has just finished, given as a seq range, a keyword digest, and an excerpt.',
        question:
          'Does `span` hold a durable fact a FUTURE session would need — a decided constraint, an exact identifier/path/version, a ruled-out dead end, or the state of unfinished work — that `recorded_memory` does not already capture, rather than routine churn or content the record already implies?',
        recorded_memory: recorded,
        span: `seq ${span.fromSeq}..${span.toSeq} (${span.digest}): ${span.excerpt}`,
      },
    };
  });
  const body = JSON.stringify({ state: recorded, model: JEV_MODEL, questions });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await doFetch(JEV_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      if (!response.ok) return degrade(`http ${response.status}`);
      const payload = await response.json();
      const answers = payload?.answers;
      if (answers === undefined || answers === null) return degrade('malformed payload (no answers)');
      const out = [];
      for (const [index, span] of spans.entries()) {
        const answer = answers[`span_${index}`];
        if (typeof answer?.noul !== 'number') return degrade(`malformed payload (missing noul for span_${index})`);
        out.push({ fromSeq: span.fromSeq, toSeq: span.toSeq, probability: answer.noul });
      }
      return out;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return degrade(`network error: ${lastError}`);
}

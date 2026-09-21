/**
 * Runtime topic map for page selection (ReadAgent-style "pages"): the session
 * log in 10 strata, each with a mechanical topTerms digest and a densest-event
 * excerpt. Same strata recipe as the checkpoint map (engine.js), cached per
 * session object and rebuilt only after the log grew meaningfully — the map
 * is a retrieval hint, not gospel, so staleness is cheap.
 */
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { readEventText } from './history.js';
import { topTerms } from './tokens.js';

const STRATA = 10;
const PER_STRATUM_EVENTS = 40;
const PER_EVENT_CHARS = 4000;
const REBUILD_AFTER_EVENTS = 500;
const EXCERPT_CHARS = 300;

const cache = new WeakMap(); // session → { builtAtSeq, pages }

/**
 * @returns {Array<{fromSeq: number, toSeq: number, digest: string, excerpt: string}>}
 */
export function sessionTopicMap(session) {
  const cached = cache.get(session);
  const lastSeq = session.seq - 1;
  if (cached !== undefined && lastSeq - cached.builtAtSeq < REBUILD_AFTER_EVENTS) return cached.pages;

  const pages = [];
  for (let s = 0; s < STRATA; s += 1) {
    const start = Math.floor((s * (lastSeq + 1)) / STRATA);
    const end = Math.floor(((s + 1) * (lastSeq + 1)) / STRATA) - 1;
    if (end < start) continue;
    const step = Math.max(1, Math.ceil((end - start + 1) / PER_STRATUM_EVENTS));
    let corpus = '';
    let densest = '';
    for (let seq = start; seq <= end && corpus.length < 60000; seq += step) {
      const event = session.eventAt(SessionSeq(seq));
      if (event === undefined) continue;
      const text = readEventText(session, event);
      if (text.length === 0) continue;
      corpus += `${text.slice(0, PER_EVENT_CHARS)}\n`;
      if (text.length > densest.length) densest = text;
    }
    const topics = topTerms(corpus, 5);
    if (topics.length === 0) continue;
    const excerpt = densest.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
    pages.push({ fromSeq: start, toSeq: end, digest: topics.join(' / '), excerpt });
  }
  cache.set(session, { builtAtSeq: lastSeq, pages });
  return pages;
}

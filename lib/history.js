import { SessionSeq } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * dsh-context-manager — full-log retrieval ("the swap").
 *
 * Nothing is ever deleted: compaction and /reset only shadow events from the
 * session surface; the log keeps every event. These tools let the model page
 * any of it back in on demand — keyword search first for seq anchors, then an
 * exact range read. The read also pages WITHIN an oversized single event via a
 * character cursor, so no event is ever dropped whole.
 * @module dsh-context-manager/history
 */

export const HISTORY_SEARCH_TOOL = 'history_search';
export const HISTORY_READ_TOOL = 'history_read';

/** Per-search result ceiling so a broad query cannot flood the context. */
const HISTORY_SEARCH_MAX_MATCHES = 50;
/** Snippet radius around a search hit; the hit itself is always inside it. */
const SNIPPET_RADIUS_CHARS = 120;
/** Max events one history_read call may span. */
const HISTORY_READ_MAX_EVENTS = 200;

/** Verbatim text of one message-content block; unknown shapes degrade to JSON. */
function blockText(block) {
  if (typeof block?.text === 'string') return block.text;
  if (block?.type === 'tool-call') return `${block.name} ${JSON.stringify(block.arguments ?? {})}`;
  if (block?.type === 'tool-result' && Array.isArray(block.content)) {
    // Unwrap the tool-result envelope: search and snippets see the tool's
    // actual output text, not its JSON container.
    return block.content.map((inner) => blockText(inner)).join('\n');
  }
  try {
    return JSON.stringify(block);
  } catch {
    return '';
  }
}

/** Plain text of one model-visible message, or null when it carries no content. */
function messageText(message) {
  if (message === null || message === undefined || !Array.isArray(message.content)) return null;
  return message.content.map(blockText).join('\n');
}

/**
 * Extract the FULL text of one session event — no truncation: a match at
 * char 50 000 is still found, and read-back is never silently cut. The frozen
 * model-visible message wins (user/message carries it as `data`, assistant and
 * tool events as `data.message`); anything else falls back to JSON.
 * @param {object} event - session event.
 * @param {object|null} [derivedMessage] - session.deriveEventMessage(event).
 */
export function eventText(event, derivedMessage) {
  for (const candidate of [derivedMessage, event?.data?.message, event?.data]) {
    const text = messageText(candidate);
    if (text !== null) return text;
  }
  if (!event?.data || typeof event.data !== 'object') return '';
  try {
    return JSON.stringify(event.data);
  } catch {
    return '';
  }
}

/** Admit a caller-supplied seq as a non-negative integer inside the log. */
function clampSeq(value, lastSeq) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.min(Math.max(number, 0), lastSeq);
}

/** Model-visible text of one event: the message projection is preferred.
 * Exported for the reset engine's mechanical extraction pass. */
export function readEventText(session, event) {
  let derived = null;
  try {
    derived = session.deriveEventMessage(event);
  } catch {
    derived = null;
  }
  return eventText(event, derived);
}

/** Char volume of the events that a truncated read did not emit. */
function unreadChars(session, from, to) {
  let sum = 0;
  for (let seq = from; seq <= to; seq += 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    sum += readEventText(session, event).length;
  }
  return sum;
}

/** Tool names whose own calls/results are excluded from search (self-reference noise). */
const MEMORY_TOOL_NAMES = new Set([
  'history_search',
  'history_read',
  'context_alloc',
  'context_free',
  'context_list',
  'notes_append',
  'notes_read',
]);

/** Split a query into lowercase terms on whitespace; each run is one term. */
function queryTerms(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/** callId carried by a tool/result event's message source, when present. */
function resultCallId(event) {
  return event?.data?.message?.source?.callId ?? event?.data?.callId ?? null;
}

/** Count occurrences of term in text, capped at `cap` for bounded cost. */
function countOccurrences(haystack, term, cap = 20) {
  let count = 0;
  let from = 0;
  while (count < cap) {
    const index = haystack.indexOf(term, from);
    if (index < 0) break;
    count += 1;
    from = index + term.length;
  }
  return count;
}

/**
 * Search the full session log — shadowed (compacted-away) events included.
 *
 * Matching is a hybrid, closest to how the official session query behaves
 * (phrase over an index, density-ranked) while staying substring-only:
 *   tier 0 — the whole query appears as one literal phrase;
 *   tier 1 — every whitespace-separated term appears in the event (AND);
 *   tier 2 — only used when no tier-0/1 hit exists: events matching some terms.
 * Within a tier: more term occurrences wins, then denser (shorter) events,
 * then newer seq. The agent's own memory-tool calls/results are skipped so a
 * query can never flood itself with the current turn's search traffic; pass
 * `beforeSeq` to bound the scan below a known seq (e.g. the current turn).
 * Each match reports `offset` (char index of the anchor hit), which
 * history_read's offset cursor can continue from directly.
 */
export function historySearch(session, { query, limit = 10, beforeSeq, includeSelf = false }) {
  const iterator = historySearchChunks(session, { query, limit, beforeSeq, includeSelf });
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

/**
 * Async twin of historySearch: the same generator, awaited between chunks so
 * a wide scan over a hundred-thousand-event log cannot block the event loop
 * for seconds (the GUI and sibling agents stay responsive).
 */
export async function historySearchAsync(session, { query, limit = 10, beforeSeq, includeSelf = false }) {
  const iterator = historySearchChunks(session, { query, limit, beforeSeq, includeSelf });
  let step = iterator.next();
  while (!step.done) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    step = iterator.next();
  }
  return step.value;
}

/** Events scanned between cooperative yields. */
const SEARCH_YIELD_EVERY = 2000;

/**
 * The search core as a generator: yields (to the event loop, when driven
 * async) every SEARCH_YIELD_EVERY scanned events, and returns the result.
 */
function* historySearchChunks(session, { query, limit = 10, beforeSeq, includeSelf = false }) {
  const needle = String(query ?? '').toLowerCase();
  const terms = queryTerms(query);
  const cap = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 10, HISTORY_SEARCH_MAX_MATCHES));
  if (terms.length === 0) return { matches: [], scanned: 0, tier: null };
  const lastSeq = session.seq - 1;
  const scanFrom = beforeSeq === undefined ? lastSeq : Math.min(Math.max(Math.trunc(beforeSeq) - 1, -1), lastSeq);

  // Call IDs of the agent's own memory-tool calls, so their results can be skipped too.
  const selfCallIds = new Set();
  if (!includeSelf) {
    for (let seq = 0; seq <= lastSeq; seq += 1) {
      const event = session.eventAt(SessionSeq(seq));
      if (event?.type === 'tool/call' && MEMORY_TOOL_NAMES.has(event.data?.name)) {
        selfCallIds.add(event.data.callId);
      }
    }
  }

  const candidates = [];
  let scanned = 0;
  for (let seq = scanFrom; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    scanned += 1;
    if (scanned % SEARCH_YIELD_EVERY === 0) yield;
    if (!includeSelf) {
      if (event.type === 'tool/call' && MEMORY_TOOL_NAMES.has(event.data?.name)) continue;
      if (event.type === 'tool/result' && selfCallIds.has(resultCallId(event))) continue;
    }
    const text = readEventText(session, event);
    if (text.length === 0) continue;
    const lower = text.toLowerCase();
    const phraseIndex = terms.length > 1 ? lower.indexOf(needle) : lower.indexOf(terms[0]);
    let termHits = 0;
    let totalOccurrences = 0;
    let anchorIndex = -1;
    for (const term of terms) {
      const index = lower.indexOf(term);
      if (index >= 0) {
        termHits += 1;
        if (anchorIndex < 0 || index < anchorIndex) anchorIndex = index;
        totalOccurrences += countOccurrences(lower, term);
      }
    }
    const phraseHit = terms.length > 1 ? phraseIndex >= 0 : anchorIndex >= 0;
    if (phraseHit && terms.length > 1) anchorIndex = phraseIndex;
    const tier = phraseHit ? 0 : termHits === terms.length ? 1 : termHits > 0 ? 2 : 3;
    if (tier === 3) continue;
    // Candidates carry only the ranking fields — full text is re-read for the
    // few winners when snippets are built, so a broad query cannot pin every
    // matching event's megabytes in memory at once.
    candidates.push({ seq, type: event.type, tier, totalOccurrences, textLength: text.length, anchorIndex });
  }

  const bestTier = candidates.reduce((best, candidate) => Math.min(best, candidate.tier), 3);
  const pool = candidates.filter((candidate) => candidate.tier === bestTier);
  pool.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.totalOccurrences !== b.totalOccurrences) return b.totalOccurrences - a.totalOccurrences;
    if (a.textLength !== b.textLength) return a.textLength - b.textLength;
    return b.seq - a.seq;
  });

  const matches = pool.slice(0, cap).map((candidate) => {
    const event = session.eventAt(SessionSeq(candidate.seq));
    const text = event === undefined ? '' : readEventText(session, event);
    const anchor = Math.min(Math.max(candidate.anchorIndex, 0), Math.max(text.length, 0));
    const from = Math.max(0, anchor - SNIPPET_RADIUS_CHARS);
    const to = Math.min(text.length, anchor + SNIPPET_RADIUS_CHARS);
    return {
      seq: candidate.seq,
      type: candidate.type,
      snippet: `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`,
      offset: anchor,
      tier: candidate.tier,
    };
  });
  return { matches, scanned, tier: bestTier === 3 ? null : bestTier };
}

/**
 * Read a seq range back as model-visible message text, bounded in span (200
 * events) and in output size (maxChars). `offset` is a char cursor into the
 * text of `fromSeq`, used to continue a read that was cut inside an oversized
 * event. When the cap is hit, the text itself states the remaining char count
 * and the exact next call, so nothing needs to be reconstructed by guesswork.
 */
export function historyRead(session, { fromSeq, toSeq, offset = 0 }, maxChars) {
  if (session.seq === 0) return { fromSeq: 0, toSeq: -1, truncated: false, text: '' };
  const lastSeq = session.seq - 1;
  const from = clampSeq(fromSeq, lastSeq);
  const to = Math.min(lastSeq, Math.max(from, clampSeq(toSeq, lastSeq)), from + HISTORY_READ_MAX_EVENTS - 1);
  const cursor = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const parts = [];
  let total = 0;
  let truncated = false;
  let cutSeq = from;
  let nextOffset = 0;
  let remaining = 0;
  for (let seq = from; seq <= to; seq += 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    const full = readEventText(session, event);
    const body = seq === from ? full.slice(cursor) : full;
    const head = `[seq ${seq} ${event.type}]`;
    const separator = parts.length === 0 ? '' : '\n\n';
    const lead = `${separator}${body.length > 0 ? `${head}\n` : head}`;
    // The first page always makes progress, even under a pathologically small cap.
    const room = parts.length === 0 ? Math.max(maxChars - total - lead.length, 1) : maxChars - total - lead.length;
    if (body.length > room) {
      const chunk = room > 0 ? body.slice(0, room) : '';
      if (chunk.length > 0) {
        parts.push(`${lead}${chunk}`);
        total += lead.length + chunk.length;
      }
      truncated = true;
      cutSeq = seq;
      nextOffset = (seq === from ? cursor : 0) + chunk.length;
      remaining = body.length - chunk.length + unreadChars(session, seq + 1, to);
      break;
    }
    parts.push(`${lead}${body}`);
    total += lead.length + body.length;
  }
  const text = parts.join('');
  if (!truncated) return { fromSeq: from, toSeq: to, truncated, text };
  return {
    fromSeq: from,
    toSeq: to,
    truncated,
    text:
      `${text}\n[truncated — about ${remaining} more chars in seq ${cutSeq}..${to}; continue with ` +
      `${HISTORY_READ_TOOL}({ fromSeq: ${cutSeq}, toSeq: ${to}, offset: ${nextOffset} })]`,
  };
}

/** Register history_search / history_read into one agent's scope. */
export function registerHistoryTools(agent, { historyMaxChars }) {
  agent.ctx.tools.register(
    defineTool({
      name: HISTORY_SEARCH_TOOL,
      description:
        "Search this session's FULL history — including turns removed from your active context by a reset or compaction. Multi-term queries match events containing ALL terms (a whole phrase outranks term-AND; partial-term events only show when nothing matches all terms); a single short distinctive phrase is most precise. Results are ranked by hit count, density, and recency, and your own memory-tool calls are excluded. Each match gives seq + snippet + an offset you can pass to history_read to continue from the exact hit. If matches only cover the current turn, pass beforeSeq to search below it, or read a seq range directly.",
      parameters: {
        query: {
          type: 'string',
          required: true,
          description:
            'Case-insensitive search text. One distinctive phrase, or several terms that must all appear in the event (e.g. a path plus a symbol).',
        },
        limit: {
          type: 'number',
          description: `Max matches to return (default 10, capped at ${HISTORY_SEARCH_MAX_MATCHES}).`,
        },
        beforeSeq: {
          type: 'number',
          description:
            'Optional exclusive upper seq bound — search only events older than this seq (e.g. the start of the current turn).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            matches: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  seq: { type: 'number', required: true },
                  type: { type: 'string', required: true },
                  snippet: { type: 'string', required: true },
                  offset: { type: 'number', required: true },
                  tier: { type: 'number', required: true },
                },
              },
            },
            scanned: { type: 'number', required: true },
            tier: { type: ['number', 'null'], required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.matches.length === 0
                ? `no matches (searched ${value.scanned} events)`
                : `${value.matches
                    .map((m) => `seq ${m.seq} [${m.type}] (offset ${m.offset}): ${m.snippet}`)
                    .join(
                      '\n',
                    )}\n— use history_read({ fromSeq, toSeq }) around a promising seq, or history_read({ fromSeq: <seq>, toSeq: <seq>, offset: <offset> }) to continue from the exact hit`,
          },
        ],
      },
      isConcurrencySafe: () => true,
      execute: async (args) => await historySearchAsync(agent.session, args),
    }),
  );

  agent.ctx.tools.register(
    defineTool({
      name: HISTORY_READ_TOOL,
      description:
        "Read an exact range of this session's history events back as message text, including turns removed from your active context by a reset or compaction. Find seq anchors with history_search first — or, when a note/pin already carries a seq: N provenance pointer, read that event directly with fromSeq = toSeq = N (no search needed). Long output is truncated with the exact remaining size and the next call spelled out; pass the optional offset to continue inside a single oversized event.",
      parameters: {
        fromSeq: { type: 'number', required: true, description: 'First event seq to read (inclusive).' },
        toSeq: {
          type: 'number',
          required: true,
          description: `Last event seq to read (inclusive); at most ${HISTORY_READ_MAX_EVENTS} events per call.`,
        },
        offset: {
          type: 'number',
          description:
            'Optional char cursor into the text of fromSeq, for continuing an oversized event whose read was truncated (the truncation marker names the exact value to pass).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fromSeq: { type: 'number', required: true },
            toSeq: { type: 'number', required: true },
            truncated: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.text.length === 0 ? `no message content in seq ${value.fromSeq}..${value.toSeq}` : value.text,
          },
        ],
      },
      isConcurrencySafe: () => true,
      execute: (args) => historyRead(agent.session, args, historyMaxChars),
    }),
  );
}

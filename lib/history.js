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

/** Model-visible text of one event: the message projection is preferred. */
function readEventText(session, event) {
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

/**
 * Search the full session log — shadowed (compacted-away) events included —
 * from newest to oldest, returning snippets around the hit with seq anchors.
 */
export function historySearch(session, { query, limit = 10 }) {
  const needle = String(query ?? '').toLowerCase();
  const cap = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 10, HISTORY_SEARCH_MAX_MATCHES));
  const matches = [];
  if (needle.length === 0) return { matches, scanned: session.seq };
  for (let seq = session.seq - 1; seq >= 0 && matches.length < cap; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    const text = readEventText(session, event);
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    const from = Math.max(0, index - SNIPPET_RADIUS_CHARS);
    const to = Math.min(text.length, index + needle.length + SNIPPET_RADIUS_CHARS);
    matches.push({
      seq,
      type: event.type,
      snippet: `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`,
    });
  }
  matches.reverse();
  return { matches, scanned: session.seq };
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
        "Search this session's FULL history — including turns removed from your active context by a reset or compaction — from newest to oldest. Returns seq anchors with snippets; follow up with history_read around a promising seq.",
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Case-insensitive keyword to find, e.g. a file path, error string, or distinctive phrase.',
        },
        limit: {
          type: 'number',
          description: `Max matches to return (default 10, capped at ${HISTORY_SEARCH_MAX_MATCHES}).`,
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
                },
              },
            },
            scanned: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.matches.length === 0
                ? `no matches (searched ${value.scanned} events)`
                : `${value.matches
                    .map((m) => `seq ${m.seq} [${m.type}]: ${m.snippet}`)
                    .join('\n')}\n— use history_read({ fromSeq, toSeq }) around a promising seq for full content`,
          },
        ],
      },
      isConcurrencySafe: () => true,
      execute: (args) => historySearch(agent.session, args),
    }),
  );

  agent.ctx.tools.register(
    defineTool({
      name: HISTORY_READ_TOOL,
      description:
        "Read an exact range of this session's history events back as message text, including turns removed from your active context by a reset or compaction. Find seq anchors with history_search first. Long output is truncated with the exact remaining size and the next call spelled out; pass the optional offset to continue inside a single oversized event.",
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

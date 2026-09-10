import { SessionSeq } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * dsh-context-manager — full-log retrieval ("the swap").
 *
 * Nothing is ever deleted: compaction and /reset only shadow events from the
 * session surface; the log keeps every event. These tools let the model page
 * any of it back in on demand — keyword search first for seq anchors, then an
 * exact range read.
 * @module dsh-context-manager/history
 */

export const HISTORY_SEARCH_TOOL = 'history_search';
export const HISTORY_READ_TOOL = 'history_read';

/** Per-search result ceiling so a broad query cannot flood the context. */
const HISTORY_SEARCH_MAX_MATCHES = 50;
/** Per-event text considered during search, and snippet radius in output. */
const EVENT_TEXT_SCAN_CHARS = 4000;
const SNIPPET_RADIUS_CHARS = 120;
/** Max events one history_read call may span. */
const HISTORY_READ_MAX_EVENTS = 200;

/**
 * Extract searchable plain text from one session event, best-effort and
 * bounded. Unknown shapes fall back to truncated JSON so nothing is
 * unsearchable.
 */
export function eventText(event) {
  const data = event.data;
  if (!data || typeof data !== 'object') return '';
  const message = data.message;
  if (message && Array.isArray(message.content)) {
    const parts = [];
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'tool-call') parts.push(`${block.name} ${JSON.stringify(block.arguments ?? {})}`);
    }
    return parts.join('\n').slice(0, EVENT_TEXT_SCAN_CHARS);
  }
  try {
    return JSON.stringify(data).slice(0, EVENT_TEXT_SCAN_CHARS);
  } catch {
    return '';
  }
}

/**
 * Search the full session log — shadowed (compacted-away) events included —
 * from newest to oldest, returning bounded snippets with their seq anchors.
 */
export function historySearch(session, { query, limit = 10 }) {
  const needle = query.toLowerCase();
  const cap = Math.max(1, Math.min(limit, HISTORY_SEARCH_MAX_MATCHES));
  const matches = [];
  for (let seq = session.seq - 1; seq >= 0 && matches.length < cap; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    const text = eventText(event);
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
 * Read an exact seq range back as message text, bounded in both span and
 * total size. deriveEventMessage reconstructs the model-visible message for
 * message-producing events; other events contribute a one-line marker.
 */
export function historyRead(session, { fromSeq, toSeq }, maxChars) {
  const from = Math.max(0, fromSeq);
  const to = Math.min(session.seq - 1, Math.min(toSeq, fromSeq + HISTORY_READ_MAX_EVENTS - 1));
  const parts = [];
  let total = 0;
  let truncated = false;
  for (let seq = from; seq <= to; seq += 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    const message = session.deriveEventMessage(event);
    const text = message === null ? '' : eventText(event);
    const line = text.length > 0 ? `[seq ${seq} ${event.type}]\n${text}` : `[seq ${seq} ${event.type}]`;
    if (total + line.length > maxChars) {
      truncated = true;
      break;
    }
    parts.push(line);
    total += line.length;
  }
  return { fromSeq: from, toSeq: to, truncated, text: parts.join('\n\n') };
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
        "Read an exact range of this session's history events back as message text, including turns removed from your active context by a reset or compaction. Find seq anchors with history_search first.",
      parameters: {
        fromSeq: { type: 'number', required: true, description: 'First event seq to read (inclusive).' },
        toSeq: {
          type: 'number',
          required: true,
          description: `Last event seq to read (inclusive); at most ${HISTORY_READ_MAX_EVENTS} events per call.`,
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
            text:
              value.text.length === 0
                ? `no message content in seq ${value.fromSeq}..${value.toSeq}`
                : `${value.text}${value.truncated ? '\n[output truncated — narrow the range]' : ''}`,
          },
        ],
      },
      isConcurrencySafe: () => true,
      execute: (args) => historyRead(agent.session, args, historyMaxChars),
    }),
  );
}

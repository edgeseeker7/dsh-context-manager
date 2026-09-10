import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * dsh-context-reset — the engine behind the `/reset` command.
 *
 * Subclasses the official BasicCompactionEngine solely to reuse its durable
 * compaction transaction (tool-pairing balance, checkpoint framing, log
 * markers). Automatic triggering is disabled: the engine ONLY runs when the
 * user types /reset. `summarize()` — the official override hook — makes no
 * LLM call; the replacement checkpoint is a fixed reset notice carrying the
 * agent's own durable notes. The full conversation stays in the session log
 * and the model retrieves specifics on demand through history_search /
 * history_read, with notes_append / notes_read as its long-term memory.
 */

/** Prompt section ordering: sit next to other tool-guidance sections. */
const RULES_SECTION_ORDER = 2915;
const BUDGET_SECTION_ORDER = 2916;

const HISTORY_SEARCH_TOOL = 'history_search';
const HISTORY_READ_TOOL = 'history_read';
const NOTES_APPEND_TOOL = 'notes_append';
const NOTES_READ_TOOL = 'notes_read';

/** Per-search result ceiling so a broad query cannot flood the context. */
const HISTORY_SEARCH_MAX_MATCHES = 50;
/** Per-event text considered during search, and snippet radius in output. */
const EVENT_TEXT_SCAN_CHARS = 4000;
const SNIPPET_RADIUS_CHARS = 120;
/** Max events one history_read call may span. */
const HISTORY_READ_MAX_EVENTS = 200;

const RULES_TEXT = [
  'Context memory protocol (dsh-context-reset):',
  "- Your context window is bounded. The user may at any time run /reset: earlier turns then leave your active context WITHOUT a summary. The harness may also compact automatically with an LLM summary. Either way nothing is deleted — the full history stays in this session's log.",
  '- You own your memory. Record durable facts with notes_append as you work: key decisions and WHY, user constraints ("never touch X"), important paths/IDs, dead ends already ruled out. Notes persist across resets and compactions, and are re-injected into your context automatically after a /reset.',
  '- When a detail feels missing — after a reset, a compaction, or anytime — do NOT guess or blindly retry: use history_search (keyword) and history_read (exact event range) to recover the original wording.',
].join('\n');

/**
 * Quantize a pressure ratio into a cache-stable band. The returned hint text
 * only changes when a 25% boundary is crossed, so the assembled system prompt
 * stays byte-identical between crossings and the provider KV cache survives.
 * @param {number} ratio - totalTokens / contextWindow.
 * @returns {string} budget hint, or '' below the first visible band.
 */
function budgetHintText(ratio) {
  if (ratio >= 0.75)
    return 'Context budget: ~75% used. Record fresh notes with notes_append NOW so they survive compaction; the user may also run /reset to start a clean window with your notes re-injected.';
  if (ratio >= 0.5)
    return 'Context budget: ~50% used. Make sure notes_append holds every decision, constraint and path worth surviving a reset or compaction.';
  if (ratio >= 0.25) return 'Context budget: ~25% used.';
  return '';
}

/** Make a session id safe as a single filename. */
function notesFilename(sessionId) {
  return `${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
}

/**
 * Extract searchable plain text from one session event, best-effort and
 * bounded. Unknown shapes fall back to truncated JSON so nothing is
 * unsearchable.
 * @param {object} event - one session log event.
 * @returns {string} text to search, possibly ''.
 */
function eventText(event) {
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
 * Hard-reset engine: the official transaction, but `summarize()` performs no
 * LLM call — the replacement checkpoint is a fixed reset notice plus the
 * agent's durable notes. Runs only through compactNow() (the /reset
 * command); automatic pressure/overflow compaction stays with the official
 * summarizing engine.
 */
export class ContextResetEngine extends BasicCompactionEngine {
  /** @type {WeakMap<object, {window?: number, pending?: boolean}>} per-session context-window cache. */
  windowCache = new WeakMap();

  constructor(ctx, config = {}) {
    const { budgetHints = true, notesMaxChars = 8000, historyMaxChars = 8000 } = config;
    // auto MUST stay false: automatic compaction is the official engine's
    // job. This engine exists for explicit, user-invoked resets only.
    super(ctx, { auto: false });
    this.budgetHints = budgetHints;
    this.notesMaxChars = notesMaxChars;
    this.historyMaxChars = historyMaxChars;
  }

  /**
   * The no-LLM "summary": a fixed reset notice carrying the agent's current
   * notes, so the most important state re-enters the context with zero tool
   * calls. The official transaction wraps this in the checkpoint framing and
   * verifies it is smaller than the shadowed span.
   */
  async summarize(input, agent) {
    const session = agent.session;
    let prior = 0;
    for (let seq = 0; seq < session.seq; seq += 1) {
      if (session.eventAt(SessionSeq(seq))?.type === 'compaction/start') prior += 1;
    }
    const notes = this.readNotes(session.id);
    const text = [
      `CONTEXT WINDOW RESET #${prior + 1} (/reset, dsh-context-reset) — no summary was produced and no information was deleted.`,
      `The earlier conversation (${Math.max(input.messages.length - 1, 0)} replayed messages) left the active context but remains FULLY recorded in this session's log. When a fact, path, decision or constraint feels missing, retrieve it instead of guessing:`,
      `- ${HISTORY_SEARCH_TOOL}({ query }) — find prior messages and tool activity by keyword`,
      `- ${HISTORY_READ_TOOL}({ fromSeq, toSeq }) — read an exact event range`,
      '',
      'Durable notes (persisted across resets, newest last):',
      notes || `(none yet — record key decisions, constraints and paths with ${NOTES_APPEND_TOOL} as you work)`,
    ].join('\n');
    return {
      summary: [{ type: 'text', text }],
      llmStreamCall: false,
      provider: 'context-reset',
      model: 'context-reset',
    };
  }

  /**
   * Resolve the routed model's context window, mirroring the official target
   * resolution (latest routed request, then agent options).
   * @returns {Promise<number | undefined>} context window in tokens.
   */
  async resolveContextWindow(agent, signal) {
    const routed = agent.session.requestHeader()?.config;
    const target =
      routed !== undefined && routed.provider.length > 0 && routed.model.length > 0
        ? routed
        : agent.options.provider !== undefined &&
            agent.options.provider.length > 0 &&
            agent.options.model !== undefined &&
            agent.options.model.length > 0
          ? { provider: agent.options.provider, model: agent.options.model }
          : undefined;
    if (target === undefined) return undefined;
    try {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
      return info.context?.contextWindow;
    } catch {
      return undefined;
    }
  }

  // ── notes storage ────────────────────────────────────────────────────────

  notesPath(sessionId) {
    return dshHomePath('context-reset', 'notes', notesFilename(sessionId));
  }

  /**
   * Read the session's notes, keeping the newest content when over budget:
   * recent notes supersede older ones more often than not.
   */
  readNotes(sessionId) {
    const path = this.notesPath(sessionId);
    if (!existsSync(path)) return '';
    const content = readFileSync(path, 'utf8').trim();
    if (content.length <= this.notesMaxChars) return content;
    return `[older notes truncated]\n${content.slice(-this.notesMaxChars)}`;
  }

  appendNotes(sessionId, text) {
    const path = this.notesPath(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `\n\n<!-- ${new Date().toISOString()} -->\n${text.trim()}\n`);
    return this.readNotes(sessionId).length;
  }

  // ── history retrieval ────────────────────────────────────────────────────

  /**
   * Search the full session log — shadowed (compacted-away) events included —
   * from newest to oldest, returning bounded snippets with their seq anchors.
   */
  historySearch(agent, { query, limit = 10 }) {
    const session = agent.session;
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
  historyRead(agent, { fromSeq, toSeq }) {
    const session = agent.session;
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
      if (total + line.length > this.historyMaxChars) {
        truncated = true;
        break;
      }
      parts.push(line);
      total += line.length;
    }
    return { fromSeq: from, toSeq: to, truncated, text: parts.join('\n\n') };
  }

  // ── budget hint ──────────────────────────────────────────────────────────

  /**
   * Quantized budget hint for the per-agent system-prompt section. Async
   * window resolution is kicked off lazily and cached; until it lands the
   * section renders empty so the prompt stays stable.
   */
  budgetHint(agent) {
    try {
      let cache = this.windowCache.get(agent.session);
      if (cache === undefined) {
        cache = {};
        this.windowCache.set(agent.session, cache);
      }
      if (cache.window === undefined) {
        if (!cache.pending) {
          cache.pending = true;
          this.resolveContextWindow(agent)
            .then((window) => {
              cache.window = window;
              cache.pending = false;
            })
            .catch(() => {
              cache.pending = false;
            });
        }
        return '';
      }
      const ratio = this.ctx.tokenMeter.measure(agent.session).totalTokens / cache.window;
      return budgetHintText(ratio);
    } catch {
      return '';
    }
  }

  // ── per-agent installation ───────────────────────────────────────────────

  /**
   * Install the protocol section, the budget hint section, and the four
   * retrieval/memory tools into one agent's scope. Everything lives on
   * `agent.ctx`, so it unwinds automatically when the agent is disposed.
   */
  installAgent(agent) {
    agent.ctx.systemPrompt.section({
      name: 'context-reset:rules',
      order: RULES_SECTION_ORDER,
      text: RULES_TEXT,
    });

    if (this.budgetHints) {
      agent.ctx.systemPrompt.section({
        name: 'context-reset:budget',
        order: BUDGET_SECTION_ORDER,
        text: () => this.budgetHint(agent),
      });
    }

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
        execute: (args) => this.historySearch(agent, args),
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
        execute: (args) => this.historyRead(agent, args),
      }),
    );

    agent.ctx.tools.register(
      defineTool({
        name: NOTES_APPEND_TOOL,
        description:
          'Append a durable note that survives context resets and compactions; after a /reset your notes are re-injected into your context automatically. Record key decisions and WHY, user constraints, important paths/IDs, and dead ends already ruled out. If a previous note became obsolete, append a correction naming it — notes are append-only.',
        parameters: {
          text: {
            type: 'string',
            required: true,
            description: 'The durable fact to remember, terse and self-contained.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              accepted: { type: 'boolean', required: true },
              totalChars: { type: 'number', required: true },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.accepted ? `note recorded (${value.totalChars} chars retained)` : 'note was not recorded',
            },
          ],
        },
        execute: (args) => {
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          if (text.length === 0) return { accepted: false, totalChars: 0 };
          return { accepted: true, totalChars: this.appendNotes(agent.session.id, text) };
        },
      }),
    );

    agent.ctx.tools.register(
      defineTool({
        name: NOTES_READ_TOOL,
        description: 'Read your durable notes that persist across context resets and compactions.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              notes: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.notes.length > 0 ? value.notes : '(no notes yet)' }],
        },
        isConcurrencySafe: () => true,
        execute: () => ({ notes: this.readNotes(agent.session.id) }),
      }),
    );
  }
}

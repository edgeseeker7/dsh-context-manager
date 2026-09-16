import { existsSync, statSync } from 'node:fs';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { readEventText, registerHistoryTools } from './history.js';
import { installMalloc } from './malloc.js';
import { registerNotesTools } from './notes.js';

/**
 * dsh-context-manager — the engine behind `/reset`, plus the per-agent
 * installation of the whole four-layer memory model:
 *
 *   ① vault   — verbatim pins in the last system-prompt section (malloc.js)
 *   ② diary   — durable notes in a session file (notes.js)
 *   ③ swap    — full-log retrieval tools (history.js)
 *   ④ sketch  — the LLM checkpoint this engine composes on /reset
 *
 * The engine subclasses the official BasicCompactionEngine solely to reuse
 * its durable compaction transaction (tool-pairing balance, checkpoint
 * framing, log markers). Automatic triggering is disabled: it ONLY runs when
 * the user types /reset — the official summarizing engine keeps the default
 * automatic path. `summarize()` — the official override hook — composes the
 * hybrid checkpoint: reset notice + retrieval instructions + optional LLM
 * sketch (labeled UNVERIFIED) + the agent's durable notes. Pins need no
 * checkpoint seat: the system prompt is re-assembled on every request, so pins
 * reach the model without one (/reset clears only the t* task pins).
 * @module dsh-context-manager/engine
 */

/** Prompt-section ordering: sit next to other tool-guidance sections. */
const RULES_SECTION_ORDER = 2915;
const BUDGET_SECTION_ORDER = 2916;

const RULES_TEXT = [
  'Context memory protocol (dsh-context-manager) — you own your memory, across four layers:',
  '- VAULT: pin VERBATIM-critical facts (exact versions, constraints, credentials, paths, IDs, user mandates) with context_alloc. Pins render into your system prompt and survive every compaction, never paraphrased; scope "permanent" (w*) pins also survive /reset, while scope "task" (t*) pins are cleared by /reset. Free stale pins with context_free (an outdated pin is authoritative WRONG information); watch usage with context_list. Quota is derived from the context window of the model you are routed to — pin the critical core only. Pinning is not the default: most session content is ephemeral, and pinning nothing when nothing meets the bar is the correct outcome.',
  "- DIARY: record distilled facts with notes_append as you work — decisions and WHY, dead ends, progress. Notes persist across resets and are re-injected into your context after a /reset. Notes are structured: supersedes replaces an outdated note (it folds away but stays auditable), tags file notes into buckets you invent (list them with notes_read({ listTags: true }) and reuse existing buckets before inventing new ones), sourceSeq points at the log event a note came from (read it back directly with history_read({ fromSeq, toSeq: fromSeq })). Notes are per-session — other conversations' diaries in this workspace are discoverable with notes_read({ listSessions: true }) and readable with notes_read({ session }).",
  "- The user may at any time run /reset: earlier turns leave your active context (task pins are bulk-freed with them); the harness may also compact automatically with an LLM summary. Nothing is ever deleted — the full history stays in this session's log.",
  '- SWAP: when a detail feels missing — after a reset, a compaction, or anytime — do NOT guess or blindly retry: use history_search (keyword) and history_read (exact event range, with a char cursor for oversized events) to recover the original wording.',
  '- This protocol governs your own working memory; it does not change task-specific judgment criteria. When the task asks you to gate, classify, or review against its own standard, apply that standard — the presence of memory tools is not a reason to lean toward keeping.',
].join('\n');

/**
 * Quantize a pressure ratio into a cache-stable band. The returned hint text
 * only changes when a 25% boundary is crossed, so the assembled system prompt
 * stays byte-identical between crossings.
 */
function budgetHintText(ratio) {
  if (ratio >= 0.75)
    return 'Context budget: ~75% used. Pin what must survive (context_alloc) and record fresh notes with notes_append NOW; the user may also run /reset to start a clean window (task pins are freed, notes and workspace pins carry over).';
  if (ratio >= 0.5)
    return 'Context budget: ~50% used. Make sure the vault (context_alloc) and notes_append hold everything worth surviving a reset or compaction.';
  if (ratio >= 0.25) return 'Context budget: ~25% used.';
  return '';
}

/** How many trailing events the anchor extractor scans, and the per-event text cap. */
const ANCHOR_SCAN_EVENTS = 200;
const ANCHOR_TEXT_CAP = 20000;
/** How many recent user instructions the checkpoint keeps verbatim. */
const RECENT_INSTRUCTIONS = 5;

/**
 * Streaming anchor counter: feed it one text at a time (per event), so no
 * cumulative corpus is ever held — each event's text is released when its
 * add() returns. This is the mechanical complement to the LLM sketch: exact
 * strings the sketch would paraphrase away survive verbatim here.
 */
export function createAnchorExtractor() {
  const ids = new Map();
  const paths = new Map();
  const urls = new Map();
  const count = (map, key) => {
    if (key.length > 0) map.set(key, (map.get(key) ?? 0) + 1);
  };
  return {
    add(text) {
      for (const match of text.matchAll(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi)) {
        count(ids, match[0].toLowerCase());
      }
      for (const match of text.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) {
        count(urls, match[0].replace(/[.,;:!?)，。]+$/, ''));
      }
      for (const match of text.matchAll(/(?<![\w./~-])\/[\w.@+\-/]{9,}/g)) {
        count(paths, match[0].replace(/[.,;:]+$/, ''));
      }
    },
    result() {
      const top = (map, limit) =>
        [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit);
      return { ids: top(ids, 8), paths: top(paths, 8), urls: top(urls, 5) };
    },
  };
}

/** One-shot convenience over createAnchorExtractor (tests, small corpora). */
export function extractAnchors(text) {
  const extractor = createAnchorExtractor();
  extractor.add(text);
  return extractor.result();
}

/** Markers that make a sentence a CONSTRAINT (negations, mandates, scope limits). */
const CONSTRAINT_MARKERS = [
  '不要',
  '禁止',
  '必须',
  '只能',
  '改为',
  '别',
  '不准',
  '务必',
  '只能',
  '严禁',
  '不得',
  "don't",
  'do not',
  'must',
  'never',
  'only',
  'always',
];
const MAX_CONSTRAINTS = 10;
const MAX_CONSTRAINT_CHARS = 160;

/**
 * Pull constraint-shaped sentences (negations, mandates, scope limits) out of
 * a text, VERBATIM, newest-preserving order. Trace analysis: after a reset
 * the model inverted negated constraints and expanded "only X" scopes it had
 * actually read back — the answer layer needs the original sentence in front
 * of it, not a paraphrase.
 */
export function extractConstraints(text) {
  const lower = text.toLowerCase();
  if (!CONSTRAINT_MARKERS.some((marker) => lower.includes(marker))) return [];
  const sentences = text.split(/(?<=[。!?!?\n])|(?<=\.\s)/);
  const found = [];
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length < 4) continue;
    const sentenceLower = trimmed.toLowerCase();
    if (!CONSTRAINT_MARKERS.some((marker) => sentenceLower.includes(marker))) continue;
    found.push(trimmed.length > MAX_CONSTRAINT_CHARS ? `${trimmed.slice(0, MAX_CONSTRAINT_CHARS)}…` : trimmed);
    if (found.length >= MAX_CONSTRAINTS) break;
  }
  return found;
}

export class ContextResetEngine extends BasicCompactionEngine {
  /** @type {WeakMap<object, {key?: string, window?: number, pending?: boolean}>} per-session, per-route cache. */
  windowCache = new WeakMap();

  constructor(ctx, config = {}) {
    const {
      budgetHints = true,
      llmSummary = true,
      historyMaxChars = 8000,
      checkpointMaxChars = 8000,
      notesStore,
      pinStore,
      nudgeEvery = 20,
      ...summaryConfig
    } = config;
    // auto MUST stay false: automatic compaction is the official engine's
    // job. This engine exists for explicit, user-invoked resets only.
    super(ctx, { auto: false, ...summaryConfig });
    this.budgetHints = budgetHints;
    this.llmSummary = llmSummary;
    this.historyMaxChars = historyMaxChars;
    this.checkpointMaxChars = checkpointMaxChars;
    this.notesStore = notesStore;
    this.pinStore = pinStore;
    this.nudgeEvery = nudgeEvery;
    /** Per-session diary-hint cache { dirMtime, text } — the hint scans the notes dir. */
    this.diaryHintCache = new WeakMap();
  }

  /**
   * The hybrid checkpoint: a fixed reset notice, an OPTIONAL LLM sketch of
   * the shadowed span (explicitly labeled unverified), and the agent's
   * durable notes. The sketch bridges continuity when notes are sparse —
   * the user invoked /reset explicitly, so one cache-friendly LLM call is
   * affordable — while pins, notes and the retrieval tools stay
   * authoritative. A failed sketch call degrades to the pure hard cut,
   * never to a failed reset.
   */
  async summarize(input, agent, signal) {
    const session = agent.session;
    let prior = 0;
    for (let seq = 0; seq < session.seq; seq += 1) {
      if (session.eventAt(SessionSeq(seq))?.type === 'compaction/start') prior += 1;
    }
    let sketch = null;
    if (this.llmSummary) {
      try {
        sketch = await super.summarize(input, agent, signal);
      } catch (error) {
        this.ctx.logger.warn(
          `context-manager: LLM sketch failed, falling back to pure cut: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const sketchText =
      sketch === null
        ? null
        : sketch.summary
            .map((block) => block.text)
            .join('\n')
            .trim();
    // The checkpoint itself has a hard budget (checkpointMaxChars): a plugin
    // whose purpose is saving context must not let its own reset artifact
    // grow unbounded. Authority order decides what shrinks: the fixed
    // protocol + mechanical state (authoritative, small) > durable notes
    // (authoritative, self-truncating) > the LLM sketch (UNVERIFIED — first
    // to be trimmed, then dropped, always with a stated marker).
    const fixed = [
      `CONTEXT WINDOW RESET #${prior + 1} (/reset, dsh-context-manager) — the earlier conversation left the active context; nothing was deleted.`,
      `The earlier conversation (${Math.max(input.messages.length - 1, 0)} replayed messages) remains FULLY recorded in this session's log. This reset also clears this session's t* task pins (the /reset command reports the cleanup it actually completed); w* workspace pins and durable notes carry over. When a fact, path, decision or constraint matters, retrieve it instead of guessing or trusting the sketch below:`,
      'Retrieval protocol (trace-proven rules — follow them before answering anything about prior work):',
      '- NEVER answer a question about prior work without searching the log first. The sketch is a map, never an answer source; an answer built on the sketch alone is a hallucination risk.',
      '- history_search({ query }) — take the query entities (identifiers, numbers, error strings, exact names) VERBATIM from the question, not from the sketch; several terms that must all appear beat one long paraphrase.',
      '- history_read({ fromSeq, toSeq }) — read the actual hit ranges, low seqs included; oversized events continue with the offset the truncation marker reports.',
      '- Multi-part questions: split into sub-questions and find evidence for EACH part; if one part cannot be found, say so for that part only — never refuse or bluff the whole question.',
      "- Constraints: also search negations and amendments (不要/禁止/必须/只能/改为/don't/must/never/only); the LATEST user instruction wins over earlier ones; quote the constraint sentence verbatim in your answer.",
      '- Checkpoint/summary content (marked in results) is compressed: use it as a pointer to raw events, never as primary evidence.',
      '',
      '## Mechanical state at reset (extracted, authoritative)',
      ...this.mechanicalState(agent),
    ].join('\n');
    const notesHeader = '\n\n## Durable notes (persisted across resets, newest last — authoritative)\n';
    const notesBudget = Math.max(this.checkpointMaxChars - fixed.length - notesHeader.length, 500);
    const notes = this.notesStore.read(session.id, { maxChars: notesBudget });
    let text =
      fixed +
      notesHeader +
      (notes || '(none yet — record key decisions, constraints and paths with notes_append as you work)');
    if (sketchText !== null) {
      const sketchHeader =
        '\n\n## Sketch of prior work (LLM-generated, UNVERIFIED — possibly incomplete or wrong; the mechanical state above, pins, notes and history_search are authoritative)\n';
      const room = this.checkpointMaxChars - text.length - sketchHeader.length;
      if (room >= 400) {
        const trimmed =
          sketchText.length > room
            ? `${sketchText.slice(0, room)}\n[sketch trimmed — ${sketchText.length - room} chars dropped to fit the ${this.checkpointMaxChars}-char checkpoint budget]`
            : sketchText;
        text += sketchHeader + trimmed;
      } else {
        text += '\n\n[LLM sketch dropped to fit the checkpoint budget — retrieve details with history_search]';
      }
    }
    return {
      ...(sketch ?? { llmStreamCall: false, provider: 'context-manager', model: 'context-manager' }),
      summary: [{ type: 'text', text }],
    };
  }

  /**
   * The deterministic half of the checkpoint — no LLM involved, every line
   * extracted from stores and the raw log, so it cannot hallucinate:
   *   1. the t* pins this reset is about to clear (an index of what the agent
   *      deliberately kept, so it knows what to re-derive via history);
   *   2. the w* pins that stay active;
   *   3. the last real user message (continuity anchor);
   *   4. the most frequent ids/paths/urls in the shadowed span (verbatim
   *      anchors the LLM sketch would paraphrase away).
   * Every extractor is independently guarded: a failure degrades one line,
   * never the reset.
   */
  mechanicalState(agent) {
    const session = agent.session;
    const lines = [];
    try {
      const { task, permanent } = this.pinStore.list({ sessionId: session.id, cwd: session.header?.cwd }, undefined);
      lines.push(
        task.length === 0
          ? '- Task pins: none were pinned.'
          : `- Task pins this reset is about to clear (${task.length}): ${task
              .map((pin) => `[${pin.handle}] ${pin.label}`)
              .join(
                '; ',
              )} — the /reset outcome line reports the actual cleanup (this section is written before it runs); their verbatim text leaves the vault, re-derive facts with history_search when needed.`,
      );
      if (permanent.length > 0) {
        lines.push(
          `- Workspace pins (still active in the system prompt): ${permanent
            .map((pin) => `[${pin.handle}] ${pin.label}`)
            .join('; ')}`,
        );
      }
    } catch (error) {
      lines.push(`- Pin table unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The structure mirror: show the agent the shape of its own memory, so
    // the structures it has grown stay visible as objects worth tending.
    try {
      const entries = this.notesStore.entries(session.id);
      if (entries.length > 0) {
        const { superseded } = this.notesStore.chainViews(entries);
        const activeEntries = entries.filter((entry) => !superseded.has(entry.id));
        const buckets = new Map();
        for (const entry of activeEntries) {
          for (const bucket of entry.tags) buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
        }
        const bucketText =
          buckets.size === 0
            ? 'no buckets'
            : [...buckets.entries()]
                .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
                .slice(0, 8)
                .map(([bucket, count]) => `#${bucket}(${count})`)
                .join(' ');
        lines.push(
          `- Memory structures: notes ${activeEntries.length} active / ${superseded.size} superseded; buckets: ${bucketText}. Other sessions' diaries are discoverable with notes_read({ listSessions: true }).`,
        );
      }
    } catch (error) {
      lines.push(`- Memory structure mirror unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const lastSeq = session.seq - 1;
      const from = Math.max(0, lastSeq - ANCHOR_SCAN_EVENTS + 1);
      // Per-event extraction, no accumulated corpus: a sliced string keeps
      // its parent alive, so concatenating 200 slices would pin every event
      // text in the window until the reset finished.
      const extractor = createAnchorExtractor();
      const userMessages = [];
      for (let seq = from; seq <= lastSeq; seq += 1) {
        const event = session.eventAt(SessionSeq(seq));
        if (event === undefined) continue;
        const text = readEventText(session, event);
        extractor.add(text.length > ANCHOR_TEXT_CAP ? text.slice(0, ANCHOR_TEXT_CAP) : text);
        if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
          const normalized = text.replace(/\s+/g, ' ').trim();
          if (normalized.length > 0) userMessages.push({ seq, text: normalized });
        }
      }
      const { ids, paths, urls } = extractor.result();
      const format = (entries) => entries.map(([value, hits]) => (hits > 1 ? `${value} (×${hits})` : value)).join('; ');
      if (ids.length > 0) lines.push(`- Frequent ids in the shadowed span: ${format(ids)}`);
      if (paths.length > 0) lines.push(`- Frequent paths in the shadowed span: ${format(paths)}`);
      if (urls.length > 0) lines.push(`- Frequent urls in the shadowed span: ${format(urls)}`);
      // User constraints VERBATIM (trace analysis: paraphrased constraints
      // get inverted or scope-expanded by the answer layer after a reset).
      const constraints = [];
      for (const message of userMessages) {
        for (const sentence of extractConstraints(message.text)) {
          constraints.push(`[seq ${message.seq}] "${sentence}"`);
          if (constraints.length >= MAX_CONSTRAINTS) break;
        }
        if (constraints.length >= MAX_CONSTRAINTS) break;
      }
      if (constraints.length > 0) {
        lines.push(`- User constraints (verbatim, quote them when they apply):\n  ${constraints.join('\n  ')}`);
      }
      // The most recent user instructions VERBATIM — what the user actually
      // asked for last, so a reset cannot strand the standing directive.
      const recent = userMessages
        .slice(-RECENT_INSTRUCTIONS)
        .map(
          (message) => `[seq ${message.seq}] "${message.text.slice(0, 200)}${message.text.length > 200 ? '…' : ''}"`,
        );
      if (recent.length > 0) {
        lines.push(`- Recent user instructions (verbatim, newest last):\n  ${recent.join('\n  ')}`);
      }
    } catch (error) {
      lines.push(`- Anchor extraction unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return lines;
  }

  /**
   * The routed model this agent currently talks to: the latest routed request
   * config, else the agent's own options. Undefined when neither is complete.
   * @returns {{provider: string, model: string} | undefined}
   */
  resolveTarget(agent) {
    const routed = agent.session.requestHeader()?.config;
    if (
      typeof routed?.provider === 'string' &&
      routed.provider.length > 0 &&
      typeof routed.model === 'string' &&
      routed.model.length > 0
    ) {
      return routed;
    }
    const { provider, model } = agent.options;
    if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
      return { provider, model };
    }
    return undefined;
  }

  /**
   * Resolve the routed model's context window, mirroring the official target
   * resolution (latest routed request, then agent options).
   * @returns {Promise<number | undefined>} context window in tokens.
   */
  async resolveContextWindow(agent, signal) {
    const target = this.resolveTarget(agent);
    if (target === undefined) return undefined;
    try {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
      return info.context?.contextWindow;
    } catch {
      return undefined;
    }
  }

  /** Shared window resolver for the malloc quota gates (uncached, authoritative). */
  resolveWindow = async (agent) => this.resolveContextWindow(agent);

  /**
   * The routed window for prompt-section renderers, resolved lazily and
   * cached per session AND route (provider + model), so a model switch
   * re-resolves instead of comparing against the old window; undefined until
   * it lands, so sections fall back to their config caps without churning.
   */
  cachedWindow(agent) {
    try {
      const target = this.resolveTarget(agent);
      const key = target === undefined ? '' : `${target.provider}\u0000${target.model}`;
      let cache = this.windowCache.get(agent.session);
      if (cache === undefined || cache.key !== key) {
        cache = { key, pending: false, window: undefined };
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
        return undefined;
      }
      return cache.window;
    } catch {
      return undefined;
    }
  }

  /**
   * Quantized budget hint for the per-agent system-prompt section; renders
   * empty until the window lands so the prompt does not churn.
   */
  budgetHint(agent) {
    try {
      const window = this.cachedWindow(agent);
      if (window === undefined) return '';
      const ratio = this.ctx.tokenMeter.measure(agent.session).totalTokens / window;
      return budgetHintText(ratio);
    } catch {
      return '';
    }
  }

  /**
   * The new-session signpost: rendered only while THIS session has no diary
   * file and other sessions in the workspace do. Cached per notes-dir mtime
   * so prompt assembly pays one stat, not a directory scan, per request.
   */
  diaryHint(agent) {
    try {
      const sessionId = agent.session.id;
      if (existsSync(this.notesStore.path(sessionId))) return '';
      const dir = dshHomePath('context-manager', 'notes');
      const dirMtime = statSync(dir).mtimeMs;
      const cached = this.diaryHintCache.get(agent.session);
      if (cached !== undefined && cached.dirMtime === dirMtime) return cached.text;
      const others = this.notesStore
        .sessionsIndex()
        .filter((entry) => entry.sessionId !== sessionId && entry.notes > 0);
      const text =
        others.length === 0
          ? ''
          : `Other sessions in this workspace have diaries: ${others.length} (newest: ${others[0].sessionId}, ${others[0].notes} notes${others[0].lastTs ? `, last ${others[0].lastTs}` : ''}) — when prior-work context matters, list them with notes_read({ listSessions: true }) and read one with notes_read({ session }).`;
      this.diaryHintCache.set(agent.session, { dirMtime, text });
      return text;
    } catch {
      return '';
    }
  }

  /**
   * Install the protocol sections and every memory tool into one agent's
   * scope. Everything lives on `agent.ctx`, so it unwinds automatically when
   * the agent is disposed — and subagents get their own installation (their
   * own task pins; the shared workspace vault through the same cwd).
   */
  installAgent(agent) {
    agent.ctx.systemPrompt.section({
      name: 'context-manager:rules',
      order: RULES_SECTION_ORDER,
      text: RULES_TEXT,
    });

    if (this.budgetHints) {
      agent.ctx.systemPrompt.section({
        name: 'context-manager:budget',
        order: BUDGET_SECTION_ORDER,
        text: () => this.budgetHint(agent),
      });
    }

    // One-line signpost that exists ONLY while this session has no diary of
    // its own and the workspace has older ones — it disappears after the
    // session's first note, so it never becomes rent.
    agent.ctx.systemPrompt.section({
      name: 'context-manager:diary-hint',
      order: BUDGET_SECTION_ORDER + 1,
      text: () => this.diaryHint(agent),
    });

    registerHistoryTools(agent, { historyMaxChars: this.historyMaxChars });
    registerNotesTools(agent, this.notesStore);
    installMalloc(agent, this.pinStore, {
      resolveWindow: this.resolveWindow,
      cachedWindow: (target) => this.cachedWindow(target),
      nudgeEvery: this.nudgeEvery,
      measureTokens: (session) => {
        try {
          return this.ctx.tokenMeter.measure(session).totalTokens;
        } catch {
          return undefined;
        }
      },
      suggestAnchors: (session) => this.suggestAnchors(session),
      logger: this.ctx.logger,
    });
  }

  /**
   * Pin candidates for the smart nudge: the top ids/paths from the most
   * recent events that are NOT already pinned. Returns at most 3; empty on
   * any failure (the nudge falls back to its generic text).
   */
  suggestAnchors(session) {
    try {
      const extractor = createAnchorExtractor();
      const lastSeq = session.seq - 1;
      const from = Math.max(0, lastSeq - 30);
      for (let seq = from; seq <= lastSeq; seq += 1) {
        const event = session.eventAt(SessionSeq(seq));
        if (event === undefined) continue;
        extractor.add(readEventText(session, event).slice(0, 10000));
      }
      const { task, permanent } = this.pinStore.list({ sessionId: session.id, cwd: session.header?.cwd }, undefined);
      const pinned = [...task, ...permanent].map((pin) => pin.text).join('\n');
      const { ids, paths } = extractor.result();
      return [...ids, ...paths]
        .map(([value]) => value)
        .filter((value) => value.length >= 12 && !pinned.includes(value))
        .slice(0, 3);
    } catch {
      return [];
    }
  }
}

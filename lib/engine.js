import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { registerHistoryTools } from './history.js';
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
  '- VAULT: pin VERBATIM-critical facts (exact versions, constraints, credentials, paths, IDs, user mandates) with context_alloc. Pins render into your system prompt and survive every compaction, never paraphrased; scope "permanent" (w*) pins also survive /reset, while scope "task" (t*) pins are cleared by /reset. Free stale pins with context_free (an outdated pin is authoritative WRONG information); watch usage with context_list. Quota is derived from the context window of the model you are routed to — pin the critical core only.',
  '- DIARY: record distilled facts with notes_append as you work — decisions and WHY, dead ends, progress. Notes persist across resets and are re-injected into your context after a /reset.',
  "- The user may at any time run /reset: earlier turns leave your active context (task pins are bulk-freed with them); the harness may also compact automatically with an LLM summary. Nothing is ever deleted — the full history stays in this session's log.",
  '- SWAP: when a detail feels missing — after a reset, a compaction, or anytime — do NOT guess or blindly retry: use history_search (keyword) and history_read (exact event range, with a char cursor for oversized events) to recover the original wording.',
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

export class ContextResetEngine extends BasicCompactionEngine {
  /** @type {WeakMap<object, {key?: string, window?: number, pending?: boolean}>} per-session, per-route cache. */
  windowCache = new WeakMap();

  constructor(ctx, config = {}) {
    const {
      budgetHints = true,
      llmSummary = true,
      historyMaxChars = 8000,
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
    this.notesStore = notesStore;
    this.pinStore = pinStore;
    this.nudgeEvery = nudgeEvery;
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
    const notes = this.notesStore.read(session.id);
    const text = [
      `CONTEXT WINDOW RESET #${prior + 1} (/reset, dsh-context-manager) — the earlier conversation left the active context; nothing was deleted.`,
      `The earlier conversation (${Math.max(input.messages.length - 1, 0)} replayed messages) remains FULLY recorded in this session's log. This reset also clears this session's t* task pins (the /reset command reports the cleanup it actually completed); w* workspace pins and durable notes carry over. When a fact, path, decision or constraint matters, retrieve it instead of guessing or trusting the sketch below:`,
      '- history_search({ query }) — find prior messages and tool activity by keyword',
      '- history_read({ fromSeq, toSeq }) — read an exact event range; oversized events continue with the offset the truncation marker reports',
      ...(sketchText
        ? [
            '',
            '## Sketch of prior work (LLM-generated, UNVERIFIED — possibly incomplete or wrong; pins, notes below and history_search are authoritative)',
            sketchText,
          ]
        : []),
      '',
      '## Durable notes (persisted across resets, newest last — authoritative)',
      notes || '(none yet — record key decisions, constraints and paths with notes_append as you work)',
    ].join('\n');
    return {
      ...(sketch ?? { llmStreamCall: false, provider: 'context-manager', model: 'context-manager' }),
      summary: [{ type: 'text', text }],
    };
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
   * Quantized budget hint for the per-agent system-prompt section. Async
   * window resolution is kicked off lazily and cached per session AND route
   * (provider + model), so a model switch re-resolves instead of comparing
   * against the old window; until it lands the section renders empty so the
   * prompt does not churn.
   */
  budgetHint(agent) {
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
        return '';
      }
      const ratio = this.ctx.tokenMeter.measure(agent.session).totalTokens / cache.window;
      return budgetHintText(ratio);
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

    registerHistoryTools(agent, { historyMaxChars: this.historyMaxChars });
    registerNotesTools(agent, this.notesStore);
    installMalloc(agent, this.pinStore, {
      resolveWindow: this.resolveWindow,
      nudgeEvery: this.nudgeEvery,
      logger: this.ctx.logger,
    });
  }
}

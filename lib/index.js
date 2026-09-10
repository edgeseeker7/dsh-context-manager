import { Context } from '@deepseek-ai/cordis';
import { registerResetCommand } from './command.js';
import { ContextResetEngine } from './engine.js';
import { PinStore } from './malloc.js';
import { NotesStore } from './notes.js';

/**
 * dsh-context-manager — an explicit context-memory subsystem for DeepSeek
 * Harness: a four-layer memory model (verbatim pins, durable notes, LLM
 * sketch, full-log retrieval) with a malloc-style tool API and an on-demand
 * `/reset` command sitting next to the official `/compact`.
 *
 * Design contract:
 * - The official summarizing compaction stays the default: this plugin does
 *   NOT disable or pre-empt it, and the engine's own automatic triggers are
 *   constructed with `auto: false`. A hard reset happens only when the user
 *   asks for one.
 * - The engine is instantiated on an isolated context whose llm/tokenMeter/
 *   sessions are the ROOT instances — so it never registers a second
 *   root-level `compaction` service, while operating on exactly the same
 *   shared services.
 * - Every agent (subagents included) gets the memory protocol sections and
 *   the seven tools: context_alloc/free/list (vault), notes_append/read
 *   (diary), history_search/read (swap).
 */

export const name = 'dsh-context-manager';
export const inject = ['commands', 'llm', 'tokenMeter', 'sessions'];

const CONFIG_KEYS = new Set([
  'budgetHints',
  'notesMaxChars',
  'historyMaxChars',
  'llmSummary',
  'pinMaxChars',
  'pinsMaxChars',
  'pinsWindowRatio',
  'nudgeEvery',
  'suggestCount',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
]);

/** Validate the plugin's own keys; summarization routing keys pass through. */
function resolveConfig(config = {}) {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`ContextManagerConfig: unknown key "${key}"`);
  }
  const resolved = {
    ...config,
    budgetHints: config.budgetHints ?? true,
    notesMaxChars: config.notesMaxChars ?? 8000,
    historyMaxChars: config.historyMaxChars ?? 8000,
    llmSummary: config.llmSummary ?? true,
    pinMaxChars: config.pinMaxChars ?? 4000,
    pinsMaxChars: config.pinsMaxChars ?? 12000,
    pinsWindowRatio: config.pinsWindowRatio ?? 0.05,
    nudgeEvery: config.nudgeEvery ?? 6,
    suggestCount: config.suggestCount ?? 3,
  };
  for (const key of ['budgetHints', 'llmSummary']) {
    if (typeof resolved[key] !== 'boolean') throw new Error(`ContextManagerConfig: ${key} must be a boolean`);
  }
  for (const key of ['notesMaxChars', 'historyMaxChars', 'pinMaxChars']) {
    const value = resolved[key];
    if (!Number.isInteger(value) || value < 1000)
      throw new Error(`ContextManagerConfig: ${key} (${String(value)}) must be an integer >= 1000`);
  }
  if (!Number.isInteger(resolved.pinsMaxChars) || resolved.pinsMaxChars < resolved.pinMaxChars)
    throw new Error('ContextManagerConfig: pinsMaxChars must be an integer >= pinMaxChars');
  if (typeof resolved.pinsWindowRatio !== 'number' || resolved.pinsWindowRatio <= 0 || resolved.pinsWindowRatio > 0.25)
    throw new Error('ContextManagerConfig: pinsWindowRatio must be a number in (0, 0.25]');
  for (const key of ['nudgeEvery', 'suggestCount']) {
    if (!Number.isInteger(resolved[key]) || resolved[key] < 1)
      throw new Error(`ContextManagerConfig: ${key} must be a positive integer`);
  }
  return resolved;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - root plugin context.
 * @param {object} config - profile row config (see resolveConfig).
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  // Isolated service plane: the engine's Service base registers 'compaction'
  // here, never on the root context where the official engine lives.
  const isolated = new Context();
  for (const service of ['llm', 'tokenMeter', 'sessions']) {
    isolated.provide(service);
    isolated.set(service, ctx.get(service));
  }
  const notesStore = new NotesStore(resolved.notesMaxChars);
  const pinStore = new PinStore({
    pinMaxChars: resolved.pinMaxChars,
    pinsMaxChars: resolved.pinsMaxChars,
    windowRatio: resolved.pinsWindowRatio,
    suggestCount: resolved.suggestCount,
  });
  const engine = new ContextResetEngine(isolated, {
    budgetHints: resolved.budgetHints,
    llmSummary: resolved.llmSummary,
    historyMaxChars: resolved.historyMaxChars,
    notesStore,
    pinStore,
    nudgeEvery: resolved.nudgeEvery,
    ...(resolved.summarizationProvider !== undefined
      ? {
          summarizationProvider: resolved.summarizationProvider,
          summarizationModel: resolved.summarizationModel,
        }
      : {}),
    ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
  });

  ctx.on('agent/created', ({ agent }) => {
    try {
      engine.installAgent(agent);
    } catch (error) {
      ctx.logger.warn(
        `context-manager: failed to install agent tools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  registerResetCommand(ctx, engine, pinStore);
}

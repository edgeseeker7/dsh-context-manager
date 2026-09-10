import { Context } from '@deepseek-ai/cordis';
import { registerResetCommand } from './command.js';
import { ContextResetEngine } from './engine.js';

/**
 * dsh-context-reset — an on-demand hard context-window reset, invoked as
 * `/reset` from the input box, sitting next to the official `/compact`.
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
 * - Every agent gets the memory protocol section, a cache-stable budget
 *   hint, and four tools (history_search, history_read, notes_append,
 *   notes_read) so recall survives both /reset and official compaction.
 */

export const name = 'dsh-context-reset';
export const inject = ['commands', 'llm', 'tokenMeter', 'sessions'];

const CONFIG_KEYS = new Set(['budgetHints', 'notesMaxChars', 'historyMaxChars']);

/** Validate the small config surface manually (three optional keys). */
function resolveConfig(config = {}) {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`ContextResetConfig: unknown key "${key}"`);
  }
  const resolved = {
    budgetHints: config.budgetHints ?? true,
    notesMaxChars: config.notesMaxChars ?? 8000,
    historyMaxChars: config.historyMaxChars ?? 8000,
  };
  if (typeof resolved.budgetHints !== 'boolean') throw new Error('ContextResetConfig: budgetHints must be a boolean');
  for (const key of ['notesMaxChars', 'historyMaxChars']) {
    const value = resolved[key];
    if (!Number.isInteger(value) || value < 1000)
      throw new Error(`ContextResetConfig: ${key} (${String(value)}) must be an integer >= 1000`);
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
  const engine = new ContextResetEngine(isolated, resolved);

  ctx.on('agent/created', ({ agent }) => {
    try {
      engine.installAgent(agent);
    } catch (error) {
      ctx.logger.warn(
        `context-reset: failed to install agent tools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  registerResetCommand(ctx, engine);
}

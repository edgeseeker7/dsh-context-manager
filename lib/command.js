import { ManualCompactionError } from '@deepseek-ai/dsh-compaction';

/**
 * The `/reset` human command: an on-demand hard context-window reset, sitting
 * next to the official `/compact` in the input box. Registration mirrors the
 * official command-compact lifecycle (active-operation settling on unload,
 * ManualCompactionError → concise human-readable outcomes).
 *
 * The history replacement and the task-pin bulk-free are two separate durable
 * stores with no shared transaction (the host owns the session log; the vault
 * is this plugin's file). So the cleanup runs AFTER the replacement commits,
 * retries once (see PinStore.clearTask), and reports only what it actually
 * achieved — a failed cleanup is stated, never smoothed over.
 * @module dsh-context-manager/command
 */

const USAGE = 'Usage: /reset (no arguments)';

/** Fail loudly if a locally closed union gains an unhandled member. */
function assertNever(value) {
  throw new TypeError(`unknown manual compaction error code: ${String(value)}`);
}

/** Convert expected capability failures into concise human-only outcomes. */
function expectedFailure(error) {
  switch (error.code) {
    case 'busy':
      return {
        kind: 'error',
        text: 'Reset is unavailable because this process has an active compaction, or the agent is not idle.',
      };
    case 'cancelled':
      return { kind: 'error', text: 'Reset cancelled.' };
    case 'changed':
      return {
        kind: 'error',
        text: 'The history selected for the reset changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.',
      };
    case 'summary':
      return {
        kind: 'error',
        text: 'The reset could not produce a smaller replacement. The conversation is unchanged; the attempt is recorded in the session log.',
      };
    case 'commit':
      return {
        kind: 'error',
        text: 'The reset did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
      };
    case 'persistence':
      return { kind: 'error', text: 'The reset finished, but the session could not be saved.' };
    /* v8 ignore next -- ManualCompactionErrorCode is closed and every member is handled above */
    default:
      return assertNever(error.code);
  }
}

/** The pin-cleanup half of the outcome, phrased from what really happened. */
function pinCleanupText(outcome) {
  if (outcome.error !== undefined) {
    const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return ` Task pins could NOT be freed (${reason}); they are still pinned — verify with context_list and retry with context_free.`;
  }
  if (outcome.cleared > 0) {
    return ` ${outcome.cleared} task pin${outcome.cleared > 1 ? 's' : ''} freed; workspace pins stay pinned.`;
  }
  return ' No task pins were pinned.';
}

/**
 * Register `/reset` against the shared commands registry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - root plugin context.
 * @param {import('./engine.js').ContextResetEngine} engine - the isolated engine instance.
 * @param {import('./malloc.js').PinStore} pinStore - vault whose task pins the reset bulk-frees.
 */
export function registerResetCommand(ctx, engine, pinStore) {
  const executeReset = async (invocation) => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE };
    try {
      const result = await engine.compactNow(invocation.agent, invocation.signal, invocation.commandId);
      if (result === null) return { kind: 'success', text: 'No resettable history yet.' };
      // The bulk-free half of the malloc contract: task pins die with the heap
      // they described; workspace pins and notes carry over. The replacement
      // already committed, so a cleanup failure is reported, never hidden.
      const cleanup = await pinStore.clearTask(invocation.agent.session.id);
      if (cleanup.error !== undefined) {
        ctx.logger.warn(
          `context-manager: /reset left task pins pinned: ${
            cleanup.error instanceof Error ? cleanup.error.message : String(cleanup.error)
          }`,
        );
      }
      return {
        kind: 'success',
        text: `Context window reset: ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens) left the active context. Durable notes were re-injected; everything remains searchable with history_search.${pinCleanupText(cleanup)}`,
        sourceEventSeq: result.summarySeq,
      };
    } catch (error) {
      if (invocation.signal.aborted) return { kind: 'error', text: 'Reset cancelled.' };
      if (error instanceof ManualCompactionError) return expectedFailure(error);
      throw error;
    }
  };
  const active = new Set();
  const handler = (invocation) => {
    const operation = executeReset(invocation);
    active.add(operation);
    const retire = () => {
      active.delete(operation);
    };
    operation.then(retire, retire);
    return operation;
  };
  ctx.effect(function* () {
    yield async () => {
      await Promise.allSettled(active);
    };
    yield ctx.commands.register({
      name: 'reset',
      description: 'Hard-reset the context window: task pins freed, notes re-injected, history stays searchable',
      handler,
    });
  }, 'context-manager: /reset lifecycle');
}

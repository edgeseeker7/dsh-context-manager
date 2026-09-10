import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * dsh-context-manager — the malloc layer ("the vault").
 *
 * Pins are VERBATIM facts the model explicitly allocates: exact versions,
 * constraints, credentials, paths — anything where one wrong character
 * breaks. They render into the LAST system-prompt section, so no compaction
 * or /reset can shadow them and they are never paraphrased by an LLM. The
 * model manages them itself through a malloc-style API:
 *
 *   context_alloc(text, label, scope)  → handle (t* task / w* workspace)
 *   context_free(handle)               → explicit release
 *   context_list()                     → allocation table with quota costs
 *
 * Design rules (grilled and frozen):
 * - Handles are monotonic and NEVER reused: a freed handle stays dangling
 *   (visible in context_list as gone), it can never point at new content.
 * - Two scopes: task pins die with /reset (the bulk-free); workspace pins
 *   persist across sessions of the same workspace (session.header.cwd).
 * - Quota has two gates: a per-pin char cap and a total cap of
 *   min(pinsMaxChars, windowRatio × contextWindow × CHARS_PER_TOKEN) — the
 *   vault can never crowd out the heap it protects.
 * - Quota exhaustion rejects the alloc and names the oldest task pins as
 *   free candidates — honest failure with a handrail, never silent eviction.
 * @module dsh-context-manager/malloc
 */

export const ALLOC_TOOL = 'context_alloc';
export const FREE_TOOL = 'context_free';
export const LIST_TOOL = 'context_list';

/** Prompt-section placement: AFTER the official persona suffix (10200) — the
 * vault must be the last section before the conversation, so pin changes
 * invalidate the least possible prefix. */
export const PIN_SECTION_ORDER = 10300;

/** Conservative chars-per-token estimate for the window-ratio quota gate. */
const CHARS_PER_TOKEN = 3;

/** Tools that count as memory work and reset the cadence-nudge counter. */
const MEMORY_TOOLS = new Set([ALLOC_TOOL, FREE_TOOL, LIST_TOOL, 'notes_append']);

/**
 * Slugify a workspace cwd into a filename-safe isolation key. Deterministic
 * and independent of any harness-internal slug format.
 */
export function workspaceSlug(cwd) {
  const slug = String(cwd ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'global';
}

function safeName(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function humanAge(createdAt, now) {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export class PinStore {
  /**
   * @param {object} config
   * @param {number} config.pinMaxChars - per-pin verbatim text cap.
   * @param {number} config.pinsMaxChars - total chars cap across both scopes.
   * @param {number} config.windowRatio - share of the context window pins may
   *   occupy (converted with CHARS_PER_TOKEN); the tighter of the two caps wins.
   * @param {number} config.suggestCount - oldest task pins named on quota rejection.
   */
  constructor({ pinMaxChars, pinsMaxChars, windowRatio, suggestCount }) {
    this.pinMaxChars = pinMaxChars;
    this.pinsMaxChars = pinsMaxChars;
    this.windowRatio = windowRatio;
    this.suggestCount = suggestCount;
  }

  taskFile(sessionId) {
    return dshHomePath('context-manager', 'pins', `${safeName(sessionId)}.json`);
  }

  permanentFile(cwd) {
    return dshHomePath('context-manager', 'pins', 'ws', `${workspaceSlug(cwd)}.json`);
  }

  load(file) {
    if (!existsSync(file)) return { nextHandle: 1, pins: [] };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!Number.isInteger(parsed.nextHandle) || !Array.isArray(parsed.pins)) throw new Error('bad shape');
      return parsed;
    } catch {
      // A corrupt store must never take memory down: start empty; the log
      // still holds every pin text for recovery.
      return { nextHandle: 1, pins: [] };
    }
  }

  /** Atomic write: tmp file + rename, so a crash never leaves a torn store. */
  save(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, file);
  }

  /** Effective total quota in chars; the window-ratio gate tightens small windows. */
  quotaChars(window) {
    if (!Number.isInteger(window) || window <= 0) return this.pinsMaxChars;
    return Math.max(1000, Math.min(this.pinsMaxChars, Math.floor(window * this.windowRatio * CHARS_PER_TOKEN)));
  }

  totalChars(...stores) {
    return stores.reduce((sum, store) => sum + store.pins.reduce((s, pin) => s + pin.text.length, 0), 0);
  }

  /**
   * Allocate one verbatim pin. Scope decides the store and the handle prefix:
   * task pins (t*) live in the session file and are bulk-freed by /reset;
   * workspace pins (w*) live in the workspace file shared by every session
   * (and subagent) of this workspace.
   */
  alloc({ sessionId, cwd, text, label, scope }, window) {
    const content = String(text ?? '').trim();
    if (content.length === 0) return { accepted: false, reason: 'empty text — nothing to pin' };
    if (content.length > this.pinMaxChars) {
      return {
        accepted: false,
        reason: `pin is ${content.length} chars, over the per-pin cap of ${this.pinMaxChars} — pin only the verbatim-critical core, or split into several pins`,
      };
    }
    const isTask = scope !== 'permanent';
    const file = isTask ? this.taskFile(sessionId) : this.permanentFile(cwd);
    const store = this.load(file);
    const otherFile = isTask ? this.permanentFile(cwd) : this.taskFile(sessionId);
    const other = this.load(otherFile);
    const quota = this.quotaChars(window);
    const used = this.totalChars(store, other);
    if (used + content.length > quota) {
      const candidates = this.load(this.taskFile(sessionId))
        .pins.slice(0, this.suggestCount)
        .map((pin) => `[${pin.handle}] ${pin.label} (${pin.text.length} chars)`);
      return {
        accepted: false,
        reason:
          `quota exceeded: ${used} + ${content.length} chars > ${quota} total cap. ` +
          `Free something first with context_free.${
            candidates.length > 0 ? ` Oldest task pins: ${candidates.join('; ')}` : ' No task pins to suggest.'
          }`,
      };
    }
    const handle = `${isTask ? 't' : 'w'}${store.nextHandle}`;
    const pin = {
      handle,
      label: String(label ?? '').trim() || content.split('\n', 1)[0].slice(0, 40),
      text: content,
      createdAt: Date.now(),
    };
    store.nextHandle += 1;
    store.pins.push(pin);
    this.save(file, store);
    return { accepted: true, handle, chars: content.length, usedTotal: used + content.length, quota };
  }

  /** Free one pin by handle. Handles are never reused after a free. */
  free({ sessionId, cwd, handle }) {
    const id = String(handle ?? '').trim();
    if (!/^[tw]\d+$/.test(id)) return { accepted: false, reason: `unknown handle "${id}" — handles look like t1 / w2` };
    const file = id.startsWith('t') ? this.taskFile(sessionId) : this.permanentFile(cwd);
    const store = this.load(file);
    const index = store.pins.findIndex((pin) => pin.handle === id);
    if (index === -1) {
      return {
        accepted: false,
        reason: `${id} is not pinned (already freed, or it belongs to another session/workspace)`,
      };
    }
    const [pin] = store.pins.splice(index, 1);
    this.save(file, store);
    return { accepted: true, freed: id, label: pin.label, chars: pin.text.length };
  }

  /**
   * The bulk-free behind /reset: wipe the session's task pins, keep
   * workspace pins. The handle counter SURVIVES: old log text referencing
   * "t3" must never resolve to a different pin allocated after the reset —
   * task handles are monotonic for the whole session lifetime (no ABA).
   */
  clearTask(sessionId) {
    const file = this.taskFile(sessionId);
    const store = this.load(file);
    const count = store.pins.length;
    if (count > 0 || existsSync(file)) this.save(file, { nextHandle: store.nextHandle, pins: [] });
    return count;
  }

  /** The allocation table for context_list. */
  list({ sessionId, cwd }, window) {
    const task = this.load(this.taskFile(sessionId)).pins;
    const permanent = this.load(this.permanentFile(cwd)).pins;
    const used = this.totalChars({ pins: task }, { pins: permanent });
    return { task, permanent, used, quota: this.quotaChars(window) };
  }

  /**
   * Render the vault as the LAST system-prompt section. Verbatim pin text is
   * reproduced exactly; insertion order is the allocation order (stable for
   * the KV cache). Empty vault → empty section (dropped from the prompt).
   */
  render(sessionId, cwd) {
    const task = this.load(this.taskFile(sessionId)).pins;
    const permanent = this.load(this.permanentFile(cwd)).pins;
    if (task.length === 0 && permanent.length === 0) return '';
    const lines = [
      'Pinned facts — VERBATIM and authoritative, pinned by you with context_alloc. Compaction and /reset never shadow or paraphrase them. t* task pins are cleared by /reset; w* workspace pins persist across sessions in this workspace. Free stale ones with context_free; usage via context_list.',
    ];
    for (const pin of [...permanent, ...task]) {
      lines.push(`[${pin.handle}] ${pin.label}`);
      lines.push(pin.text);
    }
    return lines.join('\n');
  }
}

/** Register the three malloc tools, the vault section, and the cadence nudge. */
export function installMalloc(agent, store, { resolveWindow, nudgeEvery, logger }) {
  const sessionId = agent.session.id;
  const cwd = agent.session.header?.cwd;

  agent.ctx.systemPrompt.section({
    name: 'context-manager:pins',
    order: PIN_SECTION_ORDER,
    text: () => {
      try {
        return store.render(sessionId, cwd);
      } catch (error) {
        logger?.warn?.(
          `context-manager: pin section render failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return '';
      }
    },
  });

  agent.ctx.tools.register(
    defineTool({
      name: ALLOC_TOOL,
      description:
        'Pin a VERBATIM fact into the always-visible vault (system prompt) so no compaction or /reset can lose or paraphrase it. Use ONLY for facts where one wrong character breaks things: exact versions, constraints, credentials, paths, IDs, user mandates. scope "task" (default) dies with /reset; scope "permanent" persists across sessions in this workspace. Updates are free + alloc. Quota is bounded — pin the critical core, not paragraphs.',
      parameters: {
        text: { type: 'string', required: true, description: 'The exact verbatim text to pin.' },
        label: {
          type: 'string',
          description: 'Short label for the allocation table (defaults to the first line of text).',
        },
        scope: {
          type: 'string',
          enum: ['task', 'permanent'],
          description:
            'task = cleared by /reset (default); permanent = survives /reset and new sessions of this workspace.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accepted: { type: 'boolean', required: true },
            handle: { type: 'string' },
            reason: { type: 'string' },
            chars: { type: 'number' },
            usedTotal: { type: 'number' },
            quota: { type: 'number' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.accepted
              ? `pinned as ${value.handle} (${value.chars} chars, vault ${value.usedTotal}/${value.quota}) — verbatim until freed`
              : `not pinned: ${value.reason}`,
          },
        ],
      },
      execute: async (args) => {
        const window = await resolveWindow(agent);
        return store.alloc({ sessionId, cwd, ...args }, window);
      },
    }),
  );

  agent.ctx.tools.register(
    defineTool({
      name: FREE_TOOL,
      description:
        'Free one pin from the vault by handle (see context_list). Do this the moment a pinned fact goes stale — an outdated pin is authoritative wrong information. Handles are never reused.',
      parameters: {
        handle: { type: 'string', required: true, description: 'The pin handle, e.g. t1 or w2.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accepted: { type: 'boolean', required: true },
            freed: { type: 'string' },
            label: { type: 'string' },
            chars: { type: 'number' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.accepted ? `freed ${value.freed} (${value.label})` : `not freed: ${value.reason}`,
          },
        ],
      },
      execute: (args) => store.free({ sessionId, cwd, ...args }),
    }),
  );

  agent.ctx.tools.register(
    defineTool({
      name: LIST_TOOL,
      description:
        'Show the vault allocation table: every pin with handle, label, size and age, plus total usage against quota.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      isConcurrencySafe: () => true,
      execute: async () => {
        const window = await resolveWindow(agent);
        const { task, permanent, used, quota } = store.list({ sessionId, cwd }, window);
        const now = Date.now();
        const row = (pin) =>
          `  [${pin.handle}] ${pin.label} — ${pin.text.length} chars, age ${humanAge(pin.createdAt, now)}`;
        const lines = [
          `Task pins (cleared by /reset): ${task.length}`,
          ...(task.length === 0 ? ['  (none)'] : task.map(row)),
          `Workspace pins (persist across sessions): ${permanent.length}`,
          ...(permanent.length === 0 ? ['  (none)'] : permanent.map(row)),
          `Total: ${used} / ${quota} chars`,
        ];
        return { text: lines.join('\n') };
      },
    }),
  );

  // Cadence nudge (the notify_user pattern): every nudgeEvery non-memory tool
  // executions, attach a reminder to that tool result. Nudges ride tool
  // results (conversation tail) so they cost almost no KV cache.
  let executionsSinceMemory = 0;
  agent.ctx.on('tools/post-execute', async (exec, _result, next) => {
    let nudge = null;
    if (MEMORY_TOOLS.has(exec.name)) {
      executionsSinceMemory = 0;
    } else {
      executionsSinceMemory += 1;
      if (executionsSinceMemory >= nudgeEvery) {
        executionsSinceMemory = 0;
        nudge = {
          id: randomUUID(),
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Memory check: if recent work produced a verbatim-critical fact (exact version, constraint, credential, path, ID, user mandate), pin it with context_alloc — scope "task" for this task, "permanent" for cross-session facts. Free stale pins with context_free. Then continue working.',
            },
          ],
          source: { kind: 'plugin', plugin: 'dsh-context-manager', form: 'notice', summary: 'pin cadence nudge' },
        };
      }
    }
    const downstream = await next();
    if (nudge === null) return downstream;
    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: [nudge, ...(downstream.additionalContexts ?? [])],
      };
    }
    return { ...downstream, additionalContexts: [nudge, ...(downstream.additionalContexts ?? [])] };
  });
}

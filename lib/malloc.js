import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withFileLock } from './lock.js';

/**
 * dsh-context-manager — the malloc layer ("the vault").
 *
 * Pins are VERBATIM facts the model explicitly allocates: exact versions,
 * constraints, credentials, paths — anything where one wrong character
 * breaks. They render into the LAST system-prompt section, which is
 * re-assembled on every request, so no compaction can shadow or paraphrase
 * them. The model manages them itself:
 *
 *   context_alloc(text, label, scope)  → handle (t* task / w* workspace)
 *   context_free(handle)               → explicit release
 *   context_list()                     → allocation table with quota costs
 *
 * Rules:
 * - Handles are monotonic for the lifetime of a store: free and clearTask keep
 *   the counter, and a corrupt store salvages it before being quarantined. A
 *   counter that could not be salvaged is warned about, because log text
 *   referencing "t3" must not silently resolve to newer content.
 * - Two scopes: task pins are freed by /reset; workspace pins persist across
 *   sessions of the same workspace (session.header.cwd).
 * - The quota is derived per allocation from the model THIS agent is routed
 *   to: pinsWindowRatio × that model's declared contextWindow (converted at
 *   CHARS_PER_TOKEN). pinMaxChars / pinsMaxChars are fallback caps, used only
 *   when the window cannot be resolved.
 * - Every mutation runs inside a cross-process lockfile (lock.js).
 * - Quota exhaustion rejects the alloc and names the oldest task pins as
 *   free candidates — honest failure, never silent eviction.
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

/** A label is rendered and billed, so it is capped (ellipsis included). */
const MAX_LABEL_CHARS = 200;

/** Per-pin rendering overhead: "[handle] " plus the two line breaks. */
const PIN_ROW_OVERHEAD = 4;

/** Tools that count as memory work and reset the cadence-nudge counter. */
const MEMORY_TOOLS = new Set([ALLOC_TOOL, FREE_TOOL, LIST_TOOL, 'notes_append']);

/**
 * Isolation key for a workspace: sha256 of the NORMALIZED absolute path,
 * truncated to 16 hex chars. Slugging was lossy — `/a/b` and `/a-b` collided,
 * `/Repo` and `/repo` merged, and a missing cwd landed on every other one.
 */
export function workspaceSlug(cwd) {
  const raw = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : process.cwd();
  return createHash('sha256').update(resolve(raw)).digest('hex').slice(0, 16);
}

/** The v1.1.0 lossy slug; kept only to migrate files written by older builds. */
function legacyWorkspaceSlug(cwd) {
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Cap a label at MAX_LABEL_CHARS; the label is billed exactly like the text. */
function normalizeLabel(label) {
  const trimmed = String(label ?? '').trim();
  return trimmed.length <= MAX_LABEL_CHARS ? trimmed : `${trimmed.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

/** Chars one pin costs in the rendered vault section: row + label + verbatim text. */
function pinCost(pin) {
  return pin.text.length + pin.label.length + pin.handle.length + PIN_ROW_OVERHEAD;
}

function usedChars(...stores) {
  return stores.reduce((sum, store) => sum + store.pins.reduce((s, pin) => s + pinCost(pin), 0), 0);
}

export class PinStore {
  /**
   * @param {object} config
   * @param {number} config.pinMaxChars - per-pin cap; fallback for an unresolved window.
   * @param {number} config.pinsMaxChars - total cap; fallback for an unresolved window.
   * @param {number} config.windowRatio - share of the resolved context window pins may
   *   occupy (converted with CHARS_PER_TOKEN). This is the live gate.
   * @param {number} config.suggestCount - oldest task pins named on quota rejection.
   * @param {object} [config.logger] - host logger, for quarantine and migration warnings.
   */
  constructor({ pinMaxChars, pinsMaxChars, windowRatio, suggestCount, logger }) {
    this.pinMaxChars = pinMaxChars;
    this.pinsMaxChars = pinsMaxChars;
    this.windowRatio = windowRatio;
    this.suggestCount = suggestCount;
    this.logger = logger;
  }

  taskFile(sessionId) {
    return dshHomePath('context-manager', 'pins', `${safeName(sessionId)}.json`);
  }

  /**
   * One lock for every pin file: the quota gate spans the task file and the
   * workspace file, so per-file locks could interleave those two reads and
   * admit an over-quota pair. Pin mutations are rare — serialization is free.
   */
  lockFile() {
    return dshHomePath('context-manager', 'pins', '.lock');
  }

  permanentFile(cwd) {
    const file = dshHomePath('context-manager', 'pins', 'ws', `${workspaceSlug(cwd)}.json`);
    this.migrateWorkspaceFile(cwd, file);
    return file;
  }

  /**
   * v1.1.0 named workspace files by the lossy slug; rename such a file to the
   * hashed key the first time it is touched — but only when the hashed file
   * does not exist, so an existing file always wins and nothing is overwritten.
   */
  migrateWorkspaceFile(cwd, file) {
    const legacy = dshHomePath('context-manager', 'pins', 'ws', `${legacyWorkspaceSlug(cwd)}.json`);
    if (legacy === file || !existsSync(legacy) || existsSync(file)) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      renameSync(legacy, file);
      this.logger?.warn?.(`context-manager: migrated workspace pins ${legacy} -> ${file}`);
      return;
    } catch (error) {
      try {
        copyFileSync(legacy, file, constants.COPYFILE_EXCL);
        this.logger?.warn?.(
          `context-manager: copied workspace pins ${legacy} -> ${file} (rename failed: ${errorMessage(error)})`,
        );
      } catch (copyError) {
        this.logger?.warn?.(
          `context-manager: workspace pin migration ${legacy} -> ${file} failed: ${errorMessage(copyError)}`,
        );
      }
    }
  }

  /**
   * Read one store. A corrupt file is renamed aside and warned about — never
   * silently interpreted as an empty store. The handle counter is salvaged
   * from the raw text when possible; when it cannot be, the warning says so,
   * because handles referenced by older log text may then be re-issued.
   */
  load(file) {
    if (!existsSync(file)) return { nextHandle: 1, pins: [] };
    const raw = readFileSync(file, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (!Number.isInteger(parsed?.nextHandle) || parsed.nextHandle < 1) throw new Error('bad nextHandle');
      if (!Array.isArray(parsed.pins)) throw new Error('bad pins');
      if (!parsed.pins.every((pin) => typeof pin?.handle === 'string' && typeof pin.text === 'string')) {
        throw new Error('bad pin entry');
      }
      const pins = parsed.pins.map((pin) => ({
        handle: pin.handle,
        label: typeof pin.label === 'string' ? pin.label : '',
        text: pin.text,
        createdAt: Number.isFinite(pin.createdAt) ? pin.createdAt : 0,
      }));
      let { nextHandle } = parsed;
      const highest = pins.reduce((max, pin) => {
        const match = /^[tw](\d+)$/.exec(pin.handle);
        return match === null ? max : Math.max(max, Number(match[1]));
      }, 0);
      if (nextHandle <= highest) {
        nextHandle = highest + 1;
        this.logger?.warn?.(`context-manager: pin store ${file} had nextHandle <= ${highest}; raised to ${nextHandle}`);
      }
      return { nextHandle, pins };
    } catch (error) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantine = `${file}.corrupt-${stamp}`;
      const salvaged = /"nextHandle"\s*:\s*(\d+)/.exec(raw);
      const nextHandle = salvaged === null || Number(salvaged[1]) < 1 ? 1 : Number(salvaged[1]);
      let moved = quarantine;
      try {
        renameSync(file, quarantine);
      } catch (renameError) {
        moved = `(could not be moved aside: ${errorMessage(renameError)})`;
      }
      this.logger?.warn?.(
        `context-manager: corrupt pin store ${file} (${errorMessage(error)}); quarantined as ${moved}; starting empty. ` +
          (salvaged === null
            ? 'handle counter could not be salvaged and restarts at 1 — old handle references may now point at different pins.'
            : `handle counter salvaged (nextHandle=${nextHandle}).`),
      );
      return { nextHandle, pins: [] };
    }
  }

  /** Atomic write: tmp file + rename, so a crash never leaves a torn store. */
  save(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, file);
  }

  /**
   * Total pin quota in chars for the window the calling agent actually routed
   * to: pinsWindowRatio × window tokens × CHARS_PER_TOKEN. No absolute floor —
   * a small window really does allow only a few hundred chars. `pinsMaxChars`
   * is returned ONLY when no window could be resolved.
   */
  quotaChars(window) {
    if (!Number.isInteger(window) || window <= 0) return this.pinsMaxChars;
    return Math.floor(window * this.windowRatio * CHARS_PER_TOKEN);
  }

  /** Per-pin cap: window-derived when the window is known, the config fallback when not. */
  pinCapChars(window, quota) {
    return Number.isInteger(window) && window > 0 ? quota : this.pinMaxChars;
  }

  /**
   * Allocate one verbatim pin. Scope decides the store and the handle prefix:
   * task pins (t*) live in the session file and are bulk-freed by /reset;
   * workspace pins (w*) live in the workspace file shared by every session
   * (and subagent) of this workspace. The billed cost is the rendered pin:
   * verbatim text + label + handle row.
   */
  async alloc({ sessionId, cwd, text, label, scope }, window) {
    const content = String(text ?? '').trim();
    if (content.length === 0) return { accepted: false, reason: 'empty text — nothing to pin' };
    const labelText = normalizeLabel(String(label ?? '').trim() || content.split('\n', 1)[0].slice(0, 40));
    const isTask = scope !== 'permanent';
    const file = isTask ? this.taskFile(sessionId) : this.permanentFile(cwd);
    const otherFile = isTask ? this.permanentFile(cwd) : this.taskFile(sessionId);
    const windowKnown = Number.isInteger(window) && window > 0;
    return await withFileLock(
      this.lockFile(),
      () => {
        const store = this.load(file);
        const other = this.load(otherFile);
        const quota = this.quotaChars(window);
        const perPinCap = this.pinCapChars(window, quota);
        const handle = `${isTask ? 't' : 'w'}${store.nextHandle}`;
        const pin = { handle, label: labelText, text: content, createdAt: Date.now() };
        const cost = pinCost(pin);
        if (cost > perPinCap) {
          return {
            accepted: false,
            reason:
              `pin costs ${cost} chars (${content.length} text + ${labelText.length} label + handle row), over the per-pin cap of ${perPinCap}` +
              `${windowKnown ? ` derived from the ${window}-token context window` : ' (fallback cap: the context window could not be resolved)'} — pin only the verbatim-critical core, or split into several pins`,
          };
        }
        const used = usedChars(store, other);
        if (used + cost > quota) {
          const candidates = (isTask ? store : other).pins
            .slice(0, this.suggestCount)
            .map((candidate) => `[${candidate.handle}] ${candidate.label} (${pinCost(candidate)} chars)`);
          return {
            accepted: false,
            reason:
              `quota exceeded: ${used} + ${cost} chars > ${quota} total cap` +
              `${windowKnown ? ` (${Math.round(this.windowRatio * 100)}% of the ${window}-token context window)` : ' (fallback cap: the context window could not be resolved)'}. ` +
              `Free something first with context_free.${
                candidates.length > 0 ? ` Oldest task pins: ${candidates.join('; ')}` : ' No task pins to suggest.'
              }`,
          };
        }
        store.nextHandle += 1;
        store.pins.push(pin);
        this.save(file, store);
        return { accepted: true, handle, chars: cost, usedTotal: used + cost, quota };
      },
      { logger: this.logger },
    );
  }

  /** Free one pin by handle. The freed handle is not re-issued while the store lives. */
  async free({ sessionId, cwd, handle }) {
    const id = String(handle ?? '').trim();
    if (!/^[tw]\d+$/.test(id)) {
      return { accepted: false, reason: `unknown handle "${id}" — handles look like t1 / w2` };
    }
    const file = id.startsWith('t') ? this.taskFile(sessionId) : this.permanentFile(cwd);
    return await withFileLock(
      this.lockFile(),
      () => {
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
        return { accepted: true, freed: id, label: pin.label, chars: pinCost(pin) };
      },
      { logger: this.logger },
    );
  }

  /**
   * The bulk-free behind /reset: wipe the session's task pins, keep workspace
   * pins, keep the handle counter (so old log text referencing "t3" never
   * resolves to a pin allocated after the reset).
   *
   * A transient failure is retried once and warned about. The result carries
   * the real outcome — `cleared` is only meaningful while `error` is
   * undefined, so a caller cannot report a free that did not happen.
   * @returns {Promise<{cleared: number, error?: Error}>}
   */
  async clearTask(sessionId, { retries = 1 } = {}) {
    const file = this.taskFile(sessionId);
    const clear = () => {
      const store = this.load(file);
      const count = store.pins.length;
      if (count > 0 || existsSync(file)) this.save(file, { nextHandle: store.nextHandle, pins: [] });
      return count;
    };
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return { cleared: await withFileLock(this.lockFile(), clear, { logger: this.logger }) };
      } catch (error) {
        lastError = error;
        this.logger?.warn?.(
          `context-manager: clearTask attempt ${attempt + 1}/${retries + 1} failed for ${file}: ${errorMessage(error)}`,
        );
      }
    }
    return { cleared: 0, error: lastError ?? new Error('clearTask failed') };
  }

  /** The allocation table for context_list. */
  list({ sessionId, cwd }, window) {
    const task = this.load(this.taskFile(sessionId)).pins;
    const permanent = this.load(this.permanentFile(cwd)).pins;
    const used = usedChars({ pins: task }, { pins: permanent });
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
      'Pinned facts — VERBATIM and authoritative, pinned by you with context_alloc. Compaction never shadows or paraphrases them; t* task pins are cleared by /reset, w* workspace pins persist across sessions in this workspace. Free stale ones with context_free; usage via context_list.',
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
        logger?.warn?.(`context-manager: pin section render failed: ${errorMessage(error)}`);
        return '';
      }
    },
  });

  agent.ctx.tools.register(
    defineTool({
      name: ALLOC_TOOL,
      description:
        'Pin a VERBATIM fact into the always-visible vault (system prompt) so no compaction can lose or paraphrase it. Use ONLY for facts where one wrong character breaks things: exact versions, constraints, credentials, paths, IDs, user mandates. scope "task" (default) is cleared by /reset; scope "permanent" also survives /reset and persists across sessions in this workspace. Updates are free + alloc. The quota is derived from the context window of the model you are routed to — pin the critical core, not paragraphs.',
      parameters: {
        text: { type: 'string', required: true, description: 'The exact verbatim text to pin.' },
        label: {
          type: 'string',
          description:
            'Short label for the allocation table (defaults to the first line of text; capped at 200 chars and billed like the text).',
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
              ? `pinned as ${value.handle} (${value.chars} chars billed incl. label/handle, vault ${value.usedTotal}/${value.quota}) — verbatim until freed`
              : `not pinned: ${value.reason}`,
          },
        ],
      },
      execute: async (args) => {
        const window = await resolveWindow(agent);
        return await store.alloc({ sessionId, cwd, ...args }, window);
      },
    }),
  );

  agent.ctx.tools.register(
    defineTool({
      name: FREE_TOOL,
      description:
        'Free one pin from the vault by handle (see context_list). Do this the moment a pinned fact goes stale — an outdated pin is authoritative wrong information. Handles are monotonic: a freed handle stays dangling, and only a lost (quarantined) store can restart the counter.',
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
      execute: async (args) => await store.free({ sessionId, cwd, ...args }),
    }),
  );

  agent.ctx.tools.register(
    defineTool({
      name: LIST_TOOL,
      description:
        'Show the vault allocation table: every pin with handle, label, billed size and age, plus total usage against the quota derived from the current model context window.',
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
          `  [${pin.handle}] ${pin.label} — ${pinCost(pin)} chars billed (${pin.text.length} text + label/handle), age ${humanAge(pin.createdAt, now)}`;
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
              text: 'Memory check: pin (context_alloc) any verbatim-critical fact from recent work (exact version, constraint, credential, path, ID, user mandate) — scope "task" for this task, "permanent" across sessions; free stale pins with context_free. Note (notes_append) distilled progress, decisions, and dead ends. If nothing new, skip both and continue working.',
            },
          ],
          source: { kind: 'plugin', plugin: 'dsh-context-manager', form: 'notice', summary: 'memory cadence nudge' },
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

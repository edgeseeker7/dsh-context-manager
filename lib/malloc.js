import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { historySearchAsync, readEventText } from './history.js';
import { withFileLock } from './lock.js';
import { topTerms } from './tokens.js';

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

/**
 * Rough token estimate: CJK/full-width chars ≈ 1 token each (modern
 * tokenizers), everything else ≈ 4 chars/token. The old flat 3 chars/token
 * guess under-billed CJK content 2× — for Chinese-heavy sessions the vault
 * was twice its intended size. Estimation is documented and reported as
 * approximate everywhere it surfaces.
 */
export function estimateTokens(text) {
  const str = String(text ?? '');
  const cjk = (str.match(/[⺀-鿿豈-﫿＀-￯]/gu) ?? []).length;
  return Math.ceil(cjk + (str.length - cjk) / 4);
}

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

/** Estimated tokens one pin costs: text + label + handle-row overhead. */
function pinTokens(pin) {
  return estimateTokens(pin.text) + estimateTokens(pin.label) + 4;
}

function usedChars(...stores) {
  return stores.reduce((sum, store) => sum + store.pins.reduce((s, pin) => s + pinCost(pin), 0), 0);
}

function usedTokens(...stores) {
  return stores.reduce((sum, store) => sum + store.pins.reduce((s, pin) => s + pinTokens(pin), 0), 0);
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
    /** Files whose quarantine already happened (or its rename failed) — warn once per file per process, not once per request. */
    this.quarantineWarned = new Set();
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
    if (!existsSync(file)) return { nextHandle: 1, pins: [], quarantined: null };
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
        ...(Number.isSafeInteger(pin.sourceSeq) && pin.sourceSeq >= 0 ? { sourceSeq: pin.sourceSeq } : {}),
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
      return { nextHandle, pins, quarantined: null };
    } catch (error) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantine = `${file}.corrupt-${stamp}`;
      const salvaged = /"nextHandle"\s*:\s*(\d+)/.exec(raw);
      let nextHandle = salvaged === null || Number(salvaged[1]) < 1 ? 1 : Number(salvaged[1]);
      // A truncation can clip the counter digits themselves ("nextHandle": 12
      // cut to 1): raise the salvage over the highest handle still visible in
      // the raw text, so a clipped counter can never re-issue a live handle.
      const visible = [...raw.matchAll(/"handle"\s*:\s*"[tw](\d+)"/g)].reduce(
        (max, match) => Math.max(max, Number(match[1])),
        0,
      );
      if (nextHandle <= visible) nextHandle = visible + 1;
      let moved = quarantine;
      let renameFailed = false;
      try {
        renameSync(file, quarantine);
      } catch (renameError) {
        renameFailed = true;
        moved = `(could not be moved aside: ${errorMessage(renameError)})`;
      }
      // A failed rename retries on every load (= every request); warn once.
      if (!renameFailed || !this.quarantineWarned.has(file)) {
        this.quarantineWarned.add(file);
        this.logger?.warn?.(
          `context-manager: corrupt pin store ${file} (${errorMessage(error)}); quarantined as ${moved}; starting empty. ` +
            (salvaged === null
              ? 'handle counter could not be salvaged and restarts at 1 — old handle references may now point at different pins.'
              : `handle counter salvaged (nextHandle=${nextHandle}).`),
        );
      }
      return { nextHandle, pins: [], quarantined: renameFailed ? null : quarantine };
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
   * Total pin quota for the window the calling agent actually routed to. When
   * the window is known the quota is in TOKENS (pinsWindowRatio × window) and
   * pins are billed by estimateTokens — the old flat chars-per-token guess
   * under-billed CJK content 2×. When the window cannot be resolved the quota
   * falls back to the char-denominated config caps (pinsMaxChars), billed in
   * chars. No absolute floor either way.
   */
  quotaFor(window) {
    if (!Number.isInteger(window) || window <= 0) return { quota: this.pinsMaxChars, unit: 'chars' };
    return { quota: Math.floor(window * this.windowRatio), unit: 'tokens' };
  }

  /** Per-pin cap: quota when the window is known, pinMaxChars (chars) when not. */
  pinCapFor(window, quota) {
    return Number.isInteger(window) && window > 0
      ? { cap: quota, unit: 'tokens' }
      : { cap: this.pinMaxChars, unit: 'chars' };
  }

  /** Kept for the render gate: the quota as a single number with its unit. */
  quotaChars(window) {
    return this.quotaFor(window).quota;
  }

  /** The render gate's unit for a given window (tokens when known). */
  quotaUnit(window) {
    return this.quotaFor(window).unit;
  }

  /**
   * Allocate one verbatim pin. Scope decides the store and the handle prefix:
   * task pins (t*) live in the session file and are bulk-freed by /reset;
   * workspace pins (w*) live in the workspace file shared by every session
   * (and subagent) of this workspace. Billing unit depends on the window:
   * estimated tokens when known, chars under the fallback caps otherwise.
   */
  async alloc({ sessionId, cwd, text, label, scope, sourceSeq }, window) {
    const content = String(text ?? '').trim();
    if (content.length === 0) return { accepted: false, reason: 'empty text — nothing to pin' };
    if (sourceSeq !== undefined && (!Number.isSafeInteger(sourceSeq) || sourceSeq < 0)) {
      return {
        accepted: false,
        reason: `bad sourceSeq ${String(sourceSeq)} — a log event seq is a non-negative integer`,
      };
    }
    const labelText = normalizeLabel(String(label ?? '').trim() || content.split('\n', 1)[0].slice(0, 40));
    const isTask = scope !== 'permanent';
    const file = isTask ? this.taskFile(sessionId) : this.permanentFile(cwd);
    const otherFile = isTask ? this.permanentFile(cwd) : this.taskFile(sessionId);
    const { quota, unit } = this.quotaFor(window);
    const { cap: perPinCap } = this.pinCapFor(window, quota);
    const windowKnown = unit === 'tokens';
    return await withFileLock(
      this.lockFile(),
      () => {
        const store = this.load(file);
        const other = this.load(otherFile);
        const handle = `${isTask ? 't' : 'w'}${store.nextHandle}`;
        const pin = {
          handle,
          label: labelText,
          text: content,
          createdAt: Date.now(),
          ...(sourceSeq !== undefined ? { sourceSeq } : {}),
        };
        const cost = windowKnown ? pinTokens(pin) : pinCost(pin);
        const costDetail = windowKnown
          ? `≈${cost} tokens (est: CJK≈1/char, other≈4 chars/token)`
          : `${cost} chars (${content.length} text + ${labelText.length} label + handle row)`;
        if (cost > perPinCap) {
          return {
            accepted: false,
            reason:
              `pin costs ${costDetail}, over the per-pin cap of ${perPinCap} ${unit}` +
              `${windowKnown ? ` derived from the ${window}-token context window` : ' (fallback cap: the context window could not be resolved)'} — pin only the verbatim-critical core, or split into several pins`,
          };
        }
        const used = windowKnown ? usedTokens(store, other) : usedChars(store, other);
        if (used + cost > quota) {
          const candidates = (isTask ? store : other).pins
            .slice(0, this.suggestCount)
            .map((candidate) => `[${candidate.handle}] ${candidate.label}`);
          return {
            accepted: false,
            reason:
              `quota exceeded: ${used} + ${cost} ${unit} > ${quota} total cap` +
              `${windowKnown ? ` (${Math.round(this.windowRatio * 100)}% of the ${window}-token context window)` : ' (fallback cap: the context window could not be resolved)'}. ` +
              `Free something first with context_free.${
                candidates.length > 0 ? ` Oldest task pins: ${candidates.join('; ')}` : ' No task pins to suggest.'
              }`,
          };
        }
        store.nextHandle += 1;
        store.pins.push(pin);
        this.save(file, store);
        return { accepted: true, handle, chars: pinCost(pin), tokens: cost, usedTotal: used + cost, quota, unit };
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
      return { count, quarantined: store.quarantined };
    };
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const result = await withFileLock(this.lockFile(), clear, { logger: this.logger });
        return { cleared: result.count, ...(result.quarantined !== null ? { quarantined: result.quarantined } : {}) };
      } catch (error) {
        lastError = error;
        this.logger?.warn?.(
          `context-manager: clearTask attempt ${attempt + 1}/${retries + 1} failed for ${file}: ${errorMessage(error)}`,
        );
      }
    }
    return { cleared: 0, error: lastError ?? new Error('clearTask failed') };
  }

  /** The allocation table for context_list (used shown in both units). */
  list({ sessionId, cwd }, window) {
    const task = this.load(this.taskFile(sessionId)).pins;
    const permanent = this.load(this.permanentFile(cwd)).pins;
    const { quota, unit } = this.quotaFor(window);
    return {
      task,
      permanent,
      used:
        unit === 'tokens'
          ? usedTokens({ pins: task }, { pins: permanent })
          : usedChars({ pins: task }, { pins: permanent }),
      usedChars: usedChars({ pins: task }, { pins: permanent }),
      quota,
      unit,
    };
  }

  /**
   * Render the vault as the LAST system-prompt section. Verbatim pin text is
   * reproduced exactly; insertion order is the allocation order (stable for
   * the KV cache). Empty vault → empty section (dropped from the prompt).
   *
   * `capChars` is the RENDER-time gate, evaluated with the READER's quota:
   * alloc is only a write-time admission gate, so a shared workspace file
   * filled by a big-window session could otherwise inject many times a
   * small-window session's quota into every request. Overflowing pins are
   * omitted LOUDLY — a named line, never a silent truncation (they remain
   * allocated and queryable via context_list).
   */
  render(sessionId, cwd, cap, capUnit = 'tokens') {
    const task = this.load(this.taskFile(sessionId)).pins;
    const permanent = this.load(this.permanentFile(cwd)).pins;
    if (task.length === 0 && permanent.length === 0) return '';
    const budget = Number.isInteger(cap) && cap > 0 ? cap : this.pinsMaxChars;
    const lines = [
      'Pinned facts — VERBATIM and authoritative, pinned by you with context_alloc. Compaction never shadows or paraphrases them; t* task pins are cleared by /reset, w* workspace pins persist across sessions in this workspace. Free stale ones with context_free; usage via context_list.',
    ];
    let used = 0;
    const omitted = [];
    for (const pin of [...permanent, ...task]) {
      const cost = capUnit === 'tokens' ? pinTokens(pin) : pinCost(pin);
      if (used > 0 && used + cost > budget) {
        omitted.push(pin);
        continue;
      }
      used += cost;
      lines.push(`[${pin.handle}] ${pin.label}`);
      lines.push(pin.text);
    }
    if (omitted.length > 0) {
      lines.push(
        `[vault overflow: ${omitted.length} pin${omitted.length > 1 ? 's' : ''} omitted (${omitted
          .map((pin) => pin.handle)
          .join(
            ', ',
          )}) — over the ~${budget}-${capUnit === 'tokens' ? 'token (est)' : 'char'} render cap for the current model's window. They are still allocated: see context_list, free with context_free.]`,
      );
    }
    return lines.join('\n');
  }
}

/** Gap signals in a drafted answer that prove memory was needed (high precision). */
const ANSWER_GAP_SIGNALS = [
  '请告知',
  '请提供',
  '我不记得',
  '我没有相关',
  '没有提到',
  '未能找到',
  '无法确定',
  '需要你告诉我',
  "i don't have",
  'i do not have',
  "i don't know",
  'please provide',
  'please share',
  'could you share',
  'not mentioned',
];

/** Text of the last real user message (injected notices are not user turns). */
function lastUserText(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') continue;
    const head = readEventText(session, event).slice(0, 64);
    if (head.startsWith('Current runtime context') || head.startsWith('Memory check (')) continue;
    return readEventText(session, event);
  }
  return '';
}

/** Text of the latest assistant message (the answer being drafted), if any. */
function lastAssistantText(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event?.type === 'assistant/message') return readEventText(session, event);
  }
  return '';
}

/** Register the three malloc tools, the vault section, and the smart nudge. */
export function installMalloc(
  agent,
  store,
  { resolveWindow, cachedWindow, nudgeEvery, measureTokens, suggestAnchors, logger },
) {
  // Retrieval pipeline + answer-gap gate — event-driven, never scheduled:
  //
  //   B) step 1 of every turn: run one history_search on the new user message
  //      and inject top-3 ONLY when the best match is strong (phrase hit or
  //      ≥2 distinct query tokens matched). Always-run retrieval, score-gated
  //      injection: turns with no relevant history stay silent (SME measured
  //      deterministic pipelines at 78.33% vs LLM-gated 46.67%; the gate is
  //      content, not position — no forced calls).
  //
  //   C) step ≥2: when the just-drafted answer shows a mechanical gap signal
  //      (unresolved reference / admitted ignorance), run ONE verification
  //      search — generate-then-verify; the cost is paid only on turns where
  //      the answer itself proves memory was needed (19ff8cd0#2's answer
  //      literally said "请告知四家主体名称").
  const PIPELINE_MIN_SEQ = 200; // ponytail: shorter histories are fully in context anyway
  let gapCheckedTurn = -1;
  agent.ctx.on('agent/pre-step', async ({ turn, step }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    try {
      const messages = decision.messages ?? [];
      if (step === 1) {
        if (agent.session.seq <= PIPELINE_MIN_SEQ) return decision;
        const userText = lastUserText(agent.session).slice(0, 2000);
        if (userText.trim().length < 4) return decision;
        const result = await historySearchAsync(agent.session, { query: userText, limit: 3 });
        // The strength gate ignores self-echoes: a turn whose only "match" is
        // the question itself has no relevant history.
        const top = result.matches.find((m) => m.echo !== true);
        const strong = top !== undefined && (top.tier === 0 || (top.matched ?? 0) >= 2);
        if (!strong) return decision;
        const body = result.matches
          .map((m) => `seq ${m.seq} [${m.type}] (offset ${m.offset}): ${m.snippet}`)
          .join('\n');
        const notice = createUserMessage({
          content: [
            {
              type: 'text',
              text:
                `[related history — best matches for your latest message]\n${body}\n` +
                '— judge relevance yourself; use it if it helps, ignore it if the task is unrelated to prior work. history_search / history_read can dig deeper.',
            },
          ],
          source: { kind: 'plugin', plugin: 'dsh-context-manager', form: 'notice', summary: 'related history' },
        });
        return { ...decision, messages: [...messages, notice] };
      }
      if (step >= 2 && turn !== gapCheckedTurn) {
        gapCheckedTurn = turn;
        const answer = lastAssistantText(agent.session);
        if (answer.length < 40) return decision;
        const lower = answer.toLowerCase();
        if (!ANSWER_GAP_SIGNALS.some((signal) => lower.includes(signal.toLowerCase()))) return decision;
        const userText = lastUserText(agent.session).slice(0, 1500);
        if (userText.trim().length < 4) return decision;
        const query = `${userText} ${topTerms(answer, 4).join(' ')}`;
        const result = await historySearchAsync(agent.session, { query, limit: 3 });
        if (result.matches.length === 0) return decision;
        const body = result.matches
          .map((m) => `seq ${m.seq} [${m.type}] (offset ${m.offset}): ${m.snippet}`)
          .join('\n');
        const notice = createUserMessage({
          content: [
            {
              type: 'text',
              text:
                `[answer-gap verification — the drafted answer signalled a memory gap; check these before finalizing]\n${body}\n` +
                '— if any match fills the gap, revise the answer with the concrete facts instead of asking the user for them.',
            },
          ],
          source: { kind: 'plugin', plugin: 'dsh-context-manager', form: 'notice', summary: 'answer-gap verification' },
        });
        return { ...decision, messages: [...messages, notice] };
      }
    } catch {
      return decision; // a failed pipeline never blocks the turn
    }
    return decision;
  });
  const sessionId = agent.session.id;
  const cwd = agent.session.header?.cwd;

  agent.ctx.systemPrompt.section({
    name: 'context-manager:pins',
    order: PIN_SECTION_ORDER,
    text: () => {
      try {
        // Render-time gate with the READER's window (fallback: config cap
        // until the window lands) — the write-time alloc gate alone cannot
        // protect a small-window session from a shared, big-window-filled
        // workspace vault.
        const window = cachedWindow?.(agent);
        return store.render(sessionId, cwd, store.quotaChars(window), store.quotaUnit(window));
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
        'Pin a VERBATIM fact into the always-visible vault (system prompt) so no compaction can lose or paraphrase it. Use ONLY for facts where one wrong character breaks things: exact versions, constraints, credentials, paths, IDs, user mandates. scope "task" (default) is cleared by /reset; scope "permanent" also survives /reset and persists across sessions in this workspace. Updates are free + alloc. The quota is derived from the context window of the model you are routed to — pin the critical core, not paragraphs. Pinning is not the default — when nothing meets the bar, pin nothing.',
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
        sourceSeq: {
          type: 'number',
          description:
            'Optional seq of the log event this fact came from — the provenance pointer, shown by context_list for later history_read verification. Not rendered into the vault itself.',
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
            unit: { type: 'string' },
            quota: { type: 'number' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.accepted
              ? `pinned as ${value.handle} (billed ${value.unit === 'tokens' ? `≈${value.tokens} tokens (est)` : `${value.chars} chars`} incl. label/handle, vault ${value.usedTotal}/${value.quota} ${value.unit ?? 'chars'}) — verbatim until freed`
              : `not pinned: ${value.reason}`,
          },
        ],
      },
      execute: async (args) => {
        try {
          const window = await resolveWindow(agent);
          return await store.alloc({ sessionId, cwd, ...args }, window);
        } catch (error) {
          // Lock contention and IO failures surface as an honest rejection,
          // never as a raw tool error the model cannot act on.
          return { accepted: false, reason: `alloc failed: ${errorMessage(error)}` };
        }
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
      execute: async (args) => {
        try {
          return await store.free({ sessionId, cwd, ...args });
        } catch (error) {
          return { accepted: false, reason: `free failed: ${errorMessage(error)}` };
        }
      },
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
        const { task, permanent, used, quota, unit } = store.list({ sessionId, cwd }, window);
        const now = Date.now();
        const row = (pin) =>
          `  [${pin.handle}] ${pin.label} — ${pinCost(pin)} chars billed (${pin.text.length} text + label/handle), age ${humanAge(pin.createdAt, now)}${pin.sourceSeq !== undefined ? `, src seq ${pin.sourceSeq}` : ''}`;
        const lines = [
          `Task pins (cleared by /reset): ${task.length}`,
          ...(task.length === 0 ? ['  (none)'] : task.map(row)),
          `Workspace pins (persist across sessions): ${permanent.length}`,
          ...(permanent.length === 0 ? ['  (none)'] : permanent.map(row)),
          `Total: ${used} / ${quota} ${unit ?? 'chars'}${unit === 'tokens' ? ' (est: CJK≈1/char, other≈4 chars/token)' : ''}`,
        ];
        return { text: lines.join('\n') };
      },
    }),
  );

  // Smart nudge (the notify_user pattern, upgraded from a fixed cadence):
  //
  //   TRIGGER — information produced, not tool calls. The nudge fires when
  //   the session has grown by ~5% of the context window since the last
  //   memory operation (fallback: nudgeEvery tool calls when the token meter
  //   is unavailable). Memory work should be proportional to new
  //   information, not to activity.
  //
  //   BACKOFF — a nudge that produces no memory operation before the next
  //   trigger doubles its threshold (capped at 8×); a productive one resets
  //   it. Reminders that get ignored get rarer instead of becoming
  //   wallpaper.
  //
  //   CONTENT — the nudge names concrete pin candidates extracted from
  //   recent events (ids/paths not already in the vault), and always keeps
  //   the honest out: skipping is the norm.
  //
  // Nudges ride tool results (conversation tail) so they cost almost no KV cache.
  const NUDGE_TOKEN_RATIO = 0.05;
  const NUDGE_TOKEN_FALLBACK = 12000;
  let lastMemoryTokens = null;
  let actedSinceNudge = true;
  let ignoredStreak = 0;
  let executionsSinceMemory = 0;
  const baseThreshold = () => {
    const window = cachedWindow?.(agent);
    return Number.isInteger(window) && window > 0
      ? Math.max(2000, Math.floor(window * NUDGE_TOKEN_RATIO))
      : NUDGE_TOKEN_FALLBACK;
  };
  let threshold = baseThreshold();
  const makeNudge = (producedText) => {
    const candidates = suggestAnchors?.(agent.session) ?? [];
    const text =
      candidates.length > 0
        ? `Memory check (${producedText}): candidates worth a verbatim pin IF still load-bearing — ${candidates.join('; ')}. Otherwise notes_append progress/decisions/dead ends (supersede stale ones), or skip — skipping is the norm.`
        : `Memory check (${producedText}): pin verbatim-critical facts (context_alloc), note distilled progress or dead ends (notes_append — supersede stale ones) — or skip; skipping is the norm.`;
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-context-manager', form: 'notice', summary: 'memory nudge' },
    };
  };
  agent.ctx.on('tools/post-execute', async (exec, _result, next) => {
    let nudge = null;
    if (MEMORY_TOOLS.has(exec.name)) {
      actedSinceNudge = true;
      ignoredStreak = 0;
      threshold = baseThreshold();
      executionsSinceMemory = 0;
      if (measureTokens !== undefined) {
        const total = measureTokens(agent.session);
        if (Number.isFinite(total)) lastMemoryTokens = total;
      }
    } else {
      const total = measureTokens?.(agent.session);
      if (Number.isFinite(total)) {
        if (lastMemoryTokens === null) lastMemoryTokens = total;
        const produced = total - lastMemoryTokens;
        if (produced >= threshold) {
          if (!actedSinceNudge) {
            ignoredStreak += 1;
            threshold = baseThreshold() * Math.min(2 ** ignoredStreak, 8);
          }
          actedSinceNudge = false;
          lastMemoryTokens = total;
          nudge = makeNudge(`~${Math.round(produced / 1000)}K tokens of new content since the last memory op`);
        }
      } else {
        // Token meter unavailable — fixed-cadence fallback.
        executionsSinceMemory += 1;
        if (executionsSinceMemory >= nudgeEvery) {
          executionsSinceMemory = 0;
          nudge = makeNudge(`${nudgeEvery} tool calls since the last memory op`);
        }
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

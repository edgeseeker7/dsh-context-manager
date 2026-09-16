import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withFileLock } from './lock.js';

/**
 * dsh-context-manager — durable notes ("the diary"), v2: structured storage.
 *
 * Notes are the model's own distilled prose: decisions and WHY, user
 * constraints, dead ends. Storage is append-only JSONL — one note per line:
 *
 *   {"id":"n7","ts":"2026-09-17T…","text":"…","tags":["eval"],"supersedes":["n3"],"sourceSeq":179}
 *
 * The append-only log is the source of truth; every view is DERIVED, never
 * stored. Three optional edge types let the model build its own structures
 * on top of the flat log — the plugin stores edges, the model invents the
 * graph:
 *
 *   - supersedes  — version chains: a correction names the notes it replaces.
 *                   Superseded notes fold into one-line audit entries pointing
 *                   at their ultimate active successor, so stale conclusions
 *                   stop being injected while staying recoverable.
 *   - tags        — hash buckets: free-form labels; notes_read can filter to
 *                   one bucket. The taxonomy is the model's to invent.
 *   - sourceSeq   — provenance: the log event the note was distilled from, so
 *                   a note can be traced back to its evidence with
 *                   history_read.
 *
 * Unlike pins, notes are never rendered into the system prompt — they are
 * injected into the /reset checkpoint (active view only) and readable on
 * demand. Appends run under a cross-process lockfile (lock.js).
 * @module dsh-context-manager/notes
 */

export const NOTES_APPEND_TOOL = 'notes_append';
export const NOTES_READ_TOOL = 'notes_read';

/** Make a session id safe as a single filename. */
function notesFilename(sessionId) {
  return `${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const NOTE_ID_PATTERN = /^n\d+$/;

/** Normalize the supersedes argument (string | string[]) to a clean id list. */
function normalizeSupersedes(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(list.map((id) => String(id).trim()).filter((id) => id.length > 0))];
}

/** Normalize tags to a deduped list of short lowercase strings (count validated by the caller). */
function normalizeTags(value) {
  const list = Array.isArray(value) ? value : [];
  return [
    ...new Set(
      list
        .map((tag) => String(tag).trim().toLowerCase())
        .filter((tag) => tag.length > 0 && tag.length <= 40 && !/\s/.test(tag)),
    ),
  ];
}

/**
 * Parse the pre-v2 markdown diary into entries. v1 format: blank-line
 * separated blocks headed by `<!-- ISO timestamp -->`; text before the first
 * marker (from the hand-written era) becomes one undated entry.
 */
export function parseLegacyMarkdown(content) {
  const trimmed = String(content ?? '').trim();
  if (trimmed.length === 0) return [];
  // A leading marker has no preceding newline for the splitter — lend it one.
  const normalized = trimmed.replace(/^<!--\s*([^>]+?)\s*-->\s*\n/, '\n<!-- $1 -->\n');
  const blocks = normalized.split(/\n\s*<!--\s*([^>]+?)\s*-->\s*\n/);
  const entries = [];
  // blocks = [prelude, ts1, body1, ts2, body2, …]
  if (blocks[0].trim().length > 0) entries.push({ ts: '', text: blocks[0].trim() });
  for (let index = 1; index + 1 < blocks.length; index += 2) {
    const text = blocks[index + 1].trim();
    if (text.length > 0) entries.push({ ts: blocks[index].trim(), text });
  }
  return entries;
}

export class NotesStore {
  /**
   * @param {number} maxChars - read budget; older notes truncate from the head.
   * @param {{logger?: object}} [options]
   */
  constructor(maxChars, { logger } = {}) {
    this.maxChars = maxChars;
    this.logger = logger;
  }

  path(sessionId) {
    return dshHomePath('context-manager', 'notes', `${notesFilename(sessionId)}.jsonl`);
  }

  /** v1 location (markdown diary), read once for migration. */
  legacyMdPath(sessionId) {
    return dshHomePath('context-manager', 'notes', `${notesFilename(sessionId)}.md`);
  }

  /** Pre-rename location (dsh-context-reset era), read once for migration. */
  legacyPath(sessionId) {
    return dshHomePath('context-reset', 'notes', `${notesFilename(sessionId)}.md`);
  }

  /** Identity of one entry for cross-source dedupe: timestamp + text. */
  fingerprint(entry) {
    return `${entry.ts} ${entry.text}`;
  }

  /**
   * Seed the JSONL store from the markdown sources when (and only when) the
   * store does not exist. Sources, oldest first: the pre-rename copy, then
   * the v1 diary; when the v1 diary already starts with the pre-rename text,
   * that source is skipped so entries never duplicate. The write is atomic
   * (tmp + rename) and deterministic, so two processes seeding concurrently
   * produce identical bytes. The original markdown is always left untouched.
   */
  migrate(sessionId) {
    const path = this.path(sessionId);
    if (existsSync(path)) return;
    const sources = [];
    const legacy = this.legacyPath(sessionId);
    const md = this.legacyMdPath(sessionId);
    const legacyText = existsSync(legacy) ? readFileSync(legacy, 'utf8') : '';
    const mdText = existsSync(md) ? readFileSync(md, 'utf8') : '';
    if (legacyText.trim().length > 0 && !mdText.trimStart().startsWith(legacyText.trim())) {
      sources.push(legacyText);
    }
    if (mdText.trim().length > 0) sources.push(mdText);
    const parsed = sources.flatMap((text) => parseLegacyMarkdown(text));
    if (parsed.length === 0) return;
    mkdirSync(dirname(path), { recursive: true });
    const lines = parsed.map((entry, index) =>
      JSON.stringify({
        id: `n${index + 1}`,
        ts: entry.ts,
        text: entry.text,
        migrated: true,
      }),
    );
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${lines.join('\n')}\n`);
    renameSync(tmp, path);
    this.logger?.warn?.(`context-manager: migrated ${parsed.length} notes to structured store ${path}`);
  }

  /**
   * Entries present in the markdown but not yet in the store (a pre-v1.4.0
   * process still appending during the transition window), deduped by
   * fingerprint and assigned the ids they would get. Purely derived — the
   * caller decides whether to persist them (append, under the lock) or just
   * view them (read paths perform no writes, so a read can never race a
   * concurrent append into a lost update).
   */
  mdFresh(sessionId, existingEntries) {
    const path = this.path(sessionId);
    const md = this.legacyMdPath(sessionId);
    try {
      if (!existsSync(md) || !existsSync(path) || statSync(md).mtimeMs <= statSync(path).mtimeMs) return [];
      const have = new Set(existingEntries.map((entry) => this.fingerprint(entry)));
      const fresh = parseLegacyMarkdown(readFileSync(md, 'utf8')).filter((entry) => !have.has(this.fingerprint(entry)));
      const highest = existingEntries.reduce((max, entry) => {
        const match = /^n(\d+)$/.exec(entry.id);
        return match === null ? max : Math.max(max, Number(match[1]));
      }, 0);
      return fresh.map((entry, index) => ({
        id: `n${highest + index + 1}`,
        ts: entry.ts,
        text: entry.text,
        tags: [],
        supersedes: [],
        migrated: true,
      }));
    } catch (error) {
      this.logger?.warn?.(`context-manager: markdown merge scan for ${path} failed: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * Parse the store file. A torn final line (crash mid-append) or any corrupt
   * line is skipped with a warning — never silently treated as end of file,
   * because later lines may still be valid.
   */
  loadJsonl(path) {
    const lines = readFileSync(path, 'utf8').split('\n');
    const entries = [];
    let corrupt = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.id !== 'string' || typeof parsed?.text !== 'string') throw new Error('bad entry');
        entries.push({
          id: parsed.id,
          ts: typeof parsed.ts === 'string' ? parsed.ts : '',
          text: parsed.text,
          tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag) => typeof tag === 'string') : [],
          supersedes: normalizeSupersedes(parsed.supersedes),
          ...(Number.isSafeInteger(parsed.sourceSeq) && parsed.sourceSeq >= 0 ? { sourceSeq: parsed.sourceSeq } : {}),
        });
      } catch (error) {
        corrupt += 1;
        this.logger?.warn?.(
          `context-manager: skipped corrupt note line ${index + 1} in ${path}: ${errorMessage(error)}`,
        );
      }
    }
    return { entries, corrupt };
  }

  /**
   * Load all entries (disk + any newer-markdown entries as an in-memory
   * view). When the store is present but EVERY line is corrupt, it is
   * quarantined (never overwritten) and the markdown sources reseed a fresh
   * store — a damaged jsonl can never make the diary look empty while the
   * markdown original still exists.
   */
  entries(sessionId) {
    this.migrate(sessionId);
    const path = this.path(sessionId);
    if (!existsSync(path)) return [];
    let loaded = this.loadJsonl(path);
    if (loaded.entries.length === 0 && loaded.corrupt > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        renameSync(path, `${path}.corrupt-${stamp}`);
        this.logger?.warn?.(
          `context-manager: note store ${path} had no readable line (${loaded.corrupt} corrupt); quarantined as .corrupt-${stamp}, reseeding from markdown if present`,
        );
      } catch (error) {
        this.logger?.warn?.(`context-manager: could not quarantine ${path}: ${errorMessage(error)}`);
        return [];
      }
      this.migrate(sessionId);
      if (!existsSync(path)) return [];
      loaded = this.loadJsonl(path);
    }
    return [...loaded.entries, ...this.mdFresh(sessionId, loaded.entries)];
  }

  /** Persist newer-markdown entries into the store. Callers MUST hold the lock. */
  persistMdFresh(sessionId) {
    const path = this.path(sessionId);
    if (!existsSync(path)) return;
    const loaded = this.loadJsonl(path);
    const fresh = this.mdFresh(sessionId, loaded.entries);
    if (fresh.length === 0) return;
    const lines = fresh.map((entry) =>
      JSON.stringify({ id: entry.id, ts: entry.ts, text: entry.text, migrated: true }),
    );
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${readFileSync(path, 'utf8')}${lines.join('\n')}\n`);
    renameSync(tmp, path);
    this.logger?.warn?.(`context-manager: merged ${fresh.length} newer markdown notes into ${path}`);
  }

  /**
   * Map each superseded id to its ULTIMATE active successor by walking the
   * supersedes chain. Cycles are broken at the first repeat. Returns
   * { superseded: Map<id, ultimateId>, active: Set<id> }.
   */
  chainViews(entries) {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const supersededIds = new Set(entries.flatMap((entry) => entry.supersedes).filter((id) => byId.has(id)));
    const successorsOf = (id) => entries.filter((entry) => entry.supersedes.includes(id)).map((entry) => entry.id);
    const superseded = new Map();
    for (const id of supersededIds) {
      // Walk EVERY successor branch to its active endpoint(s) — a note
      // corrected twice has two ultimate successors and both are reported;
      // first-edge-wins would hide one correction from the audit trail.
      // Cycles break at the first repeat; a fully cyclic branch falls back
      // to the direct successors so the edge is still visible.
      const endpoints = new Set();
      const walk = (current, seen) => {
        for (const next of successorsOf(current)) {
          if (seen.has(next)) continue;
          seen.add(next);
          if (supersededIds.has(next)) walk(next, seen);
          else endpoints.add(next);
        }
      };
      walk(id, new Set([id]));
      superseded.set(id, endpoints.size > 0 ? [...endpoints] : successorsOf(id));
    }
    return { superseded, active: new Set(entries.filter((entry) => !supersededIds.has(entry.id)).map((e) => e.id)) };
  }

  /** Read the diary: load entries from disk, then render the derived view. */
  read(sessionId, opts = {}) {
    return this.renderView(this.entries(sessionId), opts);
  }

  /**
   * Render the derived view over ALREADY-LOADED entries (the store never
   * re-parses to render): active notes in full (chronological), then the
   * superseded folded to one-line audit entries pointing at their ultimate
   * successors. Modes:
   *   - listTags  — enumerate every bucket with its active-note count, so a
   *                 bucket invented weeks ago stays discoverable;
   *   - id        — one note verbatim with its chain status (bypasses the
   *                 budget, the escape hatch for truncated-away notes);
   *   - tag       — one bucket only (folding still applies);
   *   - default   — the injected view. Over budget, whole oldest entries
   *                 drop first (never a mid-entry cut) and the marker lists
   *                 their ids; a single oversized entry still hard-truncates.
   */
  renderView(allEntries, { tag, id, includeSuperseded = false, listTags = false } = {}) {
    if (listTags) {
      const { superseded } = this.chainViews(allEntries);
      const counts = new Map();
      for (const entry of allEntries) {
        if (superseded.has(entry.id)) continue;
        for (const bucket of entry.tags) counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      }
      if (counts.size === 0) return '(no tags yet)';
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([bucket, count]) => `#${bucket} (${count} active)`)
        .join('\n');
    }
    let entries = allEntries;
    if (entries.length === 0) return '';
    const { superseded } = this.chainViews(entries);
    if (typeof id === 'string' && id.trim().length > 0) {
      const entry = entries.find((candidate) => candidate.id === id.trim());
      if (entry === undefined) return '';
      const stamp = entry.ts.length >= 10 ? entry.ts.slice(0, 10) : '';
      const ultimates = superseded.get(entry.id);
      const meta = `${entry.tags.length > 0 ? ` ${entry.tags.map((t) => `#${t}`).join(' ')}` : ''}${entry.sourceSeq !== undefined ? ` seq:${entry.sourceSeq}` : ''}`;
      return (
        `[${entry.id}${stamp ? ` ${stamp}` : ''}${meta}] ${entry.text}` +
        (ultimates !== undefined ? `\n(superseded by ${ultimates.join(', ')} — shown verbatim for audit)` : '')
      );
    }
    if (typeof tag === 'string' && tag.trim().length > 0) {
      const wanted = tag.trim().toLowerCase();
      entries = entries.filter((entry) => entry.tags.includes(wanted));
      if (entries.length === 0) return '';
    }
    const activeBlocks = [];
    const foldedLines = [];
    for (const entry of entries) {
      const ultimates = superseded.get(entry.id);
      if (ultimates !== undefined) {
        const preview = entry.text.replace(/\s+/g, ' ').slice(0, 80);
        const meta = `${entry.tags.length > 0 ? ` ${entry.tags.map((t) => `#${t}`).join(' ')}` : ''}${entry.sourceSeq !== undefined ? ` seq:${entry.sourceSeq}` : ''}`;
        foldedLines.push(
          includeSuperseded
            ? `[${entry.id} → ${ultimates.join(', ')}${meta}] ${entry.text}`
            : `[${entry.id} → ${ultimates.join(', ')}${meta}] ${preview}${entry.text.length > 80 ? '…' : ''}`,
        );
        continue;
      }
      const stamp = entry.ts.length >= 10 ? entry.ts.slice(0, 10) : '';
      const tags = entry.tags.length > 0 ? ` ${entry.tags.map((t) => `#${t}`).join(' ')}` : '';
      const source = entry.sourceSeq !== undefined ? ` seq:${entry.sourceSeq}` : '';
      activeBlocks.push({
        id: entry.id,
        line: `[${entry.id}${stamp ? ` ${stamp}` : ''}${tags}${source}] ${entry.text}`,
      });
    }
    const blocks = activeBlocks.map((block) => ({ id: block.id, line: block.line }));
    if (foldedLines.length > 0) {
      blocks.push({ id: null, line: `— superseded (kept for audit, not authoritative):\n${foldedLines.join('\n')}` });
    }
    // Running-total truncation: one pass, no join recomputation per drop.
    let total = blocks.reduce((sum, block) => sum + block.line.length, 0) + Math.max(0, blocks.length - 1) * 2;
    if (total <= this.maxChars) return blocks.map((block) => block.line).join('\n\n');
    const droppedIds = [];
    let droppedChars = 0;
    while (blocks.length > 1 && total > this.maxChars) {
      const [dropped] = blocks.splice(0, 1);
      total -= dropped.line.length + 2;
      droppedChars += dropped.line.length + 2;
      droppedIds.push(dropped.id);
    }
    const content = blocks.map((block) => block.line).join('\n\n');
    const idList = droppedIds
      .filter((droppedId) => droppedId !== null)
      .slice(0, 12)
      .join(', ');
    const suffix = idList.length > 0 ? ` (${idList}) — fetch any of them verbatim with notes_read({ id })` : '';
    if (content.length <= this.maxChars) {
      return `[${droppedIds.length} older note${droppedIds.length > 1 ? 's' : ''} dropped — ${droppedChars} earlier chars not shown]${suffix}\n${content}`;
    }
    const excess = content.length - this.maxChars;
    return `[older notes truncated — ${droppedChars + excess} earlier chars not shown]${suffix}\n${content.slice(-this.maxChars)}`;
  }

  /**
   * Append one note. Migration runs first and the whole read-modify-write is
   * serialized across processes. supersedes targets must exist — a typo'd id
   * rejects the append (the model sees the reason and retries) rather than
   * recording a dangling edge.
   * @returns {Promise<{accepted: boolean, id?: string, fileChars?: number, viewChars?: number, reason?: string}>}
   */
  async append(sessionId, text, { tags, supersedes, sourceSeq } = {}) {
    const path = this.path(sessionId);
    return await withFileLock(
      path,
      () => {
        this.migrate(sessionId);
        // Persist any newer-markdown entries INSIDE the lock before id
        // assignment — read paths only view them in memory, so this is the
        // single writer and no append can be lost to an unlocked merge.
        this.persistMdFresh(sessionId);
        const existing = this.entries(sessionId);
        const edges = normalizeSupersedes(supersedes);
        for (const id of edges) {
          if (!NOTE_ID_PATTERN.test(id)) {
            return { accepted: false, reason: `bad supersedes id "${id}" — note ids look like n3` };
          }
          if (!existing.some((entry) => entry.id === id)) {
            return {
              accepted: false,
              reason: `supersedes target ${id} does not exist (have ${existing.length} notes)`,
            };
          }
        }
        const rawTags = Array.isArray(tags) ? tags.map((tag) => String(tag).trim()) : [];
        const invalidTags = rawTags.filter((tag) => tag.length > 0 && (/\s/.test(tag) || tag.length > 40));
        if (invalidTags.length > 0) {
          return {
            accepted: false,
            reason: `bad tags ${invalidTags.map((tag) => JSON.stringify(tag)).join(', ')} — tags are short labels without spaces (<= 40 chars)`,
          };
        }
        const cleanTags = normalizeTags(tags);
        if (cleanTags.length > 8) {
          return { accepted: false, reason: `too many tags (${cleanTags.length} distinct) — at most 8 per note` };
        }
        const highest = existing.reduce((max, entry) => {
          const match = /^n(\d+)$/.exec(entry.id);
          return match === null ? max : Math.max(max, Number(match[1]));
        }, 0);
        const id = `n${highest + 1}`;
        const record = {
          id,
          ts: new Date().toISOString(),
          text: String(text ?? '').trim(),
          ...(cleanTags.length > 0 ? { tags: cleanTags } : {}),
          ...(edges.length > 0 ? { supersedes: edges } : {}),
          ...(Number.isSafeInteger(sourceSeq) && sourceSeq >= 0 ? { sourceSeq } : {}),
        };
        if (record.text.length === 0) return { accepted: false, reason: 'empty note — nothing recorded' };
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(record)}\n`);
        // Render the view from the entries already in memory — no re-parse.
        const view = this.renderView([...existing, { ...record, tags: cleanTags, supersedes: edges }], {});
        return { accepted: true, id, fileChars: statSync(path).size, viewChars: view.length };
      },
      { logger: this.logger },
    );
  }
}

/** Register notes_append / notes_read into one agent's scope. */
export function registerNotesTools(agent, store) {
  agent.ctx.tools.register(
    defineTool({
      name: NOTES_APPEND_TOOL,
      description:
        'Append a durable note that survives context resets and compactions; after a /reset your notes are re-injected into your context automatically. Record key decisions and WHY, user constraints, important paths/IDs, and dead ends already ruled out. Notes are structured building blocks: use supersedes to replace earlier notes with a correction (they fold away but stay auditable), tags to file the note into buckets you invent (filter later with notes_read), and sourceSeq to point at the log event the note came from.',
      parameters: {
        text: {
          type: 'string',
          required: true,
          description: 'The durable fact to remember, terse and self-contained.',
        },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional note ids (e.g. ["n3"]) this note replaces. Superseded notes fold out of the injected view but stay auditable — use this instead of leaving contradictory notes around.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional short bucket labels (no spaces, e.g. ["eval", "pcg"]). Reuse buckets you already invented — notes_read({ listTags: true }) lists them; notes_read({ tag }) filters to one bucket.',
        },
        sourceSeq: {
          type: 'number',
          description:
            'Optional seq of the log event this note was distilled from — the provenance pointer for later history_read verification.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accepted: { type: 'boolean', required: true },
            id: { type: 'string' },
            fileChars: { type: 'number' },
            viewChars: { type: 'number' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.accepted
              ? `note recorded as ${value.id} (${value.viewChars} chars in the injected view, ${value.fileChars} on disk)`
              : `note was not recorded: ${value.reason ?? 'unknown reason'}`,
          },
        ],
      },
      execute: async (args) => {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (text.length === 0) return { accepted: false, reason: 'empty text' };
        return await store.append(agent.session.id, text, {
          tags: args.tags,
          supersedes: args.supersedes,
          sourceSeq: args.sourceSeq,
        });
      },
    }),
  );

  agent.ctx.tools.register(
    defineTool({
      name: NOTES_READ_TOOL,
      description:
        'Read your durable notes that persist across context resets and compactions. By default shows active notes plus one-line audit entries for superseded ones; listTags enumerates every bucket you have invented with its active-note count, tag reads one bucket, id fetches one note verbatim (including its chain status — this bypasses the budget, so it is also the way back to notes the truncation marker lists as dropped), includeSuperseded expands folded notes back to full text.',
      parameters: {
        listTags: {
          type: 'boolean',
          description: 'When true, list every tag bucket with its active-note count instead of rendering notes.',
        },
        id: {
          type: 'string',
          description: 'Optional note id (e.g. "n17") — fetch that single note verbatim, even when superseded.',
        },
        tag: {
          type: 'string',
          description: 'Optional bucket filter — only notes carrying this tag.',
        },
        includeSuperseded: {
          type: 'boolean',
          description: 'When true, superseded notes render in full instead of folded one-liners.',
        },
      },
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
      execute: (args) => ({
        notes: store.read(agent.session.id, {
          listTags: args?.listTags === true,
          id: args?.id,
          tag: args?.tag,
          includeSuperseded: args?.includeSuperseded === true,
        }),
      }),
    }),
  );
}

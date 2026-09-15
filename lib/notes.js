import { appendFileSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { withFileLock } from './lock.js';

/**
 * dsh-context-manager — durable notes ("the diary").
 *
 * Notes are the model's own distilled prose: decisions and WHY, user
 * constraints, dead ends. They live in a per-session file (append-only, on
 * disk) and are injected into the /reset checkpoint. Unlike pins they are
 * never rendered into the system prompt — narration does not pay rent.
 * Appends run under a cross-process lockfile (lock.js).
 * @module dsh-context-manager/notes
 */

export const NOTES_APPEND_TOOL = 'notes_append';
export const NOTES_READ_TOOL = 'notes_read';

/** Make a session id safe as a single filename. */
function notesFilename(sessionId) {
  return `${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    return dshHomePath('context-manager', 'notes', notesFilename(sessionId));
  }

  /** Pre-rename location kept for one lazy migration. */
  legacyPath(sessionId) {
    return dshHomePath('context-reset', 'notes', notesFilename(sessionId));
  }

  /**
   * One-way lazy migration from the pre-rename location. Runs BEFORE any read
   * or append, so an append can never create an empty new file first and hide
   * the legacy notes. The copy is exclusive: a file another process just wrote
   * is never clobbered — the legacy text is prepended to it instead.
   */
  migrate(sessionId) {
    const path = this.path(sessionId);
    const legacy = this.legacyPath(sessionId);
    if (!existsSync(legacy)) return;
    mkdirSync(dirname(path), { recursive: true });
    try {
      copyFileSync(legacy, path, constants.COPYFILE_EXCL);
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (error?.code !== 'EEXIST') {
        this.logger?.warn?.(`context-manager: legacy notes copy ${legacy} -> ${path} failed: ${errorMessage(error)}`);
        return;
      }
    }
    try {
      const old = readFileSync(legacy, 'utf8').trim();
      const fresh = readFileSync(path, 'utf8');
      if (old.length === 0 || fresh.trimStart().startsWith(old)) return;
      writeFileSync(path, `${old}\n\n${fresh.trimStart()}`);
    } catch (error) {
      this.logger?.warn?.(`context-manager: legacy notes merge into ${path} failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Read the session's notes, keeping the newest content when over budget:
   * recent notes supersede older ones more often than not. The truncation
   * marker states how much was left out.
   */
  read(sessionId) {
    this.migrate(sessionId);
    const path = this.path(sessionId);
    if (!existsSync(path)) return '';
    const content = readFileSync(path, 'utf8').trim();
    if (content.length <= this.maxChars) return content;
    const dropped = content.length - this.maxChars;
    return `[older notes truncated — ${dropped} earlier chars not shown]\n${content.slice(-this.maxChars)}`;
  }

  /**
   * Append one note. Migration runs first and the whole read-modify-write is
   * serialized across processes, so two Harness processes cannot lose notes.
   */
  async append(sessionId, text) {
    const path = this.path(sessionId);
    return await withFileLock(
      path,
      () => {
        this.migrate(sessionId);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `\n\n<!-- ${new Date().toISOString()} -->\n${text.trim()}\n`);
        return this.read(sessionId).length;
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
      execute: async (args) => {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (text.length === 0) return { accepted: false, totalChars: 0 };
        return { accepted: true, totalChars: await store.append(agent.session.id, text) };
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
      execute: () => ({ notes: store.read(agent.session.id) }),
    }),
  );
}

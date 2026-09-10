# Changelog

## 0.1.0

- Initial release (renamed from the unpublished `dsh-compaction-hardcut`
  prototype, redesigned as an on-demand command):
  - `/reset` slash command next to the official `/compact`: one hard
    context-window reset, user-invoked only. The official summarizing
    compaction stays the default — nothing is disabled or pre-empted, and
    the engine is constructed with `auto: false` on an isolated service
    plane so it never registers a second root `compaction` service.
  - `ContextResetEngine` subclasses the official `BasicCompactionEngine`:
    the durable compaction transaction (tool-pairing balance, checkpoint
    framing, log markers) is reused; `summarize()` is the only overridden
    hook and makes no LLM call. The replacement checkpoint is a fixed reset
    notice carrying the agent's durable notes.
  - Agent tools: `history_search`, `history_read`, `notes_append`,
    `notes_read` — recall survives both `/reset` and official compaction.
  - Cache-stable quantized budget hint section (25/50/75% bands).
  - Notes persisted per session under `~/.dsh/context-reset/notes/`.

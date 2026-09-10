# Changelog

## 0.2.0

- Hybrid checkpoint: `/reset` now asks the LLM for a one-shot sketch of the
  shadowed span (the official cache-friendly summarization call) and embeds
  it in the checkpoint — explicitly labeled UNVERIFIED, with durable notes
  and `history_search` named as authoritative. This bridges continuity when
  the model's notes are sparse, without reintroducing silent-loss trust.
  A failed sketch call degrades to the pure hard cut; the reset still
  completes. New config: `llmSummary` (default `true`; `false` restores the
  zero-LLM pure cut), plus pass-through of `summarizationProvider`,
  `summarizationModel` and `maxTokens` to the official summarizer.

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

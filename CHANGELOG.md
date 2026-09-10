# Changelog

## 1.0.0

- Renamed to **dsh-context-manager**: the plugin grows from "a `/reset`
  command" into a full context-memory subsystem — four memory layers
  (vault / diary / sketch / swap), seven tools, one command.
- New malloc layer (`lib/malloc.js`): `context_alloc` / `context_free` /
  `context_list` pin VERBATIM facts into the last system-prompt section
  (order 10300), surviving every compaction and `/reset` unparaphrased.
  - Two scopes: task pins (`t*`, per session, bulk-freed by `/reset` with
    the count reported in the command result) and workspace pins (`w*`,
    shared across sessions and subagents of the same workspace).
  - Handles are monotonic and never reused; updates are free + alloc.
  - Dual quota gates: per-pin chars and total ≤ min(pinsMaxChars,
    pinsWindowRatio × contextWindow); exhaustion rejects with the oldest
    task pins named as free candidates.
  - Cadence nudge (every `nudgeEvery` non-memory tool calls, attached to
    tool results for minimal KV-cache cost) reminds the model to pin.
- Host split: `lib/history.js` (retrieval tools) and `lib/notes.js`
  (diary store + tools, with lazy migration from the old
  `~/.dsh/context-reset/notes/` path) extracted from `engine.js`.
- New config keys: `pinMaxChars` (4000), `pinsMaxChars` (12000),
  `pinsWindowRatio` (0.05), `nudgeEvery` (6), `suggestCount` (3).
- `test/smoke.mjs` covers the store semantics (30 assertions); CI runs it
  via `pnpm check`. Dev dependencies pinned to the single 0.1.0-rc.8 era
  so the smoke tree resolves from npm alone.

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

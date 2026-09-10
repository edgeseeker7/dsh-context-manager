# Changelog

## 0.1.0

- Initial release: hard context-window reset engine for DeepSeek Harness.
  - `HardcutEngine` subclasses the official `BasicCompactionEngine`: trigger
    policy (pre-step pressure, context-overflow recovery, `/compact`), the
    durable compaction transaction, and tool-pairing balance checks are all
    reused; `summarize()` is the only overridden hook and makes no LLM call.
  - Replacement checkpoint = fixed reset notice + the agent's durable notes.
  - Agent tools: `history_search`, `history_read`, `notes_append`,
    `notes_read`, `new_context` (model-initiated reset at the next step
    boundary).
  - Quantized budget hint section (25/50/75% bands) that only changes at
    crossings, keeping the provider KV cache intact.
  - Notes persisted per session under `~/.dsh/compaction-hardcut/notes/`.

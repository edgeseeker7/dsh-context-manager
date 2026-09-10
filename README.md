# dsh-context-reset

[中文文档](README.zh.md)

An on-demand hard context-window reset for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a **`/reset`** command that sits next to the official `/compact` in the input box. When you type it, earlier turns leave the model's context **without any LLM summary**, the model's own durable notes are re-injected, and full history stays one tool call away.

**The official compaction stays the default.** This plugin never disables or pre-empts it — automatic summarizing compaction and `/compact` behave exactly as before. A hard reset happens only when you explicitly ask for one.

## Why a hard reset, sometimes?

Summarization compaction is silently lossy: "never touch this endpoint" compresses into a vague one-liner, and the model doesn't know what it forgot. A hard reset moves the failure mode from *silently forgetting* to *failing to look something up* — visible and debuggable. It also costs **zero** extra tokens (no summary call), and never compounds: the 5th reset is as faithful as the 1st because the original log is never rewritten.

Use `/compact` when you want continuity by summary. Use `/reset` when the window feels polluted and you'd rather the model rebuild from notes + on-demand retrieval.

## What you get

- **`/reset` command** — same durable transaction as the official compactor (tool-pairing balance, checkpoint framing), but the replacement checkpoint is a fixed reset notice carrying the agent's current notes. No LLM call.
- **`notes_append` / `notes_read`** — the model records durable facts (decisions + why, user constraints, paths/IDs, dead ends). Notes persist per session in `~/.dsh/context-reset/notes/` and are re-injected into the checkpoint after every `/reset`.
- **`history_search` / `history_read`** — keyword search and exact-range reads over the *full* session log, including turns that left the active context. Works after official compaction too — nothing is ever deleted.
- **Budget hints** — a system-prompt section shows ~25% / ~50% / ~75% usage, quantized so the text only changes at band crossings and the provider KV cache survives.

## Install

```sh
dsh plugin --profile web add dsh-context-reset
```

Restart `dsh web` after installing. Then type `/` in the input box — `reset` appears alongside `compact`.

## How a reset reads

The model sees a checkpoint like:

```
CONTEXT WINDOW RESET #1 (/reset, dsh-context-reset) — no summary was produced and no information was deleted.
The earlier conversation (148 replayed messages) left the active context but remains FULLY recorded
in this session's log. When a fact, path, decision or constraint feels missing, retrieve it instead of guessing:
- history_search({ query }) — find prior messages and tool activity by keyword
- history_read({ fromSeq, toSeq }) — read an exact event range

Durable notes (persisted across resets, newest last):
…
```

…plus the untouched system prompt and the conversation tail the official manual-compaction selection keeps.

Fail-safe edge: if the only cuttable span is already smaller than the checkpoint itself, the official transaction guard skips the reset and the conversation continues unchanged — the skip is recorded as a `compaction/end` error in the session log.

## Config

Optional, on the profile row (`~/.dsh/profiles/<profile>/cordis.yml`):

| key | default | meaning |
| --- | --- | --- |
| `budgetHints` | `true` | show the 25/50/75% budget section |
| `notesMaxChars` | `8000` | notes budget re-injected after a reset (newest kept) |
| `historyMaxChars` | `8000` | per-call output cap for `history_read` |

## Compatibility

Requires dsh ≥ 0.1.2-rc.1 (developed and verified on 0.1.5-rc.1). The engine subclasses the official `BasicCompactionEngine` with `auto: false`; if a future dsh changes that class's `summarize()` hook or the manual-compaction path, this plugin needs a matching update.

## License

[MIT](LICENSE)

# dsh-compaction-hardcut

[中文文档](README.zh.md)

Hard context-window reset for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the Codex `new_context` idea as a plugin: when the window fills up, earlier turns leave the model's context **without any LLM summary**, the model's own durable notes are re-injected, and full history stays one tool call away.

## Why not summarize?

Summarization compaction (the stock `dsh-compaction-basic` behavior) has two fixed costs:

- **It is silently lossy.** "Never touch this endpoint", "option A was rejected because…" — these compress into vague one-liners, and the model doesn't know what it forgot. It answers confidently anyway.
- **It bills a model call every time**, repeatedly in long sessions.

Hardcut moves the failure mode from *silently forgetting* to *failing to look something up* — which is visible in the transcript and debuggable. Each reset costs **zero** extra tokens, and the 5th reset is exactly as faithful as the 1st (no summary-of-summary decay), because the original log is never rewritten.

## What you get

- **Hard reset engine** — same triggers as stock (step pressure, context-overflow recovery, `/compact`), same durable transaction, but `summarize()` makes no LLM call. The replacement checkpoint is a fixed reset notice carrying the agent's current notes.
- **`notes_append` / `notes_read`** — the model records durable facts (decisions + why, user constraints, paths/IDs, dead ends). Notes persist per session in `~/.dsh/compaction-hardcut/notes/` and are re-injected into the checkpoint automatically after every reset.
- **`history_search` / `history_read`** — keyword search and exact-range reads over the *full* session log, including turns that left the active context. Nothing is ever deleted.
- **`new_context`** — the model can request a reset early, on its own terms, at the next step boundary (executed where tool-call pairing is balanced).
- **Budget hints** — a system-prompt section shows ~25% / ~50% / ~75% usage. It is quantized so the text only changes at band crossings and the provider KV cache survives.

## Install

```sh
dsh plugin --profile web add dsh-compaction-hardcut
```

Restart `dsh web` after installing.

The plugin's patch does two things: it disables the stock **root** engine (`compaction-basic` from `dsh-base`) and mounts `HardcutEngine` at root with `thresholdRatio: 0.75`. Agent presets (standard/cordis/ptc) keep their own isolated stock engine at 0.8, but hardcut commits first at 0.75, so in practice every automatic compaction is a hard cut. If a single giant step jumps from below 0.75 straight past 0.8, the preset engine may still run one classic summary — harmless, just lossy that once.

## Config

Set in the profile row (`~/.dsh/profiles/<profile>/cordis.yml`):

| key | default | meaning |
| --- | --- | --- |
| `thresholdRatio` | `0.75` | pressure threshold (fraction of the model's context window) |
| `retainRatio` | `0.16` | verbatim recent tail kept after each cut |
| `retainTokens` | — | absolute tail budget; overrides `retainRatio` |
| `budgetHints` | `true` | show the 25/50/75% budget section |
| `notesMaxChars` | `8000` | notes budget re-injected after a reset (newest kept) |
| `historyMaxChars` | `8000` | per-call output cap for `history_read` |
| `auto` | `true` | automatic pressure/overflow compaction |

## How a reset reads

The model sees a checkpoint like:

```
CONTEXT WINDOW RESET #2 (dsh-compaction-hardcut) — no summary was produced and no information was deleted.
The earlier conversation (148 replayed messages) left the active context but remains FULLY recorded
in this session's log. When a fact, path, decision or constraint feels missing, retrieve it instead of guessing:
- history_search({ query }) — find prior messages and tool activity by keyword
- history_read({ fromSeq, toSeq }) — read an exact event range

Durable notes (persisted across resets, newest last):
…
```

…plus the untouched system prompt and the most recent ~16% of the conversation verbatim.

Fail-safe edge: if the only cuttable span is already smaller than the checkpoint itself (possible near the end of a session with a large retained tail), the official transaction guard skips that cut and the turn continues unchanged — the skip is recorded as a `compaction/end` error in the session log.

## Compatibility

Requires dsh ≥ 0.1.2-rc.1 (developed and verified on 0.1.5-rc.1). The engine subclasses the official `BasicCompactionEngine`; if a future dsh changes that class's `summarize()` hook signature, this plugin needs a matching update.

## License

[MIT](LICENSE)

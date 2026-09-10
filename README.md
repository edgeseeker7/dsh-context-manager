# dsh-context-manager

Explicit context-memory subsystem for DeepSeek Harness. One plugin, four memory layers, seven tools, one command.

[中文文档](README.zh.md)

## The problem

When the context window fills up, the official compaction replaces old history with an LLM summary. That summary is the **only** bridge — it is silently lossy ("forgotten but confident"), errors compound across compactions, and nothing verbatim is guaranteed to survive.

## The model: four memory layers

```
① vault   pins: VERBATIM facts in the last system-prompt section.
           Survive every compaction and /reset, never paraphrased.
② diary   notes: the model's distilled prose, in a session file.
           Re-injected into the /reset checkpoint.
③ sketch  the /reset checkpoint: LLM summary labeled UNVERIFIED
           + notes + retrieval instructions.
④ swap    the full session log. Nothing is ever deleted;
           history_search / history_read page anything back in.
```

Reclamation policies: **pin = mlock, official compact = summarizing GC, /reset = bulk free** of the heap (and of task pins).

## Tools (installed into every agent, subagents included)

| Tool | Semantics |
|------|-----------|
| `context_alloc(text, label, scope)` | Pin a verbatim fact, returns a handle (`t*`/`w*`). `scope: "task"` (default) dies with `/reset`; `"permanent"` persists across sessions of this workspace. |
| `context_free(handle)` | Release a pin. Handles are monotonic, never reused — a freed handle dangles, it can never point at new content. |
| `context_list()` | Allocation table: every pin with handle/label/size/age, plus quota usage. |
| `notes_append(text)` / `notes_read()` | Durable diary (append-only). |
| `history_search(query)` / `history_read(fromSeq, toSeq)` | Full-log retrieval, shadowed events included. |

A cadence nudge (every 6 non-memory tool calls, riding tool results so it costs almost no KV cache) reminds the model to pin — the same pattern that made `notify_user` reporting reliable in dsh-subagent-progress.

## `/reset`

Sits next to `/compact` in the input box. Replaces resettable history with the hybrid checkpoint (sketch labeled UNVERIFIED + notes + retrieval instructions), bulk-frees task pins, and reports how many were freed. The official automatic compaction is **not** touched — it stays the default.

## Quotas (dual gate)

Pins pay rent on every request (they live in the system prompt), so the vault is bounded twice:

- per pin: ≤ `pinMaxChars` (default 4000)
- total: ≤ min(`pinsMaxChars` (default 12000), `pinsWindowRatio` (default 5%) × contextWindow × 3 chars/token)

Quota exhaustion rejects the alloc and names the oldest task pins as free candidates — honest failure with a handrail, never silent eviction.

## Configuration

| Key | Default | Meaning |
|-----|---------|---------|
| `budgetHints` | `true` | Quantized 25/50/75% budget section (cache-stable). |
| `llmSummary` | `true` | `/reset` runs one cache-friendly LLM sketch; `false` = pure hard cut. |
| `notesMaxChars` | `8000` | Notes read budget (oldest truncated). |
| `historyMaxChars` | `8000` | Per-`history_read` output cap. |
| `pinMaxChars` | `4000` | Per-pin verbatim cap. |
| `pinsMaxChars` | `12000` | Total pin cap across both scopes. |
| `pinsWindowRatio` | `0.05` | Share of the context window pins may occupy. |
| `nudgeEvery` | `6` | Tool calls between pin reminders. |
| `suggestCount` | `3` | Oldest task pins named on quota rejection. |
| `summarizationProvider` / `summarizationModel` / `maxTokens` | — | Optional sketch-call routing, passed through to the official summarizer. |

## Storage

- Task pins: `~/.dsh/context-manager/pins/<sessionId>.json`
- Workspace pins: `~/.dsh/context-manager/pins/ws/<workspace-slug>.json` (shared by all sessions and subagents of the workspace)
- Notes: `~/.dsh/context-manager/notes/<sessionId>.md` (legacy `~/.dsh/context-reset/notes/` migrates lazily)

## Design notes

- **Why pins live in the system prompt**: it is the only layer re-assembled on every request — the only place that survives *any* history replacement. The pin section renders last (order 10300, after the official persona suffix) so pin edits invalidate the least KV cache.
- **Why free + alloc instead of an update tool**: three tools beat four; a changed handle that dangles is explainable, a reused handle is a wrong pointer.
- **Why the model manages pins itself**: user pinning breaks flow, engine heuristics misfire; the discipline risk is covered by the cadence nudge + quantized budget hints.
- Supersedes `dsh-context-reset` (same engine, same `/reset`; adds the malloc layer).

## License

MIT

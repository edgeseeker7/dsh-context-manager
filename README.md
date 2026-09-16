# dsh-context-manager

Explicit context-memory subsystem for DeepSeek Harness. One plugin, four memory layers, seven tools, one command.

[中文文档](README.zh.md)

## The problem

When the context window fills up, the official compaction replaces old history with an LLM summary. That summary is the **only** bridge — it is silently lossy ("forgotten but confident"), errors compound across compactions, and nothing verbatim is guaranteed to survive.

## The model: four memory layers

```
① vault   pins: VERBATIM facts in the last system-prompt section.
           Survive every compaction, never paraphrased; w* workspace pins
           also survive /reset, while t* task pins are cleared by it.
② diary   notes: the model's distilled prose, in a session file.
           Re-injected into the /reset checkpoint.
③ sketch  the /reset checkpoint: a deterministic mechanical section
           (pins cleared/active, last user message, frequent ids/paths/urls)
           + LLM summary labeled UNVERIFIED + notes + retrieval instructions.
④ swap    the full session log. Nothing is ever deleted;
           history_search / history_read page anything back in.
```

Reclamation policies: **pin = mlock, official compact = summarizing GC, /reset = bulk free** of the heap (and of task pins).

## Tools (installed into every agent, subagents included)

| Tool | Semantics |
|------|-----------|
| `context_alloc(text, label, scope[, sourceSeq])` | Pin a verbatim fact, returns a handle (`t*`/`w*`). `scope: "task"` (default) dies with `/reset`; `"permanent"` persists across sessions of this workspace. `sourceSeq` records the log event the fact came from (shown by `context_list`, never in the vault text). |
| `context_free(handle)` | Release a pin. Handles are monotonic — a freed handle dangles; only a corrupt, quarantined store can restart the counter (and it says so). |
| `context_list()` | Allocation table: every pin with handle/label/billed size/age, plus quota usage. |
| `notes_append(text[, supersedes, tags, sourceSeq])` | Durable diary, append-only JSONL with stable note ids (`n7`). The three optional edges are the model's structure-building primitives: `supersedes` folds replaced notes into one-line audit entries (version chains), `tags` files notes into self-invented buckets, `sourceSeq` points at the source log event. |
| `notes_read([id, tag, includeSuperseded])` | Read the diary: active notes plus folded superseded one-liners by default; fetch one note verbatim with `id`, filter to one bucket with `tag`, expand folded notes with `includeSuperseded`. |
| `history_search(query[, limit, beforeSeq])` | Hybrid full-log search, shadowed events included: exact phrase → all-terms → some-terms tiers, density-ranked, own memory-tool traffic excluded (`includeSelf` opts back in). Matches carry a char `offset` into the hit. |
| `history_read(fromSeq, toSeq[, offset])` | Exact range read; a read cut inside an oversized event continues with the `offset` its truncation marker reports. |

A cadence nudge (every 20 non-memory tool calls, riding tool results so the prompt prefix stays cacheable) reminds the model to pin verbatim-critical facts and note distilled progress — the same pattern that made `notify_user` reporting reliable in dsh-subagent-progress.

## `/reset`

Sits next to `/compact` in the input box. Replaces resettable history with the hybrid checkpoint (sketch labeled UNVERIFIED + notes + retrieval instructions), frees this session's task pins, and reports exactly what the cleanup achieved — a cleanup that failed is stated (and warned about), never claimed. The official automatic compaction is **not** touched — it stays the default.

### Inspectable checkpoints (web UI)

The stock chat UI only makes `/compact` expandable (its renderer gates on the command name). This plugin ships a small client bundle that registers its own conversation Definition + node renderer through the official multi-claim projection and `conversation.chat.node` slot seams: after a `/reset`, an expandable **"Context window reset"** row appears under the command outcome — click it to read the full injected checkpoint, rendered as markdown. No host code is patched.

## Quotas (window-derived, dual gate)

Pins pay rent on every request (they live in the system prompt), so the vault is bounded from the model the calling agent is actually routed to — each agent (subagents included) resolves its own model:

- total: `pinsWindowRatio` (default 5%) × that model's declared `contextWindow` × 3 chars/token
- per pin: the same total (one pin cannot exceed the vault budget), and the label is capped at 200 chars
- billed usage is the rendered pin: verbatim text + label + handle row

`pinsMaxChars` (default 12000) and `pinMaxChars` (default 4000) are **fallback** caps used only when the context window cannot be resolved. There is no absolute floor, so switching to a small-window model really does shrink the vault.

Quota exhaustion rejects the alloc and names the oldest task pins as free candidates — honest failure with a handrail, never silent eviction.

## Configuration

| Key | Default | Meaning |
|-----|---------|---------|
| `budgetHints` | `true` | Quantized 25/50/75% budget section (cache-stable). |
| `llmSummary` | `true` | `/reset` runs one cache-friendly LLM sketch; `false` = pure hard cut. |
| `notesMaxChars` | `8000` | Notes read budget (oldest truncated; the marker states how much was dropped). |
| `historyMaxChars` | `8000` | Per-`history_read` page cap (oversized events continue via `offset`). |
| `pinMaxChars` | `4000` | Per-pin cap — **fallback** for an unresolved context window. |
| `pinsMaxChars` | `12000` | Total pin cap across both scopes — **fallback** for an unresolved context window. |
| `pinsWindowRatio` | `0.05` | Share of the routed model's context window pins may occupy (the live gate). |
| `nudgeEvery` | `20` | Tool calls between memory reminders. |
| `suggestCount` | `3` | Oldest task pins named on quota rejection. |
| `summarizationProvider` / `summarizationModel` / `maxTokens` | — | Optional sketch-call routing, passed through to the official summarizer. |

## Storage

- Task pins: `~/.dsh/context-manager/pins/<sessionId>.json`
- Workspace pins: `~/.dsh/context-manager/pins/ws/<workspace-hash>.json` — sha256 of the normalized cwd (16 hex chars), shared by all sessions and subagents of that workspace; v1.1.0 slug-named files migrate on first touch
- Notes: `~/.dsh/context-manager/notes/<sessionId>.jsonl` (v1.4.0+) — one structured note per line. The v1 markdown diary and the legacy `~/.dsh/context-reset/notes/` copy lazily migrate to numbered entries on first touch (merged, never clobbered); the originals are left untouched
- Every pin/notes mutation runs under a `node:fs`-only O_EXCL lockfile (stale-lock reclaim + bounded retries), so two Harness processes cannot interleave a read-modify-write. No npm runtime dependency is added.
- A corrupt pin store is renamed to `<file>.corrupt-<timestamp>` with a warning and restarted empty; the handle counter is salvaged from the raw text when possible.

## Design notes

- **Why pins live in the system prompt**: it is the only layer re-assembled on every request — the only place no history replacement can shadow. (Pins leave only when explicitly freed, or when `/reset` clears the `t*` task scope.) The pin section renders last (order 10300, after the official persona suffix) so pin edits invalidate the least KV cache.
- **Why free + alloc instead of an update tool**: three tools beat four; a changed handle that dangles is explainable, a reused handle is a wrong pointer.
- **Why the model manages pins itself**: user pinning breaks flow, engine heuristics misfire; the discipline risk is covered by the cadence nudge + quantized budget hints.
- **Why edges instead of structures**: the plugin's job is storage, not taxonomy. `supersedes`/`tags`/`sourceSeq` are three edge types — chains, buckets, back-pointers — from which the model assembles whatever structure the task needs; a hard-coded structure would freeze one taxonomy in place. The same argument put the deterministic mechanical section ahead of the LLM sketch in the `/reset` checkpoint: exact strings (ids, paths, urls) survive verbatim even when the sketch paraphrases.
- Supersedes `dsh-context-reset` (same engine, same `/reset`; adds the malloc layer).

## Compatibility

Official dsh plugins declare their version contract as `peerDependencies` on the `@deepseek-ai/*` core packages they touch (e.g. `dsh-compaction-basic` peers on eight core packages); this plugin follows the same convention. All core packages ship in lockstep release trains (0.1.x-rc), so one range covers the whole host.

**Supported: dsh ≥ 0.1.6-alpha.1, < 0.2.0.** Runtime resolution decides what this means in practice: a link-installed plugin resolves its `@deepseek-ai/*` imports from its **own** `node_modules`, not from the host installation — so the local copies must carry the API surface of the platform actually running. `devDependencies` therefore track the platform version in use (currently 0.1.6-alpha.1; `dsh-code-runtime` does not ship every train and stays at its latest published, 0.1.5-rc.2). Hand-made symlinks into the host's npx cache are not a substitute — they dangle as soon as the cache changes.

### Platform upgrades

When the host dsh version changes, re-align this plugin before first boot:

1. Point every `@deepseek-ai/*` entry in `devDependencies` at the new platform version (verify each exists on npm; a package that skipped the train keeps its latest published version). Keep `peerDependencies` floors on the same boundary.
2. `pnpm install`
3. `pnpm run check` — the smoke suite must stay green.
4. Boot smoke: `npx -y @deepseek-ai/dsh@<version> web` must load the plugin tree without errors.

The original floor analysis comes from the exact API surface this plugin uses, checked against the published tarballs of every core release:

| API surface we use | Package | Introduced |
|---|---|---|
| `SessionSeq` + `session.eventAt()` (history tools, reset counter) | `@deepseek-ai/dsh-session` | **0.1.2-rc.1** (absent in 0.1.0-rc.8 and 0.1.1-rc.2) |
| `BasicCompactionEngine` + the `summarize()` override hook | `@deepseek-ai/dsh-compaction-basic` | ≤ 0.1.0-rc.8 |
| `ManualCompactionError` | `@deepseek-ai/dsh-compaction` | ≤ 0.1.0-rc.8 |
| `defineTool` (tool registration with output schemas) | `@deepseek-ai/dsh-tools` | ≤ 0.1.0-rc.8 |
| `dshHomePath` | `@deepseek-ai/dsh-home-paths` | ≤ 0.1.0-rc.8 |
| Services `commands` / `llm` / `tokenMeter` / `sessions`, event `agent/created` | `@deepseek-ai/dsh-commands` etc. | ≤ 0.1.0-rc.8 |

The historical binding constraint was `SessionSeq` (introduced in 0.1.2-rc.1); the declared floor has since moved forward with the runtime-alignment strategy above.

One nuance on the declared ranges: npm semver cannot express "any prerelease train from X onward" — under the same-tuple prerelease rule, `>=0.1.6-alpha.1 <0.2.0` strictly resolves only the 0.1.2-rc.* line, while official plugins pin a single train (`^0.1.5-rc.1`) and redeclare every release. In practice pnpm checks peers leniently against an already-installed host (0.1.5-rc.1 satisfies these ranges at install time), so the ranges work as documented floors; this section is the authoritative statement of intent.

## License

MIT

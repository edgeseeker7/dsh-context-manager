# Changelog

## 1.4.2

Correctness hotfixes from the three-agent audit (memory/GC, free mechanism,
structure usability):

- **Markdown merge no longer races appends**: read paths now only VIEW
  newer-markdown entries in memory; the merge is persisted exclusively by
  `append`, inside the file lock, before id assignment — the unlocked
  read-modify-write that could lose a concurrent append is gone. Store
  seeding also writes atomically (tmp + rename).
- **Multiple successors are all reported**: a note corrected twice renders
  `[n1 → n2, n3]` in the folded audit line and `superseded by n2, n3` in
  the by-id read — first-edge-wins no longer hides one correction from the
  audit trail. Cycle fallbacks keep the edge visible.
- **Folded and by-id rows keep their metadata**: tags and sourceSeq render
  on folded one-liners and by-id fetches, so rewriting a note (the retag
  path) no longer loses its buckets and provenance.
- **Tags fail honestly**: tags containing spaces or over 40 chars, and more
  than 8 distinct tags, now REJECT the append with the offenders named —
  no more silent drops.
- `clearTask` on a corrupt store reports the quarantine instead of "No task
  pins were pinned"; the /reset outcome names the quarantine file.
- Corrupt-store counter salvage now raises over the highest handle still
  visible in the raw bytes, so a counter clipped mid-digits can never
  re-issue a live handle; a failed quarantine rename warns once per file
  per process instead of on every request.
- `context_alloc` / `context_free` wrap lock-contention and IO failures
  into `{accepted: false, reason}` instead of throwing raw tool errors.
- The checkpoint's pin line is tense-honest: "about to clear … the /reset
  outcome line reports the actual cleanup" (the section is composed before
  the cleanup runs).
- Tests: multi-successor / metadata / tag-validation / merge-persistence /
  quarantine-reporting / clipped-counter / warn-once coverage (203 total
  across 6 suites).

## 1.4.1

- **Markdown degradation paths completed**: a store whose EVERY line is
  corrupt is quarantined (bytes kept, warning names the quarantine file)
  and reseeded from the markdown original — a damaged jsonl can no longer
  make the diary look empty while the markdown sits next to it. And a
  markdown NEWER than the store (a pre-v1.4.0 process still appending
  during the transition window) merges its new entries into the store,
  deduped by timestamp+text fingerprint so repeated merges are idempotent;
  the atomic rewrite then passes the markdown's mtime, stopping further
  merges until the markdown grows again.
- **Truncation respects entry boundaries**: an over-budget notes view drops
  whole oldest entries (`[2 older notes dropped — N earlier chars not
  shown]`) before ever cutting mid-entry; only a single oversized entry
  still hard-truncates.
- `notes_read({ id })` fetches one note verbatim, including its chain
  status (`superseded by n4`) when folded.
- Tests: `test/notes.mjs` gains the degradation/merge/boundary/by-id suite
  (186 total across 6 suites).

## 1.4.0

Design review verdict: the four-layer model had storage but no structure —
pins and notes were isolated free-text islands, and the data structures in
the design docs (version chains, buckets, provenance) were interpretations,
not mechanisms. This release writes them into the stores:

- **Structured notes (JSONL)**: one note per line with a stable id (`n7`),
  timestamp, and three optional edge types the model uses to build its own
  structures on top of the flat log — the plugin stores edges, the model
  invents the graph:
  - `supersedes` — version chains. A correction names the notes it
    replaces; superseded notes fold into one-line audit entries pointing at
    their ultimate active successor (`[n2 → n4]`), so stale conclusions
    stop being injected while staying recoverable
    (`notes_read({ includeSuperseded: true })`). Dangling or malformed
    targets reject the append with the reason named.
  - `tags` — hash buckets. Free-form short labels (normalized, ≤8 per
    note); `notes_read({ tag })` reads one bucket. The taxonomy is the
    model's to invent.
  - `sourceSeq` — provenance. A note (and now a pin, via `context_alloc`)
    can point at the log event it was distilled from, rendered as a
    `seq:179` pointer for later `history_read` verification. Pin provenance
    shows in `context_list`, never in the verbatim vault text.
- **v1 diary migration**: the old markdown diary lazily converts to
  numbered JSONL entries on first touch (leading-marker and hand-written
  preludes handled; legacy `context-reset` files merge without
  duplication); the original markdown is left untouched.
- **Mechanical checkpoint section (B2)**: the `/reset` checkpoint gains a
  deterministic, no-LLM section ahead of the sketch — the t* pins this
  reset clears (an index of what was deliberately kept, so it can be
  re-derived), the w* pins still active, the last real user message, and
  the most frequent ids/paths/urls in the shadowed span (`extractAnchors`,
  pure). Direct fix for the trace-proven failure where the LLM sketch
  omitted a method name and the agent hallucinated after the reset: exact
  strings now survive verbatim even when the sketch paraphrases. Every
  extractor is independently guarded — a failure degrades one line, never
  the reset.
- **Search robustness (C5/C6)**: `history_search` candidates no longer hold
  every matching event's full text through the sort — only ranking fields;
  snippets re-read the few winners (a broad query on a large log can no
  longer pin hundreds of MB). `scanned` now reports the events actually
  scanned instead of the session length.
- Protocol text and the cadence nudge teach the new edges (supersede stale
  notes instead of contradicting them).
- Tests: new suites `test/notes.mjs` (28) and `test/engine.mjs` (10);
  `test/history.mjs` gains the scanned-count assertions (173 total across
  6 suites).

## 1.3.0

- `history_search` rewritten as hybrid matching after trace analysis of the
  Probing-Bench-v1 eval showed the old literal full-string `indexOf` missed
  every natural multi-term query, and newest-first-with-cap let the current
  turn (probe text + the agent's own search calls) flood the result budget:
  - Three tiers: exact phrase (tier 0) → all whitespace-separated terms in
    the event (tier 1) → some terms (tier 2, only when no tier-0/1 hit
    exists). Within a tier: hit count, then density (shorter events), then
    recency — the same ranking shape as the official SQLite FTS5 session
    query (match_count / document_length / time).
  - The agent's own memory-tool calls and results (history/pins/notes) are
    excluded from the corpus by default; `includeSelf: true` opts back in.
  - New `beforeSeq` parameter bounds the scan below a known seq (e.g. the
    current turn), and every match reports the char `offset` of its anchor
    hit so `history_read` can continue from the exact spot.
  - `tool-result` blocks are unwrapped before indexing: search text and
    snippets show the tool's actual output, not the JSON envelope.
  - A/B on the real eval session: the query containing the literal answer
    that previously surfaced "only the current turn" now returns the
    fact-holding events directly.
- Tests: `test/history.mjs` gains the hybrid-matching suite (14
  assertions, 132 total across 4 suites).

## 1.2.0


- Pin scopes renamed in the system prompt and reset flow: task pins are now
  `t*` (cleared by `/reset`, with the cleanup count stated in the reset
  text) and permanent pins are `w*` (survive `/reset`, shared across this
  workspace's sessions).
- Quota is derived from the context window of the model the agent is
  actually routed to: the engine resolves the routed provider/model from
  the session request header (falling back to agent options) and computes
  the pins budget per resolved target, so a model switch can no longer
  strand pins above the new model's budget.
- `nudgeEvery` default raised 6 → 20; the nudge text now names both memory
  actions (pin verbatim facts with `context_alloc`, record progress with
  `notes_append`) instead of only pushing pins.
- New `lib/lock.js`: cross-process mutex for the on-disk pin and notes
  stores. Two Harness processes (or Harness plus a headless script) that
  write the same store used to lose the slower writer's update silently;
  the stores now serialize on an O_EXCL lockfile with stale-lock reclaim.
- `history_read` accepts an `offset` char cursor for continuing a read
  that was cut inside one oversized event; the truncation footer spells
  out the remaining chars and the exact next call. Empty queries in
  `history_search` short-circuit instead of scanning.
- Store layer hardening in `malloc.js`/`notes.js`: monotonic handle
  validation, defensive reload on external change, and clearer rejection
  messages naming the pins to free.
- Tests: 4 suites (`smoke`, `history`, `command`, `client-definition`),
  all green via `pnpm check`.

## 1.1.0

- Web chat renders `/reset` checkpoints as expandable items (parity with
  `/compact`): the context-manager client package registers a reset-aware
  conversation definition plus a slot renderer, so the full checkpoint is
  inspectable in the chat timeline instead of a one-line marker.

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

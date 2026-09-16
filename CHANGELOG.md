# Changelog

## 1.6.2

- **Whole-chain tree view**: `notes_read({ chain: "n7" })` renders the
  entire version chain around a note as an indented tree — roots down to
  every active successor branch, each node with date, preview, and status
  (ultimate successors named), the queried note marked with ←. Capped at
  30 nodes with an explicit remainder count; cycles break visibly. The
  chain stops being a by-id fragment and becomes an object the model can
  see whole — branches (multi-successor corrections) become manageable
  instead of surprising.
- Tests: tree shape / branch indentation / status / unknown id (242 total
  across 6 suites).

## 1.6.1

Cross-session discoverability (observed failure: a brand-new conversation
asked "what have you been up to", got `(no notes yet)`, and had no tool
path to the old session's diary — notes are per-session BY DESIGN, but the
design had no discovery layer):

- `notes_read({ listSessions: true })` lists every session diary in the
  workspace (session id, note count, size, last write, newest first).
- `notes_read({ session: "<id>" })` reads another session's diary with the
  same rendering/folding/budget logic — cross-session reads NEVER write to
  the target store (migration seeding still runs; appends stay local).
- **Encounter-time signpost**: an empty-diary `notes_read` in a workspace
  that HAS older diaries now answers with a fork in the road instead of a
  dead end: "no notes yet in THIS session — but N other sessions have
  diaries; newest: session-…, 48 notes; listSessions to see them".
- **Structure mirror in the reset checkpoint**: the mechanical section
  gains a one-line derived report of the agent's own memory shape (N active
  / M superseded notes, buckets with counts) — self-observation is what
  turns grown structures into tended structures.
- RULES_TEXT and the notes_read description document the per-session scope
  and the cross-session path.
- Tests: sessionsIndex / listSessions / cross-session reads / store
  isolation (235 total across 6 suites).

## 1.6.0

Trace-driven capabilities — every item here is grounded in the three-agent
analysis of the Probing-Bench (100-question, 5-arm) and gate (108-question)
eval traces:

- **Current-turn self-shadowing fixed (the eval's hardest plugin-level
  evidence)**: `history_search` now excludes the in-flight turn's events by
  default — they are already in the caller's context, and their
  query-echoing text was flooding the best-tier pool, pushing deep-history
  hits out (the `beforeSeq` escape hatch existed but went used 0/310 times).
  `includeCurrentTurn: true` opts back in; an explicit `beforeSeq` disables
  the filter (the caller bounded the scan on their own terms). The
  exclusion count is reported, and the render line now shows tier + pool
  depth (`tier 1: showing 10 of 23 best-tier matches`).
- **Checkpoint/summary events are marked everywhere**: search matches carry
  `checkpoint: true` with a render flag, and history_read's event headers
  show `[checkpoint/summary — compressed, verify against raw events]` — a
  log-embedded summary can no longer pass as primary evidence (one eval
  failure was exactly this).
- **Retrieval protocol in the reset checkpoint (both trace agents
  converged)**: never answer about prior work without searching (the sketch
  is a map, never an answer source); take query entities verbatim from the
  question, not the sketch; split multi-part questions and evidence each
  part (never refuse/bluff the whole); constraints — search negations and
  amendments, the LATEST user instruction wins, quote the sentence
  verbatim; compressed content is a pointer, not evidence.
- **User constraints + recent instructions VERBATIM in the mechanical
  checkpoint section**: `extractConstraints` pulls constraint-shaped
  sentences (negations, mandates, scope limits, zh+en) out of the shadowed
  span's user messages with their seqs, and the last 5 user instructions
  are kept verbatim — paraphrased constraints were getting inverted ("不要
  X" → answered as X) or scope-expanded ("only X" → X+Y) by the answer
  layer after a reset.
- **Symmetric memory semantics (gate-eval finding)**: RULES_TEXT and
  context_alloc now state that pinning is NOT the default and most content
  is ephemeral, plus a task-neutral clause — the memory protocol does not
  change task-specific judgment criteria (the static keep-leaning injection
  was the only real difference behind the plugin arm's neg-recall dip;
  nudge and tool-call paths were falsified).
- Tests: turn-exclusion / poolSize / checkpoint marks / constraint
  extraction (229 total across 6 suites).

## 1.5.0

Performance + discoverability, from the three-agent audit's high findings:

- **Notes performance (the O(N²) audit finding)**: `append` now renders the
  post-write view from the entries already in memory — no second disk read,
  no second parse; `fileChars` comes from `statSync` instead of a third
  full-file read; view truncation runs on a running total instead of
  re-joining the block list per dropped entry.
- **Vault render-time gate (two audit agents converged here)**: `render`
  takes a cap evaluated with the READER's window quota (lazily resolved and
  cached per route, falling back to the config cap until it lands). Alloc
  is only a write-time admission gate — a workspace vault filled by a
  big-window session could otherwise inject several times a small-window
  session's quota into every request. Overflowing pins are omitted LOUDLY:
  a `[vault overflow: N pins omitted (t2, w7) …]` line naming the handles,
  never a silent truncation; they stay allocated and visible in
  context_list.
- **history_search no longer blocks the event loop**: the scan core is now
  a generator yielding every 2000 events; the registered tool drives it
  asynchronously (`setImmediate` between chunks), so a seconds-long wide
  scan keeps the GUI and sibling agents responsive. The sync
  `historySearch` export is unchanged for tests and scripts.
- **mechanicalState streams anchors**: per-event extraction via
  `createAnchorExtractor` with no accumulated corpus — a sliced string
  keeps its parent text alive, so the old `corpus +=` rope pinned every
  event text in the 200-event window until the reset returned.
- **Discoverability**: `notes_read({ listTags: true })` enumerates every
  bucket with its active-note count (bucket names can no longer be lost
  when old notes truncate away); the truncation marker now LISTS the
  dropped note ids and teaches the `notes_read({ id })` escape hatch.
- **Copy closes the loops**: RULES_TEXT and the cadence nudge teach
  listTags / bucket reuse / sourceSeq citing; `history_read`'s description
  now says a `seq: N` pointer reads directly with `fromSeq = toSeq = N`.
- **Hygiene**: lock stale threshold 10s → 60s (a slow notes critical
  section must never be reclaimed mid-write); startup sweep removes
  crash-abandoned `*.tmp` write stubs older than a day (live stores and
  quarantine files are never touched).
- Tests: listTags / dropped-ids marker / render cap / async-search
  equivalence across yield chunks (215 total across 6 suites).

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

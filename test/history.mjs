/* dsh-context-manager history tools: pure event fixtures, no harness needed.
 * Covers requirement 4 — full-text search, event-internal paging, explicit
 * truncation markers — plus the seq/arg edge cases the review flagged. */
import { eventText, historyRead, historySearch } from '../lib/history.js';

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) {
    passed += 1;
    console.log(`  ok ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

/** Minimal session double: seq + eventAt + deriveEventMessage. */
function fakeSession(events) {
  const map = new Map(events.map((event, seq) => [seq, { ...event, seq }]));
  return {
    seq: events.length,
    eventAt: (seq) => map.get(seq),
    deriveEventMessage: (event) => {
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.message ?? null;
      return null;
    },
  };
}
const userMessage = (text) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } });
const assistantMessage = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
});

// ── full-text extraction and deep search ──────────────────────────────────
const long = `${'a'.repeat(5000)}NEEDLE-DEEP${'b'.repeat(5000)}`;
const session = fakeSession([userMessage('hello'), userMessage(long), assistantMessage('tail answer')]);
ok(eventText(session.eventAt(1)).length === long.length, 'eventText returns the full event text (no 4000-char cut)');
ok(eventText(session.eventAt(1), session.deriveEventMessage(session.eventAt(1))) === long, 'the message projection is preferred when provided');
const search = historySearch(session, { query: 'needle-deep' });
ok(search.matches.length === 1 && search.matches[0].seq === 1, 'search finds a match beyond char 4000');
ok(search.matches[0].snippet.includes('NEEDLE-DEEP'), 'the snippet contains the hit verbatim');
ok(search.matches[0].snippet.startsWith('…') && search.matches[0].snippet.endsWith('…'), 'the snippet is a window around the hit');
ok(historySearch(session, { query: '' }).matches.length === 0, 'an empty query yields no matches');

// ── intra-event paging: an oversized event is recoverable byte for byte ───
const first = historyRead(session, { fromSeq: 1, toSeq: 1 }, 1000);
ok(first.truncated === true && first.fromSeq === 1 && first.toSeq === 1, 'an oversized single event is truncated, not dropped');
ok(first.text.includes('a'.repeat(100)), 'the first page holds the head of the event');
ok(/more chars in seq 1\.\.1/.test(first.text), 'the truncation marker states the remaining volume');
const nextOffset = /offset: (\d+)/.exec(first.text);
ok(nextOffset !== null, 'the truncation marker spells out the exact next offset');
const second = historyRead(session, { fromSeq: 1, toSeq: 1, offset: Number(nextOffset?.[1]) }, 1000);
ok(second.fromSeq === 1 && second.text.length > 0, 'the offset read continues on the same event');

const stripPage = (page) => {
  const headEnd = page.text.indexOf('\n');
  let body = headEnd < 0 ? page.text : page.text.slice(headEnd + 1);
  const marker = body.lastIndexOf('\n[truncated — ');
  if (marker >= 0) body = body.slice(0, marker);
  return body;
};
let cursor = 0;
let rebuilt = '';
let rounds = 0;
for (;;) {
  const page = historyRead(session, { fromSeq: 1, toSeq: 1, offset: cursor }, 1000);
  rebuilt += stripPage(page);
  rounds += 1;
  if (!page.truncated || rounds > 100) break;
  const match = /offset: (\d+)/.exec(page.text);
  if (match === null) break;
  cursor = Number(match[1]);
}
ok(rebuilt === long, 'paging recovers the oversized event byte for byte');
ok(rounds >= 5, 'the oversized event really needed several pages');

// ── range paging and explicit remaining volume ────────────────────────────
const many = fakeSession([userMessage('x'.repeat(300)), assistantMessage('y'.repeat(300)), userMessage('z'.repeat(300))]);
const ranged = historyRead(many, { fromSeq: 0, toSeq: 2 }, 400);
ok(ranged.truncated === true, 'a range read is truncated at the output cap');
ok(/more chars in seq \d+\.\.2/.test(ranged.text), 'the range marker names the cut seq and the remaining volume');
ok(ranged.text.includes('offset:'), 'the range marker names the next call');
ok(ranged.text.includes('x'.repeat(300)), 'events before the cut are still returned in full');

// ── message projection, JSON fallback, seq edge cases ────────────────────
const projected = {
  seq: 1,
  eventAt: () => ({ type: 'custom/event', data: { payload: 1 } }),
  deriveEventMessage: () => ({ role: 'user', content: [{ type: 'text', text: 'projected body' }] }),
};
ok(
  historyRead(projected, { fromSeq: 0, toSeq: 0 }, 500).text.includes('projected body'),
  'read-back prefers the message projection (deriveEventMessage) over raw event data',
);
const bare = fakeSession([{ type: 'command/run', data: { name: 'reset' } }]);
const barePage = historyRead(bare, { fromSeq: 0, toSeq: 0 }, 500);
ok(barePage.truncated === false && barePage.text.includes('"name":"reset"'), 'non-message events fall back to JSON text');
const fractional = historyRead(session, { fromSeq: 1.9, toSeq: 1.2 }, 100);
ok(Number.isInteger(fractional.fromSeq) && Number.isInteger(fractional.toSeq), 'fractional seqs are truncated to integers');
ok(fractional.fromSeq === 1 && fractional.toSeq === 1, 'fractional seqs still address the intended event');
ok(historyRead({ seq: 0, eventAt: () => undefined }, { fromSeq: 0, toSeq: 0 }, 100).text === '', 'an empty log reads empty');
ok(
  historyRead(session, { fromSeq: 0, toSeq: 999 }, 200).toSeq === 2,
  'a toSeq past the log is clamped to the last event',
);



// ── hybrid matching: phrase > all-terms AND > some terms (v1.3.0) ─────────
const toolCall = (name, callId) => ({ type: 'tool/call', data: { name, callId, arguments: '{}' } });
const toolResult = (callId, text) => ({
  type: 'tool/result',
  data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }] } },
});

// The compact-007 contamination pattern: the probe message shares some terms
// with the historical event, and the agent's own memory-tool traffic matches too.
const histText = '在 BasicInfoOverlayEntry.kt 的 on关闭 回调里调用 bviewmodel.photoCoordinator.清除照片管理目标()，违反 plan.md 的域隔离约束';
const probeText = 'In the code snippets from RecordOverlayEntry.kt and BasicInfoOverlayEntry.kt, what specific method is called on photoCoordinator inside the close callbacks?';
const hybridSession = fakeSession([
  userMessage('早期上下文'),
  toolResult('other-1', histText), // seq 1: the real historical hit (terms non-adjacent)
  assistantMessage('...'),
  userMessage(probeText), // seq 3: probe — has BasicInfoOverlayEntry + photoCoordinator but not the answer
  toolCall('history_search', 'self-1'), // seq 4: agent's own search call
  toolResult('self-1', `some snippet mentioning photoCoordinator`), // seq 5: its result
]);

// 1) a query whose terms never appear as one phrase still hits via term-AND
const andHit = historySearch(hybridSession, { query: '照片管理目标 BasicInfoOverlayEntry on关闭' });
ok(andHit.matches.length > 0 && andHit.matches[0].seq === 1, 'multi-term query matches an event whose terms are not adjacent');
ok(andHit.matches[0].tier === 1, 'term-AND match is reported as tier 1');
ok(andHit.matches.every((m) => m.seq !== 4 && m.seq !== 5), 'own memory-tool calls and results are excluded by default');

// 2) partial-term events only surface when no all-term match exists
const partialOnly = historySearch(hybridSession, { query: 'photoCoordinator 绝不存在的词' });
ok(partialOnly.matches.length > 0 && partialOnly.matches[0].tier === 2, 'partial-term events surface only as tier 2 fallback');
ok(partialOnly.matches.some((m) => m.seq === 1 || m.seq === 3), 'tier 2 includes events matching some terms');
const noTier2 = historySearch(hybridSession, { query: '照片管理目标 BasicInfoOverlayEntry' });
ok(noTier2.matches.length > 0 && noTier2.matches.every((m) => m.tier !== 2), 'no tier-2 noise when all-term matches exist');

// 3) exact phrase ranks tier 0 above term-AND
const phraseSession = fakeSession([
  userMessage('alpha beta 出现在同一句里'),
  userMessage('alpha 在这里出现, 中间隔着很多内容, 最后才是 beta'),
]);
const phraseHit = historySearch(phraseSession, { query: 'alpha beta' });
ok(phraseHit.matches[0].seq === 0 && phraseHit.matches[0].tier === 0, 'an exact phrase hit ranks tier 0 above term-AND');

// 4) single-term behaviour is unchanged (backward compatible)
const single = historySearch(hybridSession, { query: 'photocoordinator' });
ok(single.matches.length > 0 && single.matches.every((m) => m.tier === 0), 'single-term query stays phrase semantics (tier 0)');
ok(single.matches.every((m) => m.seq !== 4 && m.seq !== 5), 'single-term also excludes self traffic');

// 5) beforeSeq bounds the scan below the current turn
const bounded = historySearch(hybridSession, { query: 'photoCoordinator', beforeSeq: 3 });
ok(bounded.matches.length > 0 && bounded.matches.every((m) => m.seq < 3), 'beforeSeq excludes the current turn from results');

// 6) includeSelf opts back into self-matching
const withSelf = historySearch(hybridSession, { query: 'photoCoordinator', includeSelf: true });
ok(withSelf.matches.some((m) => m.seq === 4 || m.seq === 5), 'includeSelf: true re-admits own tool traffic');

// 7) matches carry a char offset pointing at the hit
ok(typeof andHit.matches[0].offset === 'number' && histText.indexOf('照片管理目标') >= 0, 'match offset is a char index');
const offsetText = histText.slice(andHit.matches[0].offset);
ok(offsetText.includes('照片管理目标') || offsetText.includes('BasicInfoOverlayEntry') || offsetText.includes('on关闭'), 'history_read can continue from the reported offset at the hit');

// 8) density ordering inside one tier: more occurrences and shorter text first
const denseSession = fakeSession([
  userMessage(`hit 只在长文里出现一次 ${'x'.repeat(800)}`),
  userMessage('hit hit hit 短文多次'),
]);
const dense = historySearch(denseSession, { query: 'hit' });
ok(dense.matches[0].seq === 1, 'denser event (more hits, shorter text) outranks a sparse long one');

// ── v1.4.0: scanned reports the events actually scanned ──────────────────
const fullScan = historySearch(hybridSession, { query: 'photoCoordinator' });
ok(fullScan.scanned === hybridSession.seq, 'a full scan reports every event');
ok(bounded.scanned === 3, 'beforeSeq: scanned counts only the bounded range (seqs 0..2)');
ok(historySearch(hybridSession, { query: '' }).scanned === 0, 'an empty query scans nothing');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);


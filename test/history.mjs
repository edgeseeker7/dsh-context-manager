/* dsh-context-manager history tools: pure event fixtures, no harness needed.
 * Covers requirement 4 — full-text search, event-internal paging, explicit
 * truncation markers — plus the seq/arg edge cases the review flagged. */
import { eventText, historyRead, historySearch, historySearchAsync } from '../lib/history.js';

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
const userMessage = (text) => ({
  type: 'user/message',
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
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

// 2) partial-term events now surface as scored tier-1 matches (token model:
// no tier-2 fallback tier anymore — everything non-phrase is BM25-scored)
const partialOnly = historySearch(hybridSession, { query: 'photoCoordinator 绝不存在的词' });
ok(partialOnly.matches.length > 0 && partialOnly.matches[0].tier === 1, 'partial-term events surface as tier 1 scored matches');
ok(partialOnly.matches.some((m) => m.seq === 1 || m.seq === 3), 'tier 1 includes events matching some tokens');
const noTier2 = historySearch(hybridSession, { query: '照片管理目标 BasicInfoOverlayEntry' });
ok(noTier2.matches.length > 0 && noTier2.matches.every((m) => m.tier === 1), 'non-phrase matches are all tier 1 in the token model');

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

// 6) includeSelf opts back into self-matching (current-turn events still need includeCurrentTurn)
const withSelf = historySearch(hybridSession, { query: 'photoCoordinator', includeSelf: true, includeCurrentTurn: true });
ok(withSelf.matches.some((m) => m.seq === 4 || m.seq === 5), 'includeSelf + includeCurrentTurn re-admits own tool traffic');

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

// ── v1.5.0: async search is result-identical and yields across chunks ────
const bigEvents = [userMessage(`needle deep target ${'z'.repeat(50)}`)];
for (let index = 0; index < 4500; index += 1) bigEvents.push(userMessage(`filler event ${index} ${'f'.repeat(40)}`));
bigEvents.push(userMessage('needle at the tail'));
const bigSession = fakeSession(bigEvents);
const syncResult = historySearch(bigSession, { query: 'needle' });
const asyncResult = await historySearchAsync(bigSession, { query: 'needle' });
ok(JSON.stringify(asyncResult) === JSON.stringify(syncResult), 'async search returns the identical result');
ok(asyncResult.scanned === bigEvents.length && asyncResult.scanned > 4000, 'the scan crossed several yield chunks');

// ── v1.6.0: the current turn is excluded by default ──────────────────────
const turnSession = fakeSession([
  userMessage('needle fact from deep history'), // seq 0
  assistantMessage('earlier answer'), // seq 1
  userMessage('probe: what about needle?'), // seq 2 — the current turn's trigger (stays searchable)
  assistantMessage('needle needle needle — my own echo'), // seq 3 — in-flight turn noise
]);
const turnDefault = historySearch(turnSession, { query: 'needle' });
ok(turnDefault.matches.every((m) => m.seq !== 3), 'the in-flight turn is excluded by default');
ok(turnDefault.currentTurnExcluded === 1, 'the exclusion count is reported');
ok(turnDefault.matches.some((m) => m.seq === 2), 'the triggering user message stays searchable');
const turnIncluded = historySearch(turnSession, { query: 'needle', includeCurrentTurn: true });
ok(turnIncluded.matches[0].seq === 3, 'includeCurrentTurn re-admits the in-flight turn');

// ── v1.6.0: poolSize reports the best-tier pool beyond the shown cap ─────
ok(dense.poolSize === 2, 'poolSize counts the whole best-tier pool');

// ── v1.6.0: checkpoint/summary events are visibly marked ─────────────────
const checkpointEvent = {
  type: 'user/message',
  data: {
    role: 'user',
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
    content: [{ type: 'text', text: 'CHECKPOINT summary mentioning needle' }],
  },
};
const cpSession = fakeSession([checkpointEvent, userMessage('needle raw fact'), userMessage('probe needle')]);
const cpSearch = historySearch(cpSession, { query: 'needle' });
ok(cpSearch.matches.find((m) => m.seq === 0)?.checkpoint === true, 'search marks checkpoint events');
const cpRead = historyRead(cpSession, { fromSeq: 0, toSeq: 0 }, 500);
ok(cpRead.text.includes('checkpoint/summary'), 'history_read flags compressed content in the event header');


// ── v1.9.0: tokenized CJK retrieval ──────────────────────────────────────
{
  // a CJK query has no whitespace; the old split made it one unmatchable
  // literal. Bigram/unigram tokens must bridge differently-worded answers.
  const session = fakeSession([
    userMessage('早期闲聊'),
    assistantMessage('CLVRCONNECT 内盒（美规 US 系列）尺寸：195×90×175mm / 137×71×71mm，项目 USNS011'),
    userMessage('无关内容'),
    userMessage('调出美规水晶盒的尺寸数据'),
  ]);
  const hit = historySearch(session, { query: '调出美规水晶盒的尺寸数据' });
  ok(hit.matches.length > 0 && hit.matches[0].seq === 1, 'CJK query tokenizes and hits differently-worded event (盒/美规/尺寸)');
}
{
  // cluster cap: 3 same-bucket hits + 1 far hit — the far one must appear
  // in the first pass instead of the third same-bucket hit.
  const events = [userMessage('alpha 话题 一'), userMessage('alpha 话题 二'), userMessage('alpha 话题 三')];
  for (let i = 0; i < 505; i += 1) events.push(userMessage('填充 '.repeat(50)));
  events.push(userMessage('alpha 远簇 在很后面'));
  events.push(userMessage('probe alpha'));
  const session = fakeSession(events);
  const hit = historySearch(session, { query: 'alpha', limit: 3 });
  ok(hit.matches.some((m) => m.seq >= 505), 'cluster cap admits a far-cluster hit');
  ok(hit.matches.every((m) => m.seq !== 0), 'the 3rd same-cluster hit is displaced by far-cluster hits');
  const allSame = historySearch(fakeSession(events.slice(0, 3)), { query: 'alpha', limit: 3 });
  ok(allSame.matches.length === 3, 'small history backfills overflow (no starvation)');
}
{
  // results mention: top anchors from the hit set, query tokens excluded.
  const session = fakeSession([
    assistantMessage('USNS011 内盒尺寸 195×90×175mm USNS011 归档 USNS011'),
    assistantMessage('USNS011 第二张表'),
    userMessage('probe 尺寸'),
  ]);
  const hit = historySearch(session, { query: '尺寸' });
  ok(Array.isArray(hit.mentions) && hit.mentions.includes('usns011'), 'results mention surfaces the hit-set anchor (usns011, lowercased)');
  ok(!hit.mentions.includes('尺寸'), 'mentions exclude the query tokens themselves');
}
{
  // runtime-context / nudge injections are NOT turn starters: a user-role
  // "Current runtime context" message after the probe must not move the
  // exclusion boundary past the probe (the dream-eval self-echo).
  const session = fakeSession([
    userMessage('历史 needle 事实'),
    userMessage('probe needle'),
    userMessage('Current runtime context. This snapshot supersedes earlier snapshots.'),
  ]);
  const hit = historySearch(session, { query: 'needle' });
  ok(hit.matches.some((m) => m.seq === 0), 'history still searchable after injected notice');
  ok(hit.matches.every((m) => m.seq !== 2), 'injected runtime-context notice excluded from results');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

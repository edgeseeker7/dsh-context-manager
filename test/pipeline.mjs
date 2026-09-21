/* dsh-context-manager v1.9.1+: retrieval pipeline (rule-gated scope, Jev-gated
 * relevance) and the answer-gap gate (generate-then-verify). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-cm-pipeline-'));
process.env.DSH_HOME = home;

const { PinStore, installMalloc } = await import('../lib/malloc.js');

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

const userMessage = (text) => ({
  type: 'user/message',
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const assistantMessage = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] } },
});
/** The marker that pushes everything before it out of the model's window. */
const compactionStart = () => ({ type: 'compaction/start', data: {} });
const fakeSession = (events) => ({
  id: 'pipeline-session',
  seq: events.length,
  header: { cwd: '/pipeline' },
  eventAt(seq) {
    return events[Number(seq)];
  },
  deriveEventMessage() {
    return null;
  },
});

function mockAgent(events, { jevApiKey } = {}) {
  const hooks = {};
  const agent = {
    session: fakeSession(events),
    ctx: {
      systemPrompt: { section: () => {} },
      tools: { register: () => {} },
      on: (event, fn) => {
        hooks[event] = fn;
      },
    },
  };
  const store = new PinStore({ pinMaxChars: 4000, pinsMaxChars: 100000, windowRatio: 0.05, suggestCount: 1 });
  installMalloc(agent, store, {
    resolveWindow: async () => 128000,
    cachedWindow: () => 128000,
    nudgeEvery: 9999,
    suggestAnchors: () => [],
    logger: { warn: () => {} },
    jevApiKey,
  });
  const preStep = async (turn, step, messages = []) => {
    const decision = await hooks['agent/pre-step']({ turn, step, messages }, async () => ({ messages }));
    return decision.messages;
  };
  return { agent, preStep };
}

/** 210 filler events so the log looks long, then the payload. */
const history210 = (payload) => {
  const events = [];
  for (let i = 0; i < 210; i += 1) events.push(userMessage(`日常流水 ${i}`));
  events.push(...payload);
  return events;
};

/**
 * The production shape: filler, the needle, a compaction boundary that pushed
 * the needle out of the window, a few in-window turns, then the new question.
 */
const compactedHistory = (needleEvents, question, { filler = 200, recent = 6 } = {}) => {
  const events = [];
  for (let i = 0; i < filler; i += 1) events.push(userMessage(`日常流水 ${i}`));
  events.push(...needleEvents);
  events.push(compactionStart());
  for (let i = 0; i < recent; i += 1) events.push(userMessage(`近期对话 ${i}`));
  events.push(userMessage(question));
  return events;
};

const NEEDLE = 'CLVRCONNECT 内盒（美规 US 系列）尺寸：195×90×175mm，项目 USNS011';
const NOISE = 'xTool F1 Ultra SMT 钢网激光切割 尺寸 参数 美规 讨论 记录 内盒 水晶盒 尺寸 尺寸 尺寸 尺寸';

/** Answer the rerank questions from the snippet they carry, pages from index. */
const jevFetch = ({ hitScore, noiseScore, pageScore = 0.05, chosenPage = 9 }) => async (_url, init) => {
  const body = JSON.parse(init.body);
  const answers = {};
  for (const [key, question] of Object.entries(body.questions)) {
    if (key.startsWith('page_')) answers[key] = { type: 'noul', noul: key === `page_${chosenPage}` ? pageScore : 0.05 };
    else {
      const snippet = String(question.instructions?.history_hit ?? '');
      answers[key] = { type: 'noul', noul: snippet.includes('USNS011') ? hitScore : noiseScore };
    }
  }
  return { ok: true, json: async () => ({ answers }) };
};

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

// ── Rule ①: no compaction boundary → the window still holds everything ────
{
  const events = [];
  for (let i = 0; i < 300; i += 1) events.push(userMessage(`日常流水 ${i}`));
  events.push(assistantMessage(NEEDLE));
  events.push(userMessage('调出美规水晶盒的尺寸数据'));
  const { preStep } = mockAgent(events);
  const out = await preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] }]);
  ok(out.length === 1, 'no compaction boundary → nothing left the window, no injection');
}

// ── Rule ①: the gate spends no Jev call when it closes ────────────────────
{
  let calls = 0;
  const events = history210([assistantMessage(NEEDLE), userMessage('调出美规水晶盒的尺寸数据')]);
  const out = await withFetch(
    async () => {
      calls += 1;
      throw new Error('the rule gate should not reach Jev');
    },
    async () => {
      const { preStep } = mockAgent(events, { jevApiKey: 'test-key' });
      return preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] }]);
    },
  );
  ok(out.length === 1 && calls === 0, 'a closed rule gate costs zero Jev calls');
}

// ── B: strong out-of-window match injects on step 1 ───────────────────────
{
  const events = compactedHistory([assistantMessage(NEEDLE)], '调出美规水晶盒的尺寸数据');
  const { preStep } = mockAgent(events);
  const out = await preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] }]);
  const notice = out[out.length - 1];
  ok(out.length === 2 && notice.content[0].text.includes('related history'), 'strong out-of-window match injects a notice');
  ok(notice.content[0].text.includes('USNS011') || notice.content[0].text.includes('内盒'), 'the notice carries the differently-worded hit');
}

// ── Rule ②: an in-window hit is not retrieved (the model is reading it) ───
{
  const events = [];
  for (let i = 0; i < 200; i += 1) events.push(userMessage(`日常流水 ${i}`));
  events.push(compactionStart());
  events.push(assistantMessage(NEEDLE));
  events.push(userMessage('调出美规水晶盒的尺寸数据'));
  const { preStep } = mockAgent(events);
  const out = await preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] }]);
  ok(out.length === 1, 'an in-window hit is dropped — the window already shows it');
}

// ── B: weak match (single shared token) stays silent ──────────────────────
{
  const events = compactedHistory([assistantMessage('今天 尺寸 不错')], 'quantum entanglement');
  const { preStep } = mockAgent(events);
  const out = await preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: 'quantum entanglement' }] }]);
  ok(out.length === 1, 'weak match injects nothing (score gate silent)');
}

// ── B: nothing left the window never injects ──────────────────────────────
{
  const { preStep } = mockAgent([assistantMessage('needle 事实'), userMessage('needle')]);
  const out = await preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: 'needle' }] }]);
  ok(out.length === 1, 'a session without a compaction never retrieves');
}

// ── C: gap signal triggers one verification, once per turn ────────────────
{
  const events = history210([
    assistantMessage('四个主体:美国 AviaGames, Inc.、德国 Aviagames GmbH、英国 AVIAGAMES INTERACTIVE LIMITED、香港 Aviagames Limited'),
    userMessage('把 4 个主体都作为 addressee 写进 LO'),
    assistantMessage('邮件草稿如下……四个主体的具体名称我未在邮件中列明，如需我列出，请告知四家主体名称。'),
  ]);
  const { preStep } = mockAgent(events);
  const out = await preStep(1, 2, []);
  const notice = out[out.length - 1];
  ok(out.length === 1 && notice.content[0].text.includes('answer-gap verification'), 'gap signal fires one verification notice');
  ok(notice.content[0].text.includes('AviaGames'), 'the verification carries the fact the answer lacked');
  const again = await preStep(1, 3, []);
  ok(again.length === 0, 'the gate fires at most once per turn');
}

// ── C: a clean answer stays untouched ─────────────────────────────────────
{
  const events = history210([
    userMessage('今天天气怎么样'),
    assistantMessage('今天晴天，温度 25 度，适合出行。这条回复内容完整无任何缺口信号出现。'),
  ]);
  const { preStep } = mockAgent(events);
  const out = await preStep(1, 2, []);
  ok(out.length === 0, 'no gap signal, no verification');
}

// ── B+Jev: noise candidate filtered by the reranker ───────────────────────
{
  const events = compactedHistory([assistantMessage(NEEDLE), assistantMessage(NOISE)], '调出美规水晶盒的尺寸数据');
  const out = await withFetch(jevFetch({ hitScore: 0.95, noiseScore: 0.05 }), async () => {
    const { preStep } = mockAgent(events, { jevApiKey: 'test-key' });
    return preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] }]);
  });
  const notice = out[out.length - 1];
  ok(out.length === 2 && notice.content[0].text.includes('USNS011'), 'jev keeps the relevant hit');
  ok(!notice.content[0].text.includes('xTool'), 'jev drops the merely-topical noise');
}

// ── B+Jev: all verdicts below threshold → silent ──────────────────────────
{
  const events = compactedHistory([assistantMessage(NEEDLE)], '调出美规水晶盒的尺寸数据');
  const out = await withFetch(jevFetch({ hitScore: 0.1, noiseScore: 0.1 }), async () => {
    const { preStep } = mockAgent(events, { jevApiKey: 'test-key' });
    return preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] }]);
  });
  ok(out.length === 1, 'jev all-noise verdict suppresses the injection');
}

// ── B+Jev: a noise verdict on hits does not cancel the page channel ───────
{
  const events = compactedHistory([assistantMessage(NEEDLE), assistantMessage(NOISE)], '调出美规水晶盒的尺寸数据');
  const out = await withFetch(jevFetch({ hitScore: 0.05, noiseScore: 0.05, pageScore: 0.9 }), async () => {
    const { preStep } = mockAgent(events, { jevApiKey: 'test-key' });
    return preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] }]);
  });
  const notice = out[out.length - 1];
  ok(out.length === 2 && notice.content[0].text.includes('selected history areas'), 'a rejected hit pool no longer cancels page selection');
  ok(!notice.content[0].text.includes('best matches'), 'the rejected hits are not carried into the notice');
}

// ── B+Jev: jev failure falls back to the score gate ───────────────────────
{
  const events = compactedHistory([assistantMessage(NEEDLE)], '调出美规水晶盒的尺寸数据');
  const out = await withFetch(
    async () => {
      throw new Error('gateway down');
    },
    async () => {
      const { preStep } = mockAgent(events, { jevApiKey: 'test-key' });
      return preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] }]);
    },
  );
  ok(out.length === 2 && out[out.length - 1].content[0].text.includes('related history'), 'jev outage degrades to the score gate, still injects');
}

// ── B+Jev pages: zero keyword overlap still surfaces the right page ───────
{
  // 模式C 复刻: 问题说"水晶盒", 答案页只有"内盒/USNS011"——关键词通道零命中,
  // 页面选择凭 digest 语义相中选段注入。
  const events = compactedHistory([assistantMessage(`${NEEDLE} 出货检验标准`)], '汇报一下美规水晶盒的尺寸');
  const out = await withFetch(jevFetch({ hitScore: 0.05, noiseScore: 0.05, pageScore: 0.9 }), async () => {
    const { preStep } = mockAgent(events, { jevApiKey: 'test-key' });
    return preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '汇报一下美规水晶盒的尺寸' }] }]);
  });
  const notice = out[out.length - 1];
  ok(out.length === 2, 'page channel fires without any keyword hit');
  ok(notice.content[0].text.includes('selected history areas'), 'notice carries the selected-areas section');
  ok(notice.content[0].text.includes('USNS011'), 'the chosen page delivers the differently-worded fact (mode C)');
}

// ── B+Jev pages: page selection failure leaves the keyword channel intact ──
{
  const events = compactedHistory([assistantMessage(NEEDLE)], '调出美规水晶盒的尺寸数据');
  const out = await withFetch(
    async () => {
      throw new Error('gateway down');
    },
    async () => {
      const { preStep } = mockAgent(events, { jevApiKey: 'test-key' });
      return preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] }]);
    },
  );
  ok(out.length === 2, 'page-select outage still injects via keyword channel');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

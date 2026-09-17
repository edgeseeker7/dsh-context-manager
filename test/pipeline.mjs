/* dsh-context-manager v1.9.1+: retrieval pipeline (always-run, score-gated
 * injection) and the answer-gap gate (generate-then-verify). */
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

function mockAgent(events) {
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
  });
  const preStep = async (turn, step, messages = []) => {
    const decision = await hooks['agent/pre-step']({ turn, step, messages }, async () => ({ messages }));
    return decision.messages;
  };
  return { agent, preStep };
}

/** 210 filler events so the pipeline's min-seq gate opens, then the payload. */
const history210 = (payload) => {
  const events = [];
  for (let i = 0; i < 210; i += 1) events.push(userMessage(`日常流水 ${i}`));
  events.push(...payload);
  return events;
};

// ── B: strong match injects on step 1 ─────────────────────────────────────
{
  const events = history210([
    assistantMessage('CLVRCONNECT 内盒（美规 US 系列）尺寸：195×90×175mm，项目 USNS011'),
    userMessage('调出美规水晶盒的尺寸数据'),
  ]);
  const { preStep } = mockAgent(events);
  const out = await preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] }]);
  const notice = out[out.length - 1];
  ok(out.length === 2 && notice.content[0].text.includes('related history'), 'strong match injects related-history notice');
  ok(notice.content[0].text.includes('USNS011') || notice.content[0].text.includes('内盒'), 'the notice carries the differently-worded hit');
}

// ── B: weak match (single shared token) stays silent ──────────────────────
{
  const events = history210([
    assistantMessage('今天 尺寸 不错'),
    userMessage('quantum entanglement and superconductivity'),
  ]);
  const { preStep } = mockAgent(events);
  const out = await preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: 'quantum entanglement' }] }]);
  ok(out.length === 1, 'weak match injects nothing (score gate silent)');
}

// ── B: short history never injects ────────────────────────────────────────
{
  const { preStep } = mockAgent([assistantMessage('needle 事实'), userMessage('needle')]);
  const out = await preStep(1, 1, [{ role: 'user', content: [{ type: 'text', text: 'needle' }] }]);
  ok(out.length === 1, 'short history skips the pipeline entirely');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

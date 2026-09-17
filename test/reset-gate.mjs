/* dsh-context-manager v1.9.0: post-reset auto-retrieval gate (pre-step hook)
 * and the checkpoint full-history topic map. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-cm-gate-'));
process.env.DSH_HOME = home;

const { PinStore, installMalloc } = await import('../lib/malloc.js');
const { ContextResetEngine } = await import('../lib/engine.js');
const { NotesStore } = await import('../lib/notes.js');

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
  id: 'gate-session',
  seq: events.length,
  header: { cwd: '/gate' },
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
  const resetGate = new WeakSet();
  installMalloc(agent, store, {
    resolveWindow: async () => 128000,
    cachedWindow: () => 128000,
    nudgeEvery: 99,
    suggestAnchors: () => [],
    resetGate,
    logger: { warn: () => {} },
  });
  const preStep = async (messages) => {
    const decision = await hooks['agent/pre-step']({ messages }, async () => ({ messages }));
    return decision.messages;
  };
  return { agent, resetGate, preStep };
}

// ── gate armed: first request gets one retrieval notice, then disarms ─────
{
  const { agent, resetGate, preStep } = mockAgent([
    assistantMessage('CLVRCONNECT 内盒（美规 US 系列）尺寸：195×90×175mm，项目 USNS011'),
    userMessage('闲聊'),
  ]);
  resetGate.add(agent);
  const probe = { role: 'user', content: [{ type: 'text', text: '调出美规水晶盒的尺寸数据' }] };
  const first = await preStep([probe]);
  const notice = first[first.length - 1];
  ok(first.length === 2 && notice.content[0].text.includes('auto-retrieval'), 'armed gate injects exactly one notice');
  ok(notice.content[0].text.includes('seq 0'), 'the notice carries the differently-worded hit');
  const second = await preStep([probe]);
  ok(second.length === 1, 'the gate is one-shot (consumed)');
}

// ── no matches: honest empty notice, still one-shot ───────────────────────
{
  const { agent, resetGate, preStep } = mockAgent([userMessage('完全无关的旧事')]);
  resetGate.add(agent);
  const first = await preStep([{ role: 'user', content: [{ type: 'text', text: 'quantum entanglement explanation' }] }]);
  ok(first[first.length - 1].content[0].text.includes('no matches'), 'an empty retrieval says so honestly');
  ok((await preStep([{ role: 'user', content: [{ type: 'text', text: 'again' }] }])).length === 1, 'also consumed');
}

// ── gate never armed: passthrough ─────────────────────────────────────────
{
  const { preStep } = mockAgent([userMessage('needle 历史')]);
  const messages = await preStep([{ role: 'user', content: [{ type: 'text', text: 'needle' }] }]);
  ok(messages.length === 1, 'unarmed gate never injects');
}

// ── engine: summarize arms the gate AND the checkpoint carries a topic map ──
{
  const { Context } = await import('@deepseek-ai/cordis');
  const isolated = new Context();
  for (const service of ['llm', 'tokenMeter', 'sessions']) {
    isolated.provide(service);
    isolated.set(service, service === 'tokenMeter' ? { measure: () => ({ totalTokens: 1000 }) } : {});
  }
  const notesStore = new NotesStore(8000);
  const pinStore = new PinStore({ pinMaxChars: 4000, pinsMaxChars: 100000, windowRatio: 0.05, suggestCount: 1 });
  const engine = new ContextResetEngine(isolated, {
    llmSummary: false,
    notesStore,
    pinStore,
    checkpointMaxChars: 8000,
  });
  // >200 events: early span about 水晶盒/USNS011, tail about unrelated work.
  const events = [];
  for (let i = 0; i < 260; i += 1) {
    events.push(
      i < 40
        ? assistantMessage('美规内盒尺寸 195×90×175mm，项目 USNS011，归档记录 USNS011')
        : userMessage(`日常事务 ${i} 报表 报表 报表`),
    );
  }
  const agent = {
    session: fakeSession(events),
    ctx: { systemPrompt: { section: () => {} }, tools: { register: () => {} }, on: () => {} },
  };
  const outcome = await engine.summarize({ messages: [userMessage('reset 前的最后一句话').data] }, agent, new AbortController().signal);
  const text = outcome.summary[0].text;
  ok(engine.resetGate.has(agent), 'summarize arms the reset gate');
  ok(text.includes('History topic map'), 'checkpoint carries the topic map');
  const mapLine = text.split('\n').find((line) => line.includes('seq 0..'));
  ok(mapLine !== undefined && (mapLine.includes('usns011') || mapLine.includes('内盒')), 'early-strata topics surface (usns011/内盒)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

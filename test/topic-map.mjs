/* dsh-context-manager v1.9.1: the checkpoint full-history topic map. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-cm-gate-'));
process.env.DSH_HOME = home;

const { PinStore } = await import('../lib/malloc.js');
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
const fakeSession = (events, id = 'gate-session') => ({
  id,
  seq: events.length,
  header: { cwd: '/gate' },
  eventAt(seq) {
    return events[Number(seq)];
  },
  deriveEventMessage() {
    return null;
  },
});

// ── engine: the checkpoint carries a full-history topic map ──
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
  ok(text.includes('History topic map'), 'checkpoint carries the topic map');
  const mapLine = text.split('\n').find((line) => line.includes('seq 0..'));
  ok(mapLine !== undefined && (mapLine.includes('usns011') || mapLine.includes('内盒')), 'early-strata topics surface (usns011/内盒)');
}


// ── engine: oversized diary injects as bounded index, not full text ──
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
  const events = [];
  for (let i = 0; i < 260; i += 1) events.push(userMessage(`日常事务 ${i} 报表`));
  const agent = {
    session: fakeSession(events),
    ctx: { systemPrompt: { section: () => {} }, tools: { register: () => {} }, on: () => {} },
  };
  for (let i = 1; i <= 12; i += 1) {
    await notesStore.append(agent.session.id, `大决策 ${i}: 详细的归因分析和决策原因 ${'Y'.repeat(600)}`, { tags: ['big'] });
  }
  const outcome = await engine.summarize({ messages: [userMessage('reset').data] }, agent, new AbortController().signal);
  const text = outcome.summary[0].text;
  ok(text.includes('INDEX'), 'oversized diary → index form');
  ok(!text.includes('Y'.repeat(600)), 'index form omits note bodies');
  ok(/n\d+/.test(text), 'index keeps note ids addressable');
  ok(text.length < 8000, 'checkpoint stays inside the budget');

  // small diary keeps the full-text form
  const isolated2 = new Context();
  for (const service of ['llm', 'tokenMeter', 'sessions']) {
    isolated2.provide(service);
    isolated2.set(service, service === 'tokenMeter' ? { measure: () => ({ totalTokens: 1000 }) } : {});
  }
  const notesStore2 = new NotesStore(8000);
  const engine2 = new ContextResetEngine(isolated2, { llmSummary: false, notesStore: notesStore2, pinStore, checkpointMaxChars: 8000 });
  const agent2 = {
    session: fakeSession(events.slice(0, 10), 'gate-session-small'),
    ctx: { systemPrompt: { section: () => {} }, tools: { register: () => {} }, on: () => {} },
  };
  await notesStore2.append(agent2.session.id, '小日记一条, 内容不多');
  const outcome2 = await engine2.summarize({ messages: [userMessage('reset').data] }, agent2, new AbortController().signal);
  const text2 = outcome2.summary[0].text;
  if (text2.includes('INDEX')) { const i = text2.indexOf('INDEX'); console.log('DEBUG:', JSON.stringify(text2.slice(Math.max(0, i-80), i+120))); }
  ok(!text2.includes('INDEX'), 'small diary stays full-text');
  ok(text2.includes('小日记一条'), 'small diary body present');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

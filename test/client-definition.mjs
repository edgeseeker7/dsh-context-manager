// Verify dsh-context-manager client Definition logic with fabricated events.
const captured = {};
global.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      captured.id = id;
      const require = (name) => {
        if (name === 'react') return { createElement: () => null, memo: (f) => f, useState: (v) => [v, () => {}] };
        throw new Error(`no such module: ${name}`);
      };
      captured.exports = factory(require);
    },
  },
};

await import(new URL('../lib/client.js', import.meta.url));
const { apply, inject } = captured.exports;
if (typeof apply !== 'function') throw new Error('apply missing');
if (!inject.includes('uiConversation')) throw new Error('uiConversation not injected');

// Capture the registered definition + slot via a fake ctx.
let definition = null;
let slotReg = null;
const ctx = {
  effect: (fn) => fn(),
  locale: { register: () => () => {} },
  uiConversation: { events: { register: (def) => { definition = def; } } },
  slots: {
    inject: (_name, fn) => fn(),
    register: (meta, component) => { slotReg = { meta, component }; },
  },
};
apply(ctx);

const results = [];
const ok = (name, cond) => { results.push([name, !!cond]); };

ok('definition registered', definition !== null);
ok('definition kind', definition?.kind === 'context-manager-reset');
ok('definition target chat', definition?.target === 'chat');
ok('slot key matches kind', slotReg?.meta?.key === 'context-manager-reset');
ok('slot name', slotReg?.meta?.name === 'conversation.chat.node');

// --- Event fixtures (mirror the real RESET #5 transaction shape) ---
const cmdRun = { type: 'command/run', seq: 100, time: 1, data: { commandId: 'cmd-1', name: 'reset' } };
const compactRun = { type: 'command/run', seq: 200, time: 2, data: { commandId: 'cmd-2', name: 'compact' } };
const compStart = { type: 'compaction/start', seq: 101, time: 3, data: { compactionId: 'c-1', sourceCommandId: 'cmd-1' } };
const compSummary = {
  type: 'compaction/summary', seq: 102, time: 4,
  data: {
    compactionId: 'c-1', sourceCommandId: 'cmd-1',
    summary: [{ type: 'text', text: 'CONTEXT WINDOW RESET #6 … full injected content' }],
    shadowedSeqs: [1, 2, 3, 4, 5],
    shadowedTokenCount: 12345,
  },
};
const checkpoint = {
  type: 'user/message', seq: 103, time: 5, surfaceOp: 'replace',
  data: { source: { kind: 'plugin', plugin: 'compact', compactionId: 'c-1', sourceCommandId: 'cmd-1' } },
};
const autoCheckpoint = {
  type: 'user/message', seq: 300, time: 6, surfaceOp: 'replace',
  data: { source: { kind: 'plugin', plugin: 'compact', compactionId: 'c-9' } },
};
const appendMsg = {
  type: 'user/message', seq: 400, time: 7, surfaceOp: 'append',
  data: { source: { kind: 'plugin', plugin: 'compact', compactionId: 'c-1', sourceCommandId: 'cmd-1' } },
};

// match() behavior
ok('claims reset command/run as start', definition.match(cmdRun)?.role === 'start' && definition.match(cmdRun)?.id === 'cmd-1');
ok('ignores compact command/run', definition.match(compactRun) === null);
ok('claims compaction/start as update', definition.match(compStart)?.role === 'update');
ok('claims compaction/summary as update', definition.match(compSummary)?.id === 'cmd-1');
ok('claims checkpoint as update', definition.match(checkpoint)?.id === 'cmd-1');
ok('ignores automatic checkpoint (no sourceCommandId)', definition.match(autoCheckpoint) === null);
ok('ignores append-origin message', definition.match(appendMsg) === null);

// buildViewNode over a simulated context (start + updates)
const mkMatch = (event, role) => ({ event, role, location: { kind: 'turn', turn: 1 } });
const context = {
  key: 'k1', id: 'cmd-1',
  matches: [mkMatch(cmdRun, 'start'), mkMatch(compStart, 'update'), mkMatch(compSummary, 'update'), mkMatch(checkpoint, 'update')],
  start: mkMatch(cmdRun, 'start'),
  state: undefined, // exercise the foldMatches fallback path
};
const node = definition.buildViewNode(context);
ok('node built', node !== null);
ok('node kind', node?.kind === 'context-manager-reset');
ok('node anchor = checkpoint seq', node?.anchorSeq === 103);
ok('node summary verbatim', node?.data?.summary === 'CONTEXT WINDOW RESET #6 … full injected content');
ok('node item count', node?.data?.shadowedItemCount === 5);
ok('node token count', node?.data?.shadowedTokenCount === 12345);
ok('node visible', node?.visibility === 'visible');
ok('node location from start match', node?.location?.kind === 'turn');

// /compact context (no start claimed) → no node
const compactCtx = {
  key: 'k2', id: 'cmd-2',
  matches: [mkMatch({ ...compSummary, data: { ...compSummary.data, sourceCommandId: 'cmd-2' } }, 'update')],
  start: undefined, state: undefined,
};
ok('compact lifetime yields no node', definition.buildViewNode(compactCtx) === null);

// before checkpoint lands → no node
const earlyCtx = { key: 'k3', id: 'cmd-1', matches: [mkMatch(cmdRun, 'start'), mkMatch(compSummary, 'update')], start: mkMatch(cmdRun, 'start'), state: undefined };
ok('no node before checkpoint', definition.buildViewNode(earlyCtx) === null);

// state path (start/update folding, not fallback)
let st = definition.start({}, mkMatch(cmdRun, 'start'));
st = definition.update({ state: st }, mkMatch(compSummary, 'update'));
st = definition.update({ state: st }, mkMatch(checkpoint, 'update'));
const stateCtx = { key: 'k4', id: 'cmd-1', matches: context.matches, start: mkMatch(cmdRun, 'start'), state: st };
ok('state-fold path builds node', definition.buildViewNode(stateCtx)?.data?.shadowedItemCount === 5);

let failed = 0;
for (const [name, pass] of results) {
  if (!pass) failed++;
  console.log(`${pass ? 'ok' : 'FAIL'} ${name}`);
}
console.log(failed === 0 ? `\n${results.length} passed, 0 failed` : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

/* dsh-context-manager /reset command: the pin-cleanup half must report what
 * actually happened (never a free that did not occur) and keep the reset
 * outcome honest when the cleanup write fails. */
import { registerResetCommand } from '../lib/command.js';

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

const warnings = [];
let registered = null;
const ctx = {
  logger: { warn: (message) => warnings.push(String(message)) },
  // Drive the setup generator far enough to reach commands.register.
  effect: (fn) => {
    const iterator = fn();
    iterator.next();
    iterator.next();
  },
  commands: {
    register: (definition) => {
      registered = definition;
    },
  },
};
const okEngine = () => ({
  compactNow: async () => ({ shadowedSeqs: [1, 2], shadowedTokenCount: 10, summarySeq: 5 }),
});
const invocation = {
  rawInput: '',
  commandId: 'cmd-1',
  signal: { aborted: false },
  agent: { session: { id: 'sess-reset' } },
};
const withPinStore = async (pinStore, engine = okEngine()) => {
  registered = null;
  registerResetCommand(ctx, engine, pinStore);
  return { definition: registered, result: await registered.handler(invocation) };
};

const freed = await withPinStore({ clearTask: async () => ({ cleared: 2 }) });
ok(freed.definition?.name === 'reset', 'the reset command registers');
ok(freed.result.kind === 'success' && freed.result.text.includes('2 task pins freed'), 'a completed cleanup is reported');
ok(freed.result.text.includes('2 history items'), 'the reset result is reported');
ok(freed.result.sourceEventSeq === 5, 'the checkpoint seq is passed through');

const nothing = await withPinStore({ clearTask: async () => ({ cleared: 0 }) });
ok(nothing.result.text.includes('No task pins were pinned'), 'an empty task scope is stated plainly');
ok(!/task pins? freed/.test(nothing.result.text), 'nothing is claimed freed when nothing was pinned');

warnings.length = 0;
const broke = await withPinStore({ clearTask: async () => ({ cleared: 0, error: new Error('disk full') }) });
ok(broke.result.kind === 'success' && broke.result.text.includes('could NOT be freed'), 'a failed cleanup is reported, not smoothed over');
ok(broke.result.text.includes('disk full'), 'the failure reason reaches the user');
ok(!/task pins? freed/.test(broke.result.text), 'a failed cleanup never claims a free');
ok(warnings.some((warning) => warning.includes('left task pins pinned')), 'a failed cleanup is warned about');

const usage = await withPinStore({ clearTask: async () => ({ cleared: 0 }) });
registered = usage.definition;
ok((await registered.handler({ ...invocation, rawInput: '--now' })).kind === 'error', 'arguments are rejected');

registered = null;
registerResetCommand(ctx, { compactNow: async () => null }, { clearTask: async () => ({ cleared: 0 }) });
ok((await registered.handler(invocation)).text.includes('No resettable history yet'), 'empty history short-circuits');

registered = null;
registerResetCommand(
  ctx,
  {
    compactNow: async () => {
      throw new Error('boom');
    },
  },
  { clearTask: async () => ({ cleared: 0 }) },
);
const cancelled = await registered.handler({ ...invocation, signal: { aborted: true } });
ok(cancelled.kind === 'error' && cancelled.text === 'Reset cancelled.', 'an aborted reset reports cancellation');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);


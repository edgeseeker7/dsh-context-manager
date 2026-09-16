/* dsh-context-manager boot smoke: apply() + installAgent against a mock
 * cordis context — catches import-time and wiring regressions that the pure
 * store suites cannot see (the closest we get to a host boot without one). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-cm-boot-'));
process.env.DSH_HOME = home;

const { apply, name, inject } = await import('../lib/index.js');

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

ok(name === 'dsh-context-manager', 'plugin name exports');
ok(Array.isArray(inject) && inject.includes('commands') && inject.includes('llm'), 'service injection declares its needs');

// ── apply() against a mock root context ───────────────────────────────────
const registrations = { on: [], sections: [], tools: [], commands: [] };
const ctx = {
  logger: { warn: () => {} },
  on: (event, handler) => registrations.on.push({ event, handler }),
  effect: (fn) => {
    const iterator = fn();
    iterator.next();
    iterator.next();
  },
  commands: {
    register: (definition) => registrations.commands.push(definition.name),
  },
  get: () => ({}),
  provide: () => {},
  set: () => {},
};

let applyError = null;
try {
  apply(ctx, {});
} catch (error) {
  applyError = error;
}
ok(applyError === null, `apply() boots without throwing${applyError ? `: ${applyError.message}` : ''}`);
ok(registrations.on.some((entry) => entry.event === 'agent/created'), 'the agent/created installer registers');
ok(registrations.commands.includes('reset'), 'the /reset command registers');

ok(Boolean(ctx) && (() => { try { apply(ctx, { nope: 1 }); return false; } catch { return true; } })(), 'an unknown config key fails loudly');

// ── installAgent against a mock agent ─────────────────────────────────────
const install = registrations.on.find((entry) => entry.event === 'agent/created')?.handler;
const agent = {
  session: {
    id: 'boot-session',
    header: { cwd: '/boot' },
    seq: 0,
    eventAt: () => undefined,
    requestHeader: () => undefined,
  },
  options: {},
  ctx: {
    systemPrompt: {
      section: (definition) => registrations.sections.push(definition.name),
    },
    tools: {
      register: (definition) => registrations.tools.push(definition.name ?? 'unknown'),
    },
    on: () => {},
  },
};
let installError = null;
try {
  install({ agent });
} catch (error) {
  installError = error;
}
ok(installError === null, `installAgent runs without throwing${installError ? `: ${installError.message}` : ''}`);
for (const tool of ['context_alloc', 'context_free', 'context_list', 'notes_append', 'notes_read', 'history_search', 'history_read']) {
  ok(registrations.tools.includes(tool), `tool installed: ${tool}`);
}
ok(registrations.sections.includes('context-manager:rules'), 'protocol section installed');
ok(registrations.sections.includes('context-manager:pins'), 'vault section installed');
ok(registrations.sections.includes('context-manager:diary-hint'), 'diary-hint section installed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

/* dsh-context-manager reset-engine mechanics (v1.4.0): the deterministic
 * checkpoint section — anchor extraction is pure and tested without a
 * harness. */
import { extractAnchors, extractConstraints } from '../lib/engine.js';

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

const corpus = `
job 74e4ee3c-6c01-4fd9-8452-84f10a7270d5 finished at 70%
retry of 74e4ee3c-6c01-4fd9-8452-84f10a7270d5 confirmed
another job c80088ae-c2e9-4b17-b67d-23049b55a5f3 done
work happened in /home/liudi/dsh-cm-eval and again /home/liudi/dsh-cm-eval plus /home/liudi/dsh-context-manager/lib/engine.js
page: https://pcg-compare.app.msh.team/ and see https://moonshot.feishu.cn/docx/Lw3xdhF0hoRWBtx5mcIcBBAvnUd.
visit https://pcg-compare.app.msh.team/, again
`;

const { ids, paths, urls } = extractAnchors(corpus);

ok(ids.length === 2, 'both UUIDs extracted');
ok(ids[0][0] === '74e4ee3c-6c01-4fd9-8452-84f10a7270d5' && ids[0][1] === 2, 'the repeated id ranks first with its count');
ok(ids[1][0] === 'c80088ae-c2e9-4b17-b67d-23049b55a5f3' && ids[1][1] === 1, 'the single-mention id follows');

ok(paths.some(([p, n]) => p === '/home/liudi/dsh-cm-eval' && n === 2), 'repeated path counted');
ok(paths.some(([p]) => p === '/home/liudi/dsh-context-manager/lib/engine.js'), 'longer path kept whole');

ok(urls.some(([u, n]) => u === 'https://pcg-compare.app.msh.team/' && n === 2), 'trailing punctuation stripped from urls, repeats merged');
ok(urls.some(([u]) => u === 'https://moonshot.feishu.cn/docx/Lw3xdhF0hoRWBtx5mcIcBBAvnUd'), 'doc url kept without the trailing period');

ok(extractAnchors('nothing here').ids.length === 0, 'an anchor-free corpus yields empty lists');
ok(extractAnchors('').paths.length === 0, 'empty input is safe');

// short fragments that must NOT become paths
ok(extractAnchors('a/b and x/y/z').paths.length === 0, 'relative fragments are not paths');

// ── v1.6.0: constraint sentences are extracted verbatim ──────────────────
const constraints = extractConstraints('先把 A 做完。不要改 BasicInfoOverlayEntry 的关闭逻辑,那是域隔离约束。另外必须用 v2 接口。天气不错。');
ok(constraints.length === 2, 'only the constraint sentences are extracted');
ok(constraints[0].includes('不要改 BasicInfoOverlayEntry'), 'negated constraint kept verbatim');
ok(constraints.some((c) => c.includes('必须用 v2 接口')), 'mandate kept verbatim');
ok(extractConstraints('今天天气不错,继续推进。').length === 0, 'no markers, no constraints');
ok(extractConstraints('Please never share the token. Thanks!').some((c) => c.includes('never share the token')), 'English negations are caught');
ok(extractConstraints(`${'必须'.concat('x'.repeat(300))}。`).length === 1, 'a single oversized constraint is still kept (truncated)');
ok(extractConstraints(''.concat('不要碰这个。'.repeat(20))).length <= 10, 'the list is capped');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

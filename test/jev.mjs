/* jev reranker: request shape, verdict mapping, failure fallback. */
import { JEV_RELEVANCE_THRESHOLD, jevRerank } from '../lib/jev.js';

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}`);
  }
}

const candidates = [
  { seq: 1375, snippet: '美规内盒 USNS011 长 45cm 宽 30cm' },
  { seq: 2400, snippet: 'SMT 钢网激光切割 xTool F1 Ultra 20W 光纤' },
];

const REQUEST = '调出美规水晶盒的尺寸数据';

function fakeFetch(verdicts) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    const answers = {};
    for (const key of Object.keys(body.questions)) {
      const seq = Number(key.replace('cand_', ''));
      answers[key] = { type: 'noul', noul: verdicts[seq] };
    }
    return { ok: true, json: async () => ({ answers }) };
  };
  fn.calls = calls;
  return fn;
}

const fetcher = fakeFetch({ 1375: 0.91, 2400: 0.12 });
const out = await jevRerank({ apiKey: 'test-key', request: REQUEST, candidates, fetchImpl: fetcher });
ok(out !== null && out.length === 2, 'two verdicts back');
ok(out[0].seq === 1375 && Math.abs(out[0].probability - 0.91) < 1e-9, 'probabilities mapped to seqs');

const sent = JSON.parse(fetcher.calls[0].init.body);
ok(sent.model === 'jev-latest', 'uses jev-latest');
ok(Object.keys(sent.questions).length === 2, 'one question per candidate in a single call');
ok(sent.questions.cand_1375.type === 'noul', 'noul question type');
ok(
  sent.questions.cand_1375.instructions.history_hit.includes('USNS011'),
  'candidate snippet rides inside instructions',
);
ok(fetcher.calls[0].init.headers.authorization === 'Bearer test-key', 'bearer key on the wire');

const none = await jevRerank({ apiKey: undefined, request: REQUEST, candidates, fetchImpl: fakeFetch({}) });
ok(none === null, 'no key → null (caller falls back)');

const failing = async () => {
  throw new Error('network down');
};
const fallback = await jevRerank({ apiKey: 'k', request: REQUEST, candidates, fetchImpl: failing });
ok(fallback === null, 'network failure → null after retry, never throws');

const badStatus = async () => ({ ok: false });
ok((await jevRerank({ apiKey: 'k', request: REQUEST, candidates, fetchImpl: badStatus })) === null, 'non-ok status → null');

ok(JEV_RELEVANCE_THRESHOLD === 0.5, 'threshold pinned at 0.5');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

/* jev reranker: request shape, verdict mapping, failure fallback, log tags. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-cm-jev-'));
process.env.DSH_HOME = home;

const { JEV_NOTE_THRESHOLD, JEV_RELEVANCE_THRESHOLD, jevLog, jevRerank, jevSelectNoteSpans, jevSelectPages } =
  await import('../lib/jev.js');

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

ok(JEV_RELEVANCE_THRESHOLD === 0.5, 'relevance threshold pinned at 0.5');
ok(JEV_NOTE_THRESHOLD === 0.7, 'note threshold pinned at the measured 0.7 band (durable 0.81+, churn 0.61-)');

// ── the log line carries its session tag ──────────────────────────────────
{
  jevLog('jev notes kept 1/2 spans', { id: 'session-e589b4cd-336a-4cec-b13d-5f236efc97b9' });
  jevLog('jev enabled (rerank + page-select)');
  const lines = readFileSync(join(home, 'context-manager', 'jev.log'), 'utf8').trim().split('\n');
  ok(lines[0].includes('[e589b4cd] jev notes kept 1/2 spans'), 'a session-tagged line names its session');
  ok(!lines[1].includes('['), 'a line without a session stays untagged');
}

// ── page selection ─────────────────────────────────────────────────────────
{
  const pages = [
    { fromSeq: 0, toSeq: 99, digest: '水晶 / 内盒 / usns011 / 尺寸 / 出货' },
    { fromSeq: 100, toSeq: 199, digest: 'smt / 钢网 / 激光 / xtool / 光纤' },
    { fromSeq: 200, toSeq: 299, digest: '疫苗 / 夜醒 / 婴儿 / 睡眠' },
  ];
  const fetcher2 = async (url, init) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        answers: { page_0: { type: 'noul', noul: 0.88 }, page_1: { type: 'noul', noul: 0.42 }, page_2: { type: 'noul', noul: 0.03 } },
        _keys: Object.keys(body.questions),
      }),
    };
  };
  const verdicts = await jevSelectPages({ apiKey: 'k', request: REQUEST, pages, fetchImpl: fetcher2 });
  ok(verdicts !== null && verdicts.length === 3, 'page verdicts back for every page');
  ok(verdicts[0].fromSeq === 0 && Math.abs(verdicts[0].probability - 0.88) < 1e-9, 'verdict mapped to the right page');
  ok((await jevSelectPages({ apiKey: undefined, request: REQUEST, pages, fetchImpl: fetcher2 })) === null, 'no key → null');
  const failing2 = async () => { throw new Error('down'); };
  ok((await jevSelectPages({ apiKey: 'k', request: REQUEST, pages, fetchImpl: failing2 })) === null, 'failure → null');
}

// ── note-worthiness (the nudge's content gate) ─────────────────────────────
{
  const spans = [
    { fromSeq: 600, toSeq: 607, digest: 'constraint / api / version', excerpt: '决定只用 v2 接口，禁止 v1 兼容层' },
    { fromSeq: 608, toSeq: 615, digest: 'chatter / lint / format', excerpt: '跑了 ruff format 和 tach check' },
  ];
  const recorded = '[w24] 部署规则: 一律走仓库脚本';
  let sentBody = null;
  const fetcher3 = async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ answers: { span_0: { type: 'noul', noul: 0.77 }, span_1: { type: 'noul', noul: 0.08 } } }) };
  };
  const verdicts = await jevSelectNoteSpans({ apiKey: 'k', recorded, spans, fetchImpl: fetcher3 });
  ok(verdicts !== null && verdicts.length === 2, 'note verdicts back for every span');
  ok(verdicts[0].fromSeq === 600 && Math.abs(verdicts[0].probability - 0.77) < 1e-9, 'verdict mapped to the right span');
  ok(Object.keys(sentBody.questions).length === 2, 'one question per span in a single call');
  ok(sentBody.questions.span_0.type === 'noul', 'noul question type');
  ok(sentBody.questions.span_0.instructions.recorded_memory === recorded, 'the span is judged against what memory already holds');
  ok(sentBody.questions.span_0.instructions.span.includes('seq 600..607'), 'the span carries its seq range');
  ok(sentBody.state === recorded, 'the recorded memory is the request state, never the user message');
  ok(
    (await jevSelectNoteSpans({ apiKey: undefined, recorded, spans, fetchImpl: fetcher3 })) === null,
    'no key → null (the volume trigger stays in charge)',
  );
  const down = async () => {
    throw new Error('down');
  };
  ok((await jevSelectNoteSpans({ apiKey: 'k', recorded, spans, fetchImpl: down })) === null, 'failure → null');
  const reasons4 = [];
  await jevSelectNoteSpans({ apiKey: 'k', recorded, spans: [], onDegrade: (r) => reasons4.push(r) });
  ok(reasons4.length === 1 && reasons4[0].includes('no spans'), 'an empty delta degrades honestly');
}

// ── degrade reasons are reported, never silent ─────────────────────────────
{
  const reasons = [];
  await jevRerank({ apiKey: 'k', request: REQUEST, candidates, fetchImpl: async () => { throw new Error('boom'); }, onDegrade: (r) => reasons.push(r) });
  ok(reasons.length === 1 && reasons[0].includes('boom'), 'network degrade reports the reason');
  const reasons2 = [];
  await jevRerank({ apiKey: 'k', request: REQUEST, candidates, fetchImpl: async () => ({ ok: false, status: 429 }), onDegrade: (r) => reasons2.push(r) });
  ok(reasons2.length === 1 && reasons2[0].includes('429'), 'http-status degrade reports the status');
  const reasons3 = [];
  await jevSelectPages({ apiKey: undefined, request: REQUEST, pages: [], onDegrade: (r) => reasons3.push(r) });
  ok(reasons3.length === 1 && reasons3[0].includes('no api key'), 'missing key degrade reports itself');
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

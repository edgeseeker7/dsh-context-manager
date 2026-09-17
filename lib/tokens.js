/**
 * dsh-context-manager — shared tokenization for retrieval.
 *
 * The old queryTerms() split on whitespace, which made a CJK query ONE giant
 * literal term (Chinese has no spaces) that almost never matches — the root
 * cause of the reset arm's Chinese-search failures (offline eval: 0/16).
 * This module tokenizes CJK as unigrams+bigrams and ASCII as lowercase words.
 * @module dsh-context-manager/tokens
 */

const CJK_RE = /[⺀-鿿豈-﷿]/;
const CJK_RUN_RE = /[⺀-鿿豈-﷿]+/g;
const WORD_RE = /[A-Za-z0-9][A-Za-z0-9_./#+-]*/g;

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'was',
  'were',
  'with',
  'this',
  'that',
  'these',
  'those',
  'have',
  'has',
  'had',
  'you',
  'your',
  'yours',
  'they',
  'them',
  'their',
  'what',
  'when',
  'where',
  'which',
  'who',
  'how',
  'why',
  'can',
  'could',
  'would',
  'should',
  'will',
  'shall',
  'may',
  'might',
  'must',
  'not',
  'but',
  'all',
  'any',
  'each',
]);
const STOP_CHARS = new Set([...'的了和是在我你他她它这那有没不也都与及或很还就又被把对从向到于着过呢吗吧啊嘛呀哦嗯']);

/**
 * Tokenize text into search terms: CJK bigrams (plus unigram for length-1
 * runs) and lowercase ASCII/number words (stop words dropped).
 * @param {string} text
 * @returns {string[]} tokens (may contain duplicates — tf is a feature)
 */
export function tokenize(text) {
  const tokens = [];
  const source = String(text ?? '');
  for (const match of source.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    if (run.length === 1) {
      if (!STOP_CHARS.has(run)) tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!STOP_CHARS.has(bigram[0]) && !STOP_CHARS.has(bigram[1])) tokens.push(bigram);
    }
    // Unigrams only for rare-anchor potential: single distinctive chars inside
    // longer runs add noise, so only emit them when the run is short (<=3) and
    // the char is not a stop char — e.g. 盒 in 水晶盒 finds 内盒/盒子.
    if (run.length <= 3) {
      for (const ch of run) if (!STOP_CHARS.has(ch)) tokens.push(ch);
    }
  }
  for (const match of source.matchAll(WORD_RE)) {
    const word = match[0].toLowerCase();
    if (word.length >= 2 && !STOP_WORDS.has(word)) tokens.push(word);
  }
  return tokens;
}

/**
 * The most frequent distinctive tokens of a text, for "results mention"
 * footers and the checkpoint topic map. Frequency-ranked, deduped, query
 * tokens excluded.
 * @param {string} text
 * @param {number} limit
 * @param {Set<string>} [exclude]
 * @returns {string[]}
 */
export function topTerms(text, limit, exclude = new Set()) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    if (exclude.has(token) || token.length < 2) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([token]) => token);
}

/** True when the string contains any CJK char (cheap gate for mixed paths). */
export function hasCjk(text) {
  return CJK_RE.test(text);
}

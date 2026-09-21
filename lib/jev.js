/**
 * Jev (TypeSafe System One) relevance reranker for the retrieval pipeline.
 *
 * The pipeline's strength gate is a score threshold; Jev replaces "how high"
 * with "is it actually relevant" — one HTTP call judges every candidate in
 * parallel (the questions map fans out per candidate). Any failure returns
 * null so the pipeline falls back to the plain score gate: Jev is a
 * refinement, never a point of failure.
 */

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 8000;

/**
 * @param {object} input
 * @param {string} input.apiKey - Bearer key (test or production).
 * @param {string} input.request - the latest user message.
 * @param {Array<{seq: number, snippet: string}>} input.candidates - pipeline hits to judge.
 * @param {function} [input.fetchImpl] - injectable for tests; defaults to global fetch.
 * @returns {Promise<Array<{seq: number, probability: number}> | null>} null on any failure.
 */
export async function jevRerank({ apiKey, request, candidates, fetchImpl, onDegrade }) {
  const degrade = (reason) => {
    onDegrade?.(reason);
    return null;
  };
  if (!apiKey) return degrade('no api key');
  if (candidates.length === 0) return degrade('no candidates');
  let lastError = 'unknown';
  const doFetch = fetchImpl ?? fetch;
  const questions = {};
  for (const candidate of candidates) {
    questions[`cand_${candidate.seq}`] = {
      type: 'noul',
      instructions: {
        context:
          "The `request` is the user's latest message to an AI assistant. The `history_hit` is a snippet retrieved from their long conversation history with that assistant.",
        question:
          'Is `history_hit` materially relevant to fulfilling `request` — does it contain specific facts from the shared history that a good answer should use, rather than being unrelated or merely topically similar?',
        request,
        history_hit: candidate.snippet,
      },
    };
  }
  const body = JSON.stringify({ state: request, model: JEV_MODEL, questions });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await doFetch(JEV_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      if (!response.ok) return degrade(`http ${response.status}`);
      const payload = await response.json();
      const answers = payload?.answers;
      if (answers === undefined || answers === null) return degrade('malformed payload (no answers)');
      const out = [];
      for (const candidate of candidates) {
        const answer = answers[`cand_${candidate.seq}`];
        if (typeof answer?.noul !== 'number')
          return degrade(`malformed payload (missing noul for seq ${candidate.seq})`);
        out.push({ seq: candidate.seq, probability: answer.noul });
      }
      return out;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return degrade(`network error: ${lastError}`);
}

/** Default relevance threshold; below this a hit is treated as noise. */
export const JEV_RELEVANCE_THRESHOLD = 0.5;

/**
 * Page selection: which history strata ("pages") are worth reading for this
 * request — ReadAgent's choose-pages as a calibrated judgment instead of a
 * keyword guess. One fanned-out noul call, one question per page.
 *
 * @param {object} input
 * @param {string} input.apiKey
 * @param {string} input.request - the latest user message.
 * @param {Array<{fromSeq: number, toSeq: number, digest: string}>} input.pages
 * @param {function} [input.fetchImpl]
 * @returns {Promise<Array<{fromSeq: number, toSeq: number, probability: number}> | null>}
 */
export async function jevSelectPages({ apiKey, request, pages, fetchImpl, onDegrade }) {
  const degrade = (reason) => {
    onDegrade?.(reason);
    return null;
  };
  if (!apiKey) return degrade('no api key');
  if (pages.length === 0) return degrade('no pages');
  let lastError = 'unknown';
  const doFetch = fetchImpl ?? fetch;
  const questions = {};
  pages.forEach((page, index) => {
    questions[`page_${index}`] = {
      type: 'noul',
      instructions: {
        context:
          "The `request` is the user's latest message to an AI assistant. Their long conversation history is split into chronological pages; `page_digest` lists the most frequent keywords and entities of one page (the assistant cannot see the history itself).",
        question:
          'Does the history page described by `page_digest` likely contain specific facts or content needed to fulfill `request` well — is it worth re-reading that page before answering?',
        request,
        page_digest: page.digest,
      },
    };
  });
  const body = JSON.stringify({ state: request, model: JEV_MODEL, questions });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await doFetch(JEV_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      if (!response.ok) return degrade(`http ${response.status}`);
      const payload = await response.json();
      const answers = payload?.answers;
      if (answers === undefined || answers === null) return degrade('malformed payload (no answers)');
      const out = [];
      for (const [index, page] of pages.entries()) {
        const answer = answers[`page_${index}`];
        if (typeof answer?.noul !== 'number') return degrade(`malformed payload (missing noul for page_${index})`);
        out.push({ fromSeq: page.fromSeq, toSeq: page.toSeq, probability: answer.noul });
      }
      return out;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return degrade(`network error: ${lastError}`);
}

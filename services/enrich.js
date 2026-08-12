const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const BATCH_SIZE = 6;

const SIGNAL_TYPES = [
  "funding",
  "launch",
  "expansion",
  "leadership",
  "m_and_a",
  "financials",
  "partnership",
  "other",
];

// Rough priority weights used by the fallback scorer and as a floor for Gemini.
const TYPE_WEIGHT = {
  funding: 90,
  m_and_a: 85,
  expansion: 78,
  launch: 74,
  leadership: 70,
  partnership: 64,
  financials: 58,
  other: 40,
};

const KEYWORDS = {
  funding: ["funding", "raises", "raised", "series a", "series b", "series c", "ipo",
            "valuation", "investment", "investors", "funding round", "led by"],
  m_and_a: ["acquires", "acquisition", "acquired", "merger", "merges", "stake sale",
            "buyout", "takeover", "block deal", "divest"],
  expansion: ["expands", "expansion", "new market", "enters", "opens in", "new city",
              "scaling", "hiring spree", "new office", "warehouse"],
  launch: ["launches", "launched", "unveils", "rolls out", "debuts", "introduces",
           "new product", "goes live", "campaign"],
  leadership: ["appoints", "appointed", "hires", "resigns", "resignation", "steps down",
               "new ceo", "new cfo", "new cmo", "joins as", "elevated", "promoted"],
  financials: ["profit", "loss", "revenue", "earnings", "quarterly results", "turnover",
               "net income", "ebitda", "q1", "q2", "q3", "q4", "fy2"],
  partnership: ["partners", "partnership", "ties up", "collaboration", "tie-up",
                "joins hands", "mou", "alliance"],
};

/**
 * Cheap, offline classification. Used when Gemini is unavailable, out of quota,
 * or returns something unusable - the platform must keep working either way.
 */
function classifyOffline(article) {
  const hay = `${article.title || ""} ${(article.body || "").slice(0, 1200)}`.toLowerCase();

  let best = "other";
  let bestHits = 0;
  for (const [type, words] of Object.entries(KEYWORDS)) {
    const hits = words.reduce((n, w) => (hay.includes(w) ? n + 1 : n), 0);
    if (hits > bestHits) {
      bestHits = hits;
      best = type;
    }
  }

  const summary = (article.body || article.title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);

  return {
    signal_type: best,
    score: Math.min(100, TYPE_WEIGHT[best] + Math.min(bestHits * 2, 10)),
    summary: summary || null,
    why_it_matters: null,
  };
}

function safeJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildPrompt(articles) {
  const block = articles
    .map((a, i) =>
      [
        `--- Article ${i + 1} ---`,
        `Company: ${a.company}`,
        `Title: ${a.title || "N/A"}`,
        `Published: ${a.published || "N/A"}`,
        `Source: ${a.site || "N/A"}`,
        "",
        (a.body || "").replace(/\s+/g, " ").slice(0, 2500),
      ].join("\n")
    )
    .join("\n\n");

  return `You work on the new-business team at a marketing agency. You read business news and decide which stories are worth a sales conversation.

For each article below, return one object with these fields:
- "index": the article number (1-based integer)
- "signal_type": exactly one of ${SIGNAL_TYPES.join(", ")}
- "summary": 2 sentences, plain English, concrete. Include numbers, names and dates where the article gives them.
- "why_it_matters": 1 sentence on the marketing opening this creates for an agency pitching this company (new budget, new launch to promote, new decision-maker, new market to enter). If there is no real opening, say so.
- "score": integer 0-100 for how urgently a salesperson should act on this. 80+ means call them this week. Under 40 means background noise.

Return ONLY a JSON array. No prose, no markdown fences.

${block}`;
}

async function enrichBatch(model, articles) {
  const result = await model.generateContent(buildPrompt(articles));
  const parsed = safeJson(result.response.text());
  if (!Array.isArray(parsed)) throw new Error("Gemini returned unparseable JSON");

  const byIndex = new Map();
  for (const row of parsed) {
    const idx = Number(row.index);
    if (Number.isFinite(idx)) byIndex.set(idx, row);
  }

  return articles.map((article, i) => {
    const row = byIndex.get(i + 1);
    if (!row) return { ...classifyOffline(article), enriched: 0 };

    const type = SIGNAL_TYPES.includes(row.signal_type) ? row.signal_type : "other";
    const score = Number.isFinite(Number(row.score))
      ? Math.max(0, Math.min(100, Math.round(Number(row.score))))
      : TYPE_WEIGHT[type];

    return {
      signal_type: type,
      score,
      summary: row.summary ? String(row.summary).trim() : null,
      why_it_matters: row.why_it_matters ? String(row.why_it_matters).trim() : null,
      enriched: 1,
    };
  });
}

/**
 * Enrich a list of articles. Always resolves with one result per input article,
 * in the same order. Never throws.
 */
async function enrichArticles(articles, log = console.log) {
  if (!articles || articles.length === 0) return [];

  if (!process.env.GEMINI_API_KEY) {
    log("[enrich] No GEMINI_API_KEY set - using keyword classification.");
    return articles.map((a) => ({ ...classifyOffline(a), enriched: 0 }));
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: MODEL });

  const out = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    try {
      log(`[enrich] ${MODEL}: batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} articles)`);
      out.push(...(await enrichBatch(model, batch)));
    } catch (err) {
      log(`[enrich] Batch failed (${err.message}) - falling back to keywords.`);
      out.push(...batch.map((a) => ({ ...classifyOffline(a), enriched: 0 })));
    }
  }
  return out;
}

module.exports = { enrichArticles, classifyOffline, SIGNAL_TYPES, TYPE_WEIGHT };

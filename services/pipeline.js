require("dotenv").config();

const db = require("../db");
const genericScraper = require("../scrapers/genericScraper");
const { enrichArticles } = require("./enrich");

const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 500);
const RESULTS_PER_QUERY = Number(process.env.RESULTS_PER_QUERY || 10);

// Only one run at a time - the API has rate limits and Gemini costs money.
let currentRun = null;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function isRunning() {
  return currentRun !== null;
}

function runState() {
  return currentRun ? { ...currentRun } : null;
}

/** Cross-multiplies active sites x active companies */
async function buildQueries() {
  const [companiesRes, sitesRes, topicsRes] = await Promise.all([
    db.query("SELECT * FROM companies WHERE active = true ORDER BY name"),
    db.query("SELECT * FROM sites WHERE active = true ORDER BY name"),
    db.query("SELECT keyword FROM topics WHERE active = true"),
  ]);

  const companies = companiesRes.rows;
  const sites = sitesRes.rows;
  const topics = topicsRes.rows.map((t) => t.keyword);

  const configs = [];
  for (const site of sites) {
    for (const company of companies) {
      let keywords = company.keywords;
      if (typeof keywords === "string") {
        try {
          keywords = JSON.parse(keywords);
        } catch {
          keywords = [company.name];
        }
      }
      if (!Array.isArray(keywords) || keywords.length === 0) keywords = [company.name];

      configs.push({
        name: `${site.name}-${company.name}`,
        company: company.name,
        companyId: company.id,
        site: site.name,
        sourceUri: site.domain,
        companyKeyword: keywords,
        topics,
        size: RESULTS_PER_QUERY,
        lang: "eng",
      });
    }
  }
  return configs;
}

/** Every company on the watchlist gets a lead row, created on first sight. */
async function ensureLead(companyId) {
  const existing = await db.query("SELECT id FROM leads WHERE company_id = $1", [companyId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const insertRes = await db.query(
    "INSERT INTO leads (company_id) VALUES ($1) ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW() RETURNING id",
    [companyId]
  );
  return insertRes.rows[0].id;
}

async function backfillLeads() {
  const companiesRes = await db.query("SELECT id FROM companies");
  for (const c of companiesRes.rows) {
    await ensureLead(c.id);
  }
}

/**
 * Run the full cycle.
 * @param {string} trigger  'manual' | 'schedule' | 'startup'
 * @param {function} log
 */
async function runPipeline(trigger = "manual", log = console.log) {
  if (isRunning()) {
    throw new Error("A scrape is already running. Wait for it to finish.");
  }

  const runRes = await db.query("INSERT INTO runs (trigger) VALUES ($1) RETURNING id", [trigger]);
  const runId = runRes.rows[0].id;

  const queries = await buildQueries();
  currentRun = {
    id: runId,
    trigger,
    startedAt: new Date().toISOString(),
    total: queries.length,
    done: 0,
    fetched: 0,
    newSignals: 0,
    errors: 0,
  };

  await backfillLeads();

  if (queries.length === 0) {
    await finishRun(runId, currentRun, "done", "Nothing to run - add a company and a source first.");
    const snapshot = runState();
    currentRun = null;
    return snapshot;
  }

  log(`[run ${runId}] ${queries.length} queries (${trigger})`);

  const fresh = []; // articles whose URL we have never seen
  const seenThisRun = new Set();

  try {
    for (const config of queries) {
      try {
        const articles = await genericScraper(config);
        currentRun.fetched += articles.length;

        for (const article of articles) {
          if (!article.url) continue;
          if (seenThisRun.has(article.url)) continue;

          // Check if exists in DB
          const existsRes = await db.query("SELECT 1 FROM signals WHERE url = $1", [article.url]);
          if (existsRes.rows.length > 0) continue;

          seenThisRun.add(article.url);
          fresh.push(article);
        }
      } catch (err) {
        currentRun.errors += 1;
        log(`[run ${runId}] ${config.name} failed: ${err.message}`);
      }

      currentRun.done += 1;
      if (REQUEST_DELAY_MS > 0) {
        await delay(REQUEST_DELAY_MS);
      }
    }

    log(`[run ${runId}] ${currentRun.fetched} fetched, ${fresh.length} new after dedupe.`);

    if (fresh.length > 0) {
      const enrichment = await enrichArticles(fresh, log);
      await saveSignals(fresh, enrichment, runId);
      currentRun.newSignals = fresh.length;
    }

    await recomputeLeadRollups();
    await finishRun(runId, currentRun, "done", null);
    log(`[run ${runId}] Done. ${currentRun.newSignals} new signals stored.`);
  } catch (err) {
    await finishRun(runId, currentRun, "failed", err.message);
    log(`[run ${runId}] Failed: ${err.message}`);
    currentRun = null;
    throw err;
  }

  const snapshot = runState();
  currentRun = null;
  return snapshot;
}

async function saveSignals(articles, enrichment, runId) {
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const e = enrichment[i] || {};
    const leadId = await ensureLead(article.companyId);

    let pubDate = null;
    if (article.published) {
      const parsedDate = new Date(article.published);
      if (!isNaN(parsedDate.getTime())) pubDate = parsedDate.toISOString();
    }

    await db.query(
      `INSERT INTO signals
         (lead_id, company, title, url, author, published, site, section_title,
          body, summary, why_it_matters, signal_type, score, enriched, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (url) DO NOTHING`,
      [
        leadId,
        article.company,
        article.title || null,
        article.url,
        article.author || null,
        pubDate,
        article.site || null,
        article.section_title || null,
        (article.body || "").slice(0, 8000) || null,
        e.summary || null,
        e.why_it_matters || null,
        e.signal_type || "other",
        Number.isFinite(e.score) ? e.score : 40,
        Boolean(e.enriched),
        runId,
      ]
    );
  }
}

/** Keeps leads.last_signal_at / leads.score in sync with their signals. */
async function recomputeLeadRollups() {
  await db.query(
    `UPDATE leads
        SET last_signal_at = (
              SELECT MAX(COALESCE(s.published, s.created_at)) FROM signals s WHERE s.lead_id = leads.id
            ),
            score = COALESCE((
              SELECT MAX(s.score) FROM signals s
               WHERE s.lead_id = leads.id
                 AND COALESCE(s.published, s.created_at) >= NOW() - INTERVAL '30 days'
            ), 0)`
  );
}

async function finishRun(runId, state, status, message) {
  await db.query(
    `UPDATE runs
        SET status = $1, queries = $2, fetched = $3, new_signals = $4, errors = $5,
            message = $6, finished_at = NOW()
      WHERE id = $7`,
    [status, state.total, state.fetched, state.newSignals, state.errors, message, runId]
  );
}

module.exports = { runPipeline, buildQueries, isRunning, runState, recomputeLeadRollups, ensureLead };

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

/** Cross-multiplies active sites x active companies, exactly like build.js did. */
function buildQueries() {
  const companies = db.prepare("SELECT * FROM companies WHERE active = 1 ORDER BY name").all();
  const sites = db.prepare("SELECT * FROM sites WHERE active = 1 ORDER BY name").all();
  const topics = db
    .prepare("SELECT keyword FROM topics WHERE active = 1")
    .all()
    .map((t) => t.keyword);

  const configs = [];
  for (const site of sites) {
    for (const company of companies) {
      let keywords;
      try {
        keywords = JSON.parse(company.keywords);
      } catch {
        keywords = [company.name];
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
function ensureLead(companyId) {
  const existing = db.prepare("SELECT id FROM leads WHERE company_id = ?").get(companyId);
  if (existing) return existing.id;
  const info = db.prepare("INSERT INTO leads (company_id) VALUES (?)").run(companyId);
  return info.lastInsertRowid;
}

function backfillLeads() {
  const companies = db.prepare("SELECT id FROM companies").all();
  for (const c of companies) ensureLead(c.id);
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

  const runInfo = db.prepare("INSERT INTO runs (trigger) VALUES (?)").run(trigger);
  const runId = runInfo.lastInsertRowid;

  const queries = buildQueries();
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

  backfillLeads();

  if (queries.length === 0) {
    finishRun(runId, currentRun, "done", "Nothing to run - add a company and a source first.");
    const snapshot = runState();
    currentRun = null;
    return snapshot;
  }

  log(`[run ${runId}] ${queries.length} queries (${trigger})`);

  const fresh = [];        // articles whose URL we have never seen
  const seenThisRun = new Set();

  const urlExists = db.prepare("SELECT 1 FROM signals WHERE url = ?");

  try {
    for (const config of queries) {
      try {
        const articles = await genericScraper(config);
        currentRun.fetched += articles.length;

        for (const article of articles) {
          if (!article.url) continue;
          if (seenThisRun.has(article.url)) continue;
          if (urlExists.get(article.url)) continue;
          seenThisRun.add(article.url);
          fresh.push(article);
        }
      } catch (err) {
        currentRun.errors += 1;
        log(`[run ${runId}] ${config.name} failed: ${err.message}`);
      }

      currentRun.done += 1;
      await delay(REQUEST_DELAY_MS);
    }

    log(`[run ${runId}] ${currentRun.fetched} fetched, ${fresh.length} new after dedupe.`);

    if (fresh.length > 0) {
      const enrichment = await enrichArticles(fresh, log);
      saveSignals(fresh, enrichment, runId);
      currentRun.newSignals = fresh.length;
    }

    recomputeLeadRollups();
    finishRun(runId, currentRun, "done", null);
    log(`[run ${runId}] Done. ${currentRun.newSignals} new signals stored.`);
  } catch (err) {
    finishRun(runId, currentRun, "failed", err.message);
    log(`[run ${runId}] Failed: ${err.message}`);
    currentRun = null;
    throw err;
  }

  const snapshot = runState();
  currentRun = null;
  return snapshot;
}

const insertSignal = () =>
  db.prepare(
    `INSERT OR IGNORE INTO signals
       (lead_id, company, title, url, author, published, site, section_title,
        body, summary, why_it_matters, signal_type, score, enriched, run_id)
     VALUES (@lead_id, @company, @title, @url, @author, @published, @site, @section_title,
             @body, @summary, @why_it_matters, @signal_type, @score, @enriched, @run_id)`
  );

function saveSignals(articles, enrichment, runId) {
  const stmt = insertSignal();
  const tx = db.transaction(() => {
    articles.forEach((article, i) => {
      const e = enrichment[i] || {};
      stmt.run({
        lead_id: ensureLead(article.companyId),
        company: article.company,
        title: article.title,
        url: article.url,
        author: article.author,
        published: article.published,
        site: article.site,
        section_title: article.section_title,
        body: (article.body || "").slice(0, 8000) || null,
        summary: e.summary || null,
        why_it_matters: e.why_it_matters || null,
        signal_type: e.signal_type || "other",
        score: Number.isFinite(e.score) ? e.score : 40,
        enriched: e.enriched ? 1 : 0,
        run_id: runId,
      });
    });
  });
  tx();
}

/** Keeps leads.last_signal_at / leads.score in sync with their signals. */
function recomputeLeadRollups() {
  db.prepare(
    `UPDATE leads
        SET last_signal_at = (
              SELECT MAX(COALESCE(s.published, s.created_at)) FROM signals s WHERE s.lead_id = leads.id
            ),
            score = COALESCE((
              SELECT MAX(s.score) FROM signals s
               WHERE s.lead_id = leads.id
                 AND COALESCE(s.published, s.created_at) >= datetime('now', '-30 days')
            ), 0)`
  ).run();
}

function finishRun(runId, state, status, message) {
  db.prepare(
    `UPDATE runs
        SET status = ?, queries = ?, fetched = ?, new_signals = ?, errors = ?,
            message = ?, finished_at = datetime('now')
      WHERE id = ?`
  ).run(status, state.total, state.fetched, state.newSignals, state.errors, message, runId);
}

module.exports = { runPipeline, buildQueries, isRunning, runState, recomputeLeadRollups, ensureLead };

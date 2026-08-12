# Curious Media — Lead Intelligence

The news scraper, rebuilt as a web app for the team. Same NewsAPI.ai queries as
before; instead of appending rows to a Google Sheet it stores everything in a
local database and serves it as a working surface: leads, signals, ownership and
outreach history.

---

## Run it

```bash
npm install
cp .env.example .env      # already filled in with your existing keys
npm run setup             # seeds the watchlist, creates the first admin account
npm start                 # http://localhost:3000
```

`npm run setup` asks for a username, display name and password. That account is
an admin. Everyone else gets added from the **Admin** tab inside the app.

To pull the first batch of articles: sign in → **Admin** → **Run a cycle now**.
After that it runs itself at 2am and 2pm.

---

## What replaced what

| Before | Now |
| --- | --- |
| `config/companies.js`, `config/sites.js` | Admin tab → editable without touching code |
| `config/topics.js` (commented out) | Admin tab → "Topic narrowing", off by default |
| `sheets.js` → `spreadsheets.values.append` | SQLite (`data/leads.db`) + the web UI |
| `node index.js`, run by hand | cron at 2am/2pm + a "Run a cycle now" button |
| `prompt.js` (written, never wired in) | `services/enrich.js`, runs on every new article |
| Duplicate rows on every run | URL is a unique key — an article is stored once |

Your original `scrapers/genericScraper.js` is carried over nearly unchanged, so
the queries hitting NewsAPI.ai are the same ones you have already tuned.

---

## How the app is organised

**Signals** are articles. One row per URL, deduped forever.

**Leads** are companies. Every company on the watchlist has exactly one lead,
and the lead holds all the outreach state: status, owner, contact details, last
contacted date, next follow-up, activity log. News flows in; the lead is what
the team actually works.

That split is what makes the filters useful — "unclaimed companies with a
funding signal in the last 7 days" is one query, not a spreadsheet sort.

### The tabs

- **Today's Leads** — companies with something discovered in the last 24 hours. The morning list.
- **All Leads** — the full watchlist, filterable.
- **Signals** — the raw article feed with the AI summary and source link.
- **My Outreach** — leads you own.
- **Admin** — watchlist, sources, team, and the run history. Admins only.

### What Gemini adds

For each new article it writes a two-sentence summary, a one-line **why it
matters** aimed at a marketing pitch, a signal type (funding / launch /
expansion / leadership / M&A / partnership / financials) and a 0–100 urgency
score. The score drives the default sort, so the strongest openings sit at the
top of the morning list.

If the Gemini key is missing or a call fails, articles are classified by
keyword instead and everything else keeps working. You'll see it in the Admin
tab.

---

## Configuration

Everything lives in `.env`:

| Key | Purpose |
| --- | --- |
| `NEWSAPI_AI_KEY` | Required. NewsAPI.ai / Event Registry. |
| `GEMINI_API_KEY` | Optional. Enables summaries and scoring. |
| `GEMINI_MODEL` | Defaults to `gemini-2.0-flash`. |
| `PORT` | Defaults to 3000. |
| `CRON_SCHEDULE` | Defaults to `0 2,14 * * *`. |
| `TZ_NAME` | Defaults to `Asia/Kolkata`. |
| `DISABLE_SCHEDULER` | Set `true` to run cycles only by hand. |
| `RESULTS_PER_QUERY` | Articles per company-per-source. Defaults to 10. |
| `REQUEST_DELAY_MS` | Throttle between API calls. Defaults to 500. |
| `DB_PATH` | Where the SQLite file lives. |
| `SECURE_COOKIES` | Set `true` only when serving over HTTPS. |

### API budget

One cycle is `active companies × active sources` requests. Your starting
watchlist is 7 × 13 = **91 requests per cycle, 182 a day**. Adding a company adds
13 requests per cycle. If you hit your NewsAPI.ai quota, pause sources you don't
need in the Admin tab — that's the fastest lever.

---

## Putting it on a shared machine

It's a normal Node app with no external services, so any small VM works:

```bash
npm install -g pm2
pm2 start server.js --name leads
pm2 save && pm2 startup
```

Then put nginx in front with TLS and set `SECURE_COOKIES=true`. The database is
the single file at `data/leads.db` — back that up and you've backed up
everything.

Sessions are cookie-based and last 14 days. Passwords are hashed with scrypt.

---

## Layout

```
server.js              Express entry point
db/schema.sql          Tables (applied on every boot, safe to re-run)
db/seed.js             npm run setup
scrapers/              NewsAPI.ai fetcher, carried over from the old project
services/pipeline.js   fetch → dedupe → enrich → store
services/enrich.js     Gemini classification + keyword fallback
services/scheduler.js  cron
routes/                auth, leads, signals, stats, admin
public/                the UI (no build step — plain HTML/CSS/JS)
```

`npm run scrape` runs one cycle from the command line, no server needed —
handy for cron on a machine where you'd rather not keep the web app running.

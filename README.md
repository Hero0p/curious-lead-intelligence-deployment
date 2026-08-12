# Curious Media — Lead Intelligence

The news scraper, rebuilt as a modern web app for the team. Watches news sources (via NewsAPI.ai / Event Registry) for buying signals, enriches them with AI summaries & scoring, and turns them into trackable leads.

Database: **Supabase (PostgreSQL)**  
Hosting: **Vercel (Serverless + Vercel Cron)**

---

## Quick Start (Local Setup)

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure `.env`**:
   ```bash
   cp .env.example .env
   ```
   Add your `DATABASE_URL` (Supabase Connection URI) and `NEWSAPI_AI_KEY`.

3. **Initialize Database & Create First Admin**:
   ```bash
   npm run setup
   ```
   This creates all database tables in Supabase, seeds the default watchlist, and prompts for your initial admin credentials.

4. **Start local dev server**:
   ```bash
   npm start
   ```
   Open `http://localhost:3000`.

---

## Deploying to Vercel (100% Free)

### Step 1: Create Supabase Project
1. Go to [supabase.com](https://supabase.com) and create a free project.
2. Go to **Project Settings** → **Database** → **Connection String** → select **URI**.
3. Copy the URI (`postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres`).

### Step 2: Push Code to GitHub
```bash
git add .
git commit -m "Migrate to Supabase and Vercel"
git push origin main
```

### Step 3: Import to Vercel
1. Go to [vercel.com](https://vercel.com) and click **Add New** → **Project**.
2. Select your GitHub repository (`Hero0p/curious-lead-intelligence-deployment`).
3. Add the following **Environment Variables** in Vercel:
   - `DATABASE_URL`: Your Supabase connection string.
   - `NEWSAPI_AI_KEY`: Your NewsAPI.ai key.
   - `GEMINI_API_KEY`: *(Optional)* Your Google Gemini key for summaries & scoring.
   - `GEMINI_MODEL`: `gemini-2.0-flash`
   - `SECURE_COOKIES`: `true`
   - `ADMIN_USERNAME`: `admin`
   - `ADMIN_PASSWORD`: Your desired admin password (min 6 characters)
   - `ADMIN_DISPLAY_NAME`: `Admin`
4. Click **Deploy**.

### Step 4: Run Initial Seed
Run `npm run setup` locally with your Supabase `DATABASE_URL` in `.env`, or execute the SQL in [db/schema.sql](file:///c:/Users/nisha/Downloads/curious-lead-intelligence/curious-lead-intelligence/db/schema.sql) in the Supabase SQL Editor.

---

## Automated Scheduling (Vercel Cron)
Scheduled scraping runs are configured in `vercel.json` to hit `/api/cron` twice daily (at 2:00 AM and 2:00 PM UTC/configured schedule).

---

## Project Structure

```
api/index.js           Vercel serverless entry point
server.js              Express application
db/index.js            PostgreSQL connection pool (pg)
db/schema.sql          PostgreSQL / Supabase table schema
db/seed.js             Watchlist seeder & admin creator (npm run setup)
scrapers/              NewsAPI.ai fetcher
services/pipeline.js   fetch → dedupe → enrich → store
services/enrich.js     Gemini classification + keyword fallback
services/scheduler.js  node-cron for local runs
routes/                auth, leads, signals, stats, admin, cron
public/                Frontend UI (plain HTML/CSS/JS)
vercel.json            Vercel routing & Cron schedule
```

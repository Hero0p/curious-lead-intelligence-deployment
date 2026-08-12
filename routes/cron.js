const express = require("express");
const { runPipeline, isRunning, runState } = require("../services/pipeline");

const router = express.Router();

// Endpoint for Vercel Cron or external schedulers
router.get("/", async (req, res) => {
  // Check authorization if CRON_SECRET is configured
  const authHeader = req.headers.authorization || "";
  const expectedSecret = process.env.CRON_SECRET;

  if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
    return res.status(401).json({ error: "Unauthorized cron request." });
  }

  if (isRunning()) {
    return res.status(409).json({ message: "Pipeline already running.", current: runState() });
  }

  if (!process.env.NEWSAPI_AI_KEY) {
    return res.status(400).json({ error: "NEWSAPI_AI_KEY is not configured." });
  }

  try {
    const result = await runPipeline("schedule");
    res.json({ ok: true, result });
  } catch (err) {
    console.error("[cron] pipeline error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

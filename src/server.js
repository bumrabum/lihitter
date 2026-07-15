import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "./config.js";
import { basicAuth } from "./lib/auth.js";
import { webhookRouter } from "./routes/webhook.js";
import { apiRouter, gmailFetchAndProcess } from "./routes/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Webhooks bypass auth (validated by WEBHOOK_SECRET)
app.use("/webhooks", webhookRouter);

// All other routes require auth in prod mode
app.use(basicAuth);

// Named page routes (clean URLs without .html extension)
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/checklist", (_req, res) => res.sendFile(path.join(publicDir, "checklist.html")));
app.get("/settings", (_req, res) => res.sendFile(path.join(publicDir, "settings.html")));

// Static assets (js, css, images etc.)
app.use(express.static(publicDir));

app.use("/api", apiRouter);

app.listen(config.port, () => {
  console.log(`Listening on http://localhost:${config.port}`);
  console.log(`Jobs viewer:  http://localhost:${config.port}/`);
  console.log(`Checklist:    http://localhost:${config.port}/checklist`);

  // Hourly Gmail fetch scheduler
  async function scheduledGmailFetch() {
    if (!config.gmailUser || !config.gmailAppPassword) {
      console.log('[scheduler] Gmail fetch skipped — credentials not configured');
      return;
    }
    try {
      const { processed, totalVacancies } = await gmailFetchAndProcess('newer_than:1d');
      console.log(`[scheduler] Gmail fetch: ${processed} emails, ${totalVacancies} vacancies`);
    } catch (err) {
      console.error('[scheduler] Gmail fetch error:', err.message);
    }
  }

  scheduledGmailFetch();
  setInterval(scheduledGmailFetch, 60 * 60 * 1000);
});

import express from "express";
import { z } from "zod";
import { config } from "../config.js";
import { processEmail } from "../services/processEmail.js";
import { parseLinkedInJobHtml } from "../lib/parseJobHtml.js";
import { evaluateVacancy, loadRules } from "../lib/rules.js";
import { insertRun } from "../lib/db.js";
import { runChecklistForVacancy } from "../lib/runChecklist.js";

const router = express.Router();

const payloadSchema = z.object({
  subject: z.string().default(""),
  from: z.string().default(""),
  text: z.string().default(""),
  html: z.string().default(""),
  receivedAt: z.string().optional()
});

const parseHtmlSchema = z.object({
  html: z.string().min(1, "html is required"),
  url: z.string().optional().default("")
});

function authGuard(req, res) {
  const authHeader = req.get("x-webhook-secret");
  if (!config.webhookSecret || authHeader !== config.webhookSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

router.post("/gmail", async (req, res) => {
  try {
    if (!authGuard(req, res)) return;
    const payload = payloadSchema.parse(req.body);
    const result = await processEmail(payload);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

/**
 * POST /webhooks/parse-job-html
 *
 * Parse a raw LinkedIn job page HTML and evaluate it against rules.json.
 * Body: { html: "<full page html>", url: "https://linkedin.com/jobs/view/..." }
 * Header: x-webhook-secret
 *
 * Returns the same shape as a single vacancy result from /webhooks/gmail.
 */
router.post("/parse-job-html", (req, res) => {
  try {
    if (!authGuard(req, res)) return;

    const { html, url } = parseHtmlSchema.parse(req.body);
    const vacancy = parseLinkedInJobHtml(html, url);
    const rules = loadRules();
    const evaluation = evaluateVacancy(vacancy, rules);
    const result = { ...vacancy, evaluation };

    const processedAt = new Date().toISOString();

    const { vacancyIds } = insertRun({
      emailSubject: url || "(html upload)",
      emailFrom: "",
      processedAt,
      vacancyCount: 1,
      results: [result]
    });

    // Run checklist asynchronously — don't block the response
    if (vacancyIds && vacancyIds.length > 0) {
      runChecklistForVacancy(vacancyIds[0]).catch((err) =>
        console.error("[checklist] Background run failed:", err.message)
      );
    }

    return res.status(200).json({
      processedAt,
      vacancyCount: 1,
      results: [result]
    });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

export { router as webhookRouter };

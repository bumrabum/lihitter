import { extractVacancyLinks } from "../lib/extractVacancies.js";
import { fetchLinkedInJobHtml } from "../lib/linkedin.js";
import { insertRun, getVacancyByUrl, getDismissedByTitleCompany, getDb } from "../lib/db.js";
import { runChecklistForVacancies } from "../lib/runChecklist.js";
import { emit } from "../lib/eventBus.js";
import { randomUUID } from "node:crypto";

export async function processEmail(payload) {
  const subject = payload.subject || '(no subject)';
  const from = payload.from || '(unknown sender)';
  console.log(`[email] Processing email — subject: "${subject}" from: ${from}`);

  const webhookId = randomUUID();

  // Notify the debug bar that a webhook arrived
  emit({
    type: "webhook",
    id: webhookId,
    url: payload.subject || "(no subject)",
    status: "pending",
    detail: "parsing links…"
  });

  const vacancyLinks = extractVacancyLinks(payload);
  console.log(`[email] Found ${vacancyLinks.length} vacancy link${vacancyLinks.length !== 1 ? 's' : ''} in "${subject}"`);

  // Update webhook entry with link count
  emit({
    type: "webhook",
    id: webhookId,
    url: payload.subject || "(no subject)",
    status: "ok",
    detail: `${vacancyLinks.length} link${vacancyLinks.length !== 1 ? "s" : ""} found`
  });

  // Skip URLs that are already in the database.
  // If a previously dismissed job (ignore / wont_apply) reappears, auto-skip it.
  const newLinks = [];
  for (const url of vacancyLinks) {
    const existing = getVacancyByUrl(url);
    if (!existing) {
      newLinks.push(url);
    } else if (['ignore', 'wont_apply'].includes(existing.status)) {
      getDb().prepare("UPDATE vacancies SET status = 'auto_skip' WHERE id = ?").run(existing.id);
      console.log(`[email] Auto-skipped previously dismissed job: ${url}`);
    }
  }
  const skippedCount = vacancyLinks.length - newLinks.length;
  if (skippedCount > 0) {
    console.log(`[email] Skipping ${skippedCount} already-stored job${skippedCount !== 1 ? 's' : ''}`);
  }

  // Fetch each job and emit a parse event per URL
  const reviewedVacancies = newLinks.length
    ? await Promise.all(
        newLinks.map(async (url) => {
          const parseId = randomUUID();
          emit({ type: "parse", id: parseId, url, status: "pending", detail: "" });
          try {
            const details = await fetchLinkedInJobHtml(url);
            emit({
              type: "parse",
              id: parseId,
              url,
              status: "ok",
              detail: details.title || "(no title)"
            });
            return details;
          } catch (err) {
            emit({ type: "parse", id: parseId, url, status: "error", detail: err.message });
            throw err;
          }
        })
      )
    : [];

  // Check fetched jobs against dismissed entries by company + title (repost detection)
  const trulyNew = [];
  for (const details of reviewedVacancies) {
    const dismissed = getDismissedByTitleCompany(details.title, details.company);
    if (dismissed) {
      getDb().prepare("UPDATE vacancies SET status = 'auto_skip' WHERE id = ?").run(dismissed.id);
      console.log(`[email] Auto-skipped repost: "${details.title}" at ${details.company}`);
    } else {
      trulyNew.push(details);
    }
  }

  const results = trulyNew.map((details) => ({
    ...details,
    evaluation: { passed: true }
  }));

  const output = {
    emailSubject: payload.subject || "",
    emailFrom: payload.from || "",
    processedAt: new Date().toISOString(),
    vacancyCount: trulyNew.length,
    results
  };

  const { vacancyIds } = insertRun(output);

  // Run checklist only for newly inserted vacancies
  if (vacancyIds && vacancyIds.length > 0) {
    runChecklistForVacancies(vacancyIds).catch((err) =>
      console.error("[checklist] Background run failed:", err.message)
    );
  }

  return output;
}

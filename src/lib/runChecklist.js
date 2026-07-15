import { getDb } from './db.js';
import { askLLM, askLLMBatch } from './llm.js';
import { emit } from './eventBus.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';

/**
 * Run all enabled checklist items against a vacancy and persist results.
 * Existing results for this vacancy are replaced (delete + insert).
 *
 * @param {number} vacancyId
 * @returns {Promise<Array<{ checklistId, label, passed, reasoning }>>}
 */
export async function runChecklistForVacancy(vacancyId) {
  const db = getDb();

  const vacancy = db
    .prepare('SELECT id, url, title, company, location, description FROM vacancies WHERE id = ?')
    .get(vacancyId);

  if (!vacancy) throw new Error(`Vacancy ${vacancyId} not found`);
  console.log(`[checklist] Running checks for vacancy ${vacancyId}: ${vacancy.url || vacancy.title || '(unknown)'}`);

  const items = db
    .prepare('SELECT id, label, prompt, system_prompt FROM checklist_items WHERE enabled = 1 ORDER BY id ASC')
    .all();

  // Always clear previous results for this vacancy before inserting new ones,
  // even if there are no enabled items — prevents stale rows from accumulating.
  db.prepare('DELETE FROM checklist_results WHERE vacancy_id = ?').run(vacancyId);

  if (items.length === 0) return [];

  const insertResult = db.prepare(
    `INSERT INTO checklist_results (vacancy_id, checklist_id, passed, reasoning, ran_at)
     VALUES (@vacancy_id, @checklist_id, @passed, @reasoning, @ran_at)`
  );

  const ranAt = new Date().toISOString();
  const output = [];

  // Check if quick mode is enabled in settings
  let quickMode = false;
  try {
    if (fs.existsSync(config.settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(config.settingsPath, 'utf8'));
      quickMode = settings.quickMode === true;
    }
  } catch { /* ignore, fall back to per-item mode */ }

  // Emit a pending match event for this vacancy
  const matchId = randomUUID();
  emit({
    type: "match",
    id: matchId,
    url: vacancy.url || `vacancy #${vacancyId}`,
    status: "pending",
    detail: `running ${items.length} check${items.length !== 1 ? 's' : ''}${quickMode ? ' (quick mode)' : ''}…`
  });

  if (quickMode) {
    // ── Quick mode: single LLM call for all checks ──────────────────────────
    const batchResults = await askLLMBatch(items, vacancy);

    for (const result of batchResults) {
      const item = items.find(i => i.id === result.id);
      insertResult.run({
        vacancy_id: vacancyId,
        checklist_id: result.id,
        passed: result.passed ? 1 : 0,
        reasoning: result.reasoning || '',
        ran_at: ranAt
      });
      output.push({ checklistId: result.id, label: item?.label ?? result.name, passed: result.passed, reasoning: result.reasoning });
    }
  } else {
    // ── Normal mode: one LLM call per check ────────────────────────────────
    for (const item of items) {
      const sysPrompt = item.system_prompt && item.system_prompt.trim()
        ? item.system_prompt.trim()
        : undefined;

      const { passed, reasoning } = await askLLM(item.prompt, vacancy, sysPrompt);
      console.log(`[checklist] vacancy ${vacancyId} | "${item.label}": ${passed ? 'PASS' : 'FAIL'} — ${reasoning}`);

      insertResult.run({
        vacancy_id: vacancyId,
        checklist_id: item.id,
        passed: passed ? 1 : 0,
        reasoning: reasoning || '',
        ran_at: ranAt
      });

      output.push({ checklistId: item.id, label: item.label, passed, reasoning });
    }
  }

  const passedCount = output.filter(r => r.passed).length;
  console.log(`[checklist] vacancy ${vacancyId} — ${passedCount}/${output.length} checks passed`);

  // Auto-skip jobs that failed the Language requirements or Country check
  const autoSkipLabels = ['Language requirements', 'Country'];
  const failedAutoSkip = output.find(r => autoSkipLabels.includes(r.label) && !r.passed);
  if (failedAutoSkip) {
    const current = db.prepare('SELECT status FROM vacancies WHERE id = ?').get(vacancyId);
    if (current && current.status === 'new') {
      db.prepare("UPDATE vacancies SET status = 'auto_skip' WHERE id = ?").run(vacancyId);
      console.log(`[checklist] vacancy ${vacancyId} auto-skipped (${failedAutoSkip.label} failed)`);
    }
  }

  emit({
    type: "match",
    id: matchId,
    url: vacancy.url || `vacancy #${vacancyId}`,
    status: "ok",
    detail: `${passedCount}/${output.length} passed`
  });

  return output;
}

/**
 * Run checklist for multiple vacancy IDs (in sequence).
 * @param {number[]} vacancyIds
 */
export async function runChecklistForVacancies(vacancyIds) {
  for (const id of vacancyIds) {
    try {
      await runChecklistForVacancy(id);
    } catch (err) {
      console.error(`[checklist] Failed for vacancy ${id}:`, err.message);
    }
  }
}

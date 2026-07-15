import Database from 'better-sqlite3';
import { config } from '../config.js';
import { DEFAULT_SYSTEM_PROMPT } from './llm.js';

let _db = null;

function getDb() {
  if (_db) return _db;

  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      email_subject TEXT NOT NULL DEFAULT '',
      email_from    TEXT NOT NULL DEFAULT '',
      processed_at  TEXT NOT NULL,
      vacancy_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS vacancies (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            INTEGER NOT NULL REFERENCES runs(id),
      url               TEXT NOT NULL,
      title             TEXT NOT NULL DEFAULT '',
      company           TEXT NOT NULL DEFAULT '',
      location          TEXT NOT NULL DEFAULT '',
      description       TEXT NOT NULL DEFAULT '',
      passed            INTEGER NOT NULL DEFAULT 0,
      must_include_hits TEXT NOT NULL DEFAULT '[]',
      must_exclude_hits TEXT NOT NULL DEFAULT '[]',
      location_match    INTEGER NOT NULL DEFAULT 1,
      status            TEXT NOT NULL DEFAULT 'new',
      matched_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      label         TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS checklist_results (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      vacancy_id   INTEGER NOT NULL REFERENCES vacancies(id),
      checklist_id INTEGER NOT NULL REFERENCES checklist_items(id),
      passed       INTEGER,
      reasoning    TEXT NOT NULL DEFAULT '',
      ran_at       TEXT
    );
  `);

  // Enforce at most one result row per (vacancy, checklist item) pair
  _db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_checklist_results_vacancy_item
    ON checklist_results (vacancy_id, checklist_id)
  `);

  // Migrate: add system_prompt column to checklist_items if missing (existing DBs)
  const ciCols = _db.prepare('PRAGMA table_info(checklist_items)').all().map(c => c.name);
  if (!ciCols.includes('system_prompt')) {
    _db.exec("ALTER TABLE checklist_items ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
  }

  // Migrate: add matched_at column to vacancies if missing (existing DBs)
  const vCols = _db.prepare('PRAGMA table_info(vacancies)').all().map(c => c.name);
  if (!vCols.includes('matched_at')) {
    _db.exec('ALTER TABLE vacancies ADD COLUMN matched_at TEXT');
  }

  // Seed default checklist items if none exist yet
  const itemCount = _db.prepare('SELECT COUNT(*) as n FROM checklist_items').get().n;
  if (itemCount === 0) {
    const seedItems = [
      {
        label: 'No hybrid',
        prompt: 'Check the job location and working mode. Does this job require any in-office or hybrid presence?'
      },
      {
        label: 'Language requirements',
        prompt: 'Does the job description require proficiency in a specific spoken language other than English (e.g. Dutch, French, German, Spanish)?'
      },
      {
        label: 'Seniority level',
        prompt: 'Is this role explicitly junior, entry-level, graduate, or intern level?'
      },
      {
        label: 'Role',
        prompt: `Does this job describe a pre-sales, solution engineering, or developer-advocacy role?

Roles that PASS this check (return passed=true):
- Presales Engineer / Pre-Sales Engineer
- Solution Engineer / Solutions Engineer
- Solutions Architect (customer-facing / pre-sales)
- Sales Engineer
- Developer Advocate / Developer Evangelist
- Developer Relations (DevRel)
- Technical Evangelist
- Field Engineer (customer-facing)

Return passed=true if the job title or primary responsibilities clearly match one of the above categories.
Return passed=false if it is a different kind of role — for example: pure software development, product management, pure sales (no technical component), HR, marketing, or support.`
      }
    ];
    const insert = _db.prepare('INSERT INTO checklist_items (label, prompt) VALUES (@label, @prompt)');
    for (const item of seedItems) {
      insert.run(item);
    }
  }

  // Migrate: add 'Role' checklist item if it doesn't exist yet (existing DBs with 3 seed items)
  const hasRoleItem = _db.prepare("SELECT id FROM checklist_items WHERE label = 'Role' LIMIT 1").get();
  if (!hasRoleItem) {
    _db.prepare('INSERT INTO checklist_items (label, prompt) VALUES (@label, @prompt)').run({
      label: 'Role',
      prompt: `Does this job describe a pre-sales, solution engineering, or developer-advocacy role?

Roles that PASS this check (return passed=true):
- Presales Engineer / Pre-Sales Engineer
- Solution Engineer / Solutions Engineer
- Solutions Architect (customer-facing / pre-sales)
- Sales Engineer
- Developer Advocate / Developer Evangelist
- Developer Relations (DevRel)
- Technical Evangelist
- Field Engineer (customer-facing)

Return passed=true if the job title or primary responsibilities clearly match one of the above categories.
Return passed=false if it is a different kind of role — for example: pure software development, product management, pure sales (no technical component), HR, marketing, or support.`
    });
  }

  // Migrate: add 'Skills' checklist item if it doesn't exist yet
  const hasSkillsItem = _db.prepare("SELECT id FROM checklist_items WHERE label = 'Skills' LIMIT 1").get();
  if (!hasSkillsItem) {
    _db.prepare('INSERT INTO checklist_items (label, prompt) VALUES (@label, @prompt)').run({
      label: 'Skills',
      prompt: `Evaluate whether the domain knowledge required by this job is a good fit for the candidate.

Rules — apply in this exact order:

1. If the job description mentions healthcare, medtech, digital health, pharma, clinical, or any health-related domain as a desired or required background → return passed=true immediately.

2. If the job requires strong or deep knowledge of SAP (any SAP product/module) OR the primary domain is financial services, banking, trading, or fintech → return passed=false.

3. Otherwise → return passed=true.

Focus on what domain expertise the role requires from the candidate, not just which industries the company operates in.`
    });
  }

  // Migrate: add 'Country' checklist item if it doesn't exist yet
  const hasCountryItem = _db.prepare("SELECT id FROM checklist_items WHERE label = 'Country' LIMIT 1").get();
  if (!hasCountryItem) {
    _db.prepare('INSERT INTO checklist_items (label, prompt) VALUES (@label, @prompt)').run({
      label: 'Country',
      prompt: `The candidate is based in Poland. Evaluate whether the job's remote-work location restrictions are compatible.

Return passed=true if any of the following apply:
- The job is fully remote with no country or region restriction
- The job explicitly allows remote work from Poland
- The job allows remote work from EMEA (Poland is in EMEA)
- The job allows remote work from Europe
- No geographic restriction on remote work is mentioned at all

Return passed=false if any of the following apply:
- Remote work is restricted to a specific country other than Poland (e.g. "remote in the US only", "must be based in Germany")
- Remote work is restricted to a region that excludes Poland (e.g. "remote in North America only", "US/Canada only")
- The listing implies the candidate must reside in a country other than Poland even without stating it explicitly (e.g. lists only non-Polish office locations with no remote option)

When in doubt — for example if the location field just says a city or country with no explicit remote policy — return passed=false.`
    });
  }

  return _db;
}

const insertRunStmt = () =>
  getDb().prepare(
    `INSERT INTO runs (email_subject, email_from, processed_at, vacancy_count)
     VALUES (@email_subject, @email_from, @processed_at, @vacancy_count)`
  );

const insertVacancyStmt = () =>
  getDb().prepare(
    `INSERT INTO vacancies
       (run_id, url, title, company, location, description,
        passed, must_include_hits, must_exclude_hits, location_match, status, matched_at)
     VALUES
       (@run_id, @url, @title, @company, @location, @description,
        @passed, @must_include_hits, @must_exclude_hits, @location_match, @status, @matched_at)`
  );

export function vacancyExistsByUrl(url) {
  return !!getDb().prepare('SELECT 1 FROM vacancies WHERE url = ? LIMIT 1').get(url);
}

export function getVacancyByUrl(url) {
  return getDb().prepare('SELECT id, status FROM vacancies WHERE url = ? LIMIT 1').get(url) || null;
}

/**
 * Find the most-recently dismissed vacancy (ignore/wont_apply) with the same
 * company + title (case-insensitive). Used to detect reposts with new URLs.
 */
export function getDismissedByTitleCompany(title, company) {
  if (!title || !company) return null;
  return getDb().prepare(`
    SELECT id, status FROM vacancies
    WHERE lower(trim(title)) = lower(trim(?))
      AND lower(trim(company)) = lower(trim(?))
      AND status IN ('ignore', 'wont_apply')
    ORDER BY id DESC LIMIT 1
  `).get(title, company) || null;
}

export function insertRun({ emailSubject, emailFrom, processedAt, vacancyCount, results }) {
  const db = getDb();

  const run = db.transaction(() => {
    const { lastInsertRowid: runId } = insertRunStmt().run({
      email_subject: emailSubject || '',
      email_from: emailFrom || '',
      processed_at: processedAt,
      vacancy_count: vacancyCount
    });

    const vacancyIds = [];
    for (const vacancy of results) {
      const url = vacancy.url || '';
      const existing = url
        ? db.prepare('SELECT id FROM vacancies WHERE url = ? LIMIT 1').get(url)
        : null;
      if (existing) {
        vacancyIds.push(existing.id);
        continue;
      }
      const ev = vacancy.evaluation || {};
      const { lastInsertRowid: vacancyId } = insertVacancyStmt().run({
        run_id: runId,
        url,
        title: vacancy.title || '',
        company: vacancy.company || '',
        location: vacancy.location || '',
        description: vacancy.description || '',
        passed: ev.passed ? 1 : 0,
        must_include_hits: JSON.stringify(ev.mustIncludeHits || []),
        must_exclude_hits: JSON.stringify(ev.mustExcludeHits || []),
        location_match: ev.locationMatch ? 1 : 0,
        status: 'new',
        matched_at: processedAt || new Date().toISOString()
      });
      vacancyIds.push(vacancyId);
    }

    return { runId, vacancyIds };
  });

  return run();
}

export { getDb };

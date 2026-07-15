import express from 'express';
import fs from 'node:fs';
import { getDb, insertRun } from '../lib/db.js';
import { runChecklistForVacancy, runChecklistForVacancies } from '../lib/runChecklist.js';
import { DEFAULT_SYSTEM_PROMPT } from '../lib/llm.js';
import { fetchLinkedInJobHtml } from '../lib/linkedin.js';
import { normalizeJobUrl } from '../lib/extractVacancies.js';
import { config } from '../config.js';
import { subscribe } from '../lib/eventBus.js';
import { processEmail } from '../services/processEmail.js';
import { fetchVacancyEmails } from '../lib/gmail.js';

const router = express.Router();

const VALID_STATUSES = ['new', 'wont_apply', 'applied', 'ignore', 'auto_skip'];

// ─── Server-Sent Events (debug bar feed) ──────────────────────────────────────

router.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Keep-alive ping every 25 s
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  const unsubscribe = subscribe(send);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────

router.get('/jobs', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        v.id, v.run_id, v.url, v.title, v.company, v.location,
        v.description, v.passed, v.must_include_hits, v.must_exclude_hits,
        v.location_match, v.status, v.matched_at,
        r.email_subject, r.email_from, r.processed_at,
        COALESCE(cs.pass_count, 0) AS checklist_passed,
        COALESCE(cs.total_count, 0) AS checklist_total,
        cs.latest_ran_at,
        lang.passed AS lang_check_passed
      FROM vacancies v
      JOIN runs r ON r.id = v.run_id
      LEFT JOIN (
        SELECT vacancy_id,
          SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS pass_count,
          COUNT(*) AS total_count,
          MAX(ran_at) AS latest_ran_at
        FROM checklist_results
        GROUP BY vacancy_id
      ) cs ON cs.vacancy_id = v.id
      LEFT JOIN (
        SELECT cr.vacancy_id, cr.passed
        FROM checklist_results cr
        JOIN checklist_items ci ON ci.id = cr.checklist_id
        WHERE ci.label = 'Language requirements'
      ) lang ON lang.vacancy_id = v.id
      ORDER BY
        CASE WHEN cs.total_count > 0 AND cs.pass_count = cs.total_count THEN 0 ELSE 1 END ASC,
        v.id DESC
    `).all();

    const jobs = rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      url: r.url,
      title: r.title,
      company: r.company,
      location: r.location,
      description: r.description,
      passed: r.passed === 1,
      mustIncludeHits: JSON.parse(r.must_include_hits || '[]'),
      mustExcludeHits: JSON.parse(r.must_exclude_hits || '[]'),
      locationMatch: r.location_match === 1,
      status: r.status || 'new',
      emailSubject: r.email_subject,
      processedAt: r.processed_at,
      matchedAt: r.matched_at || r.latest_ran_at || null,
      checklistPassed: r.checklist_passed,
      checklistTotal: r.checklist_total,
      langFailed: r.lang_check_passed === 0
    }));

    return res.json(jobs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/jobs/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const db = getDb();
    const result = db.prepare('UPDATE vacancies SET status = ? WHERE id = ?').run(status, id);
    if (result.changes === 0) return res.status(404).json({ error: 'Job not found' });

    return res.json({ ok: true, id, status });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Manual job add ───────────────────────────────────────────────────────────

router.post('/jobs/add', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }
    const trimmed = url.trim();
    const lc = trimmed.toLowerCase();
    if (!lc.includes('linkedin.com/jobs') && !lc.includes('linkedin.com/comm/jobs')) {
      return res.status(400).json({ error: 'URL must be a LinkedIn Jobs link' });
    }

    const normalizedUrl = normalizeJobUrl(trimmed) || trimmed;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM vacancies WHERE url = ? LIMIT 1').get(normalizedUrl);
    if (existing) {
      return res.status(409).json({ error: 'Job already added' });
    }

    const details = await fetchLinkedInJobHtml(trimmed);

    const { vacancyIds } = insertRun({
      emailSubject: 'Manual add',
      emailFrom: '',
      processedAt: new Date().toISOString(),
      vacancyCount: 1,
      results: [{ ...details, evaluation: { passed: true } }]
    });

    const vacancyId = vacancyIds[0];

    // Run checklist in background
    if (vacancyId) {
      runChecklistForVacancies([vacancyId]).catch((err) =>
        console.error('[checklist] Background run failed:', err.message)
      );
    }

    const row = db.prepare(`
      SELECT
        v.id, v.run_id, v.url, v.title, v.company, v.location,
        v.description, v.passed, v.must_include_hits, v.must_exclude_hits,
        v.location_match, v.status, v.matched_at,
        r.email_subject, r.email_from, r.processed_at,
        COALESCE(cs.pass_count, 0) AS checklist_passed,
        COALESCE(cs.total_count, 0) AS checklist_total,
        cs.latest_ran_at
      FROM vacancies v
      JOIN runs r ON r.id = v.run_id
      LEFT JOIN (
        SELECT vacancy_id,
          SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS pass_count,
          COUNT(*) AS total_count,
          MAX(ran_at) AS latest_ran_at
        FROM checklist_results
        GROUP BY vacancy_id
      ) cs ON cs.vacancy_id = v.id
      WHERE v.id = ?
    `).get(vacancyId);

    return res.status(201).json({
      id: row.id,
      runId: row.run_id,
      url: row.url,
      title: row.title,
      company: row.company,
      location: row.location,
      description: row.description,
      passed: row.passed === 1,
      mustIncludeHits: JSON.parse(row.must_include_hits || '[]'),
      mustExcludeHits: JSON.parse(row.must_exclude_hits || '[]'),
      locationMatch: row.location_match === 1,
      status: row.status || 'new',
      emailSubject: row.email_subject,
      processedAt: row.processed_at,
      matchedAt: row.matched_at || row.latest_ran_at || null,
      checklistPassed: row.checklist_passed,
      checklistTotal: row.checklist_total
    });
  } catch (err) {
    console.error('[jobs/add]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Reparse job ─────────────────────────────────────────────────────────────

router.post('/jobs/:id/reparse', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const row = db.prepare('SELECT url FROM vacancies WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Job not found' });

    const details = await fetchLinkedInJobHtml(row.url);

    db.prepare(`
      UPDATE vacancies
      SET title = @title, company = @company, location = @location,
          description = @description
      WHERE id = @id
    `).run({
      id,
      title: details.title || '',
      company: details.company || '',
      location: details.location || '',
      description: details.description || ''
    });

    const updated = db.prepare(`
      SELECT
        v.id, v.run_id, v.url, v.title, v.company, v.location,
        v.description, v.passed, v.must_include_hits, v.must_exclude_hits,
        v.location_match, v.status, v.matched_at,
        r.email_subject, r.email_from, r.processed_at,
        COALESCE(cs.pass_count, 0) AS checklist_passed,
        COALESCE(cs.total_count, 0) AS checklist_total,
        cs.latest_ran_at
      FROM vacancies v
      JOIN runs r ON r.id = v.run_id
      LEFT JOIN (
        SELECT vacancy_id,
          SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS pass_count,
          COUNT(*) AS total_count,
          MAX(ran_at) AS latest_ran_at
        FROM checklist_results
        GROUP BY vacancy_id
      ) cs ON cs.vacancy_id = v.id
      WHERE v.id = ?
    `).get(id);

    return res.json({
      id: updated.id,
      runId: updated.run_id,
      url: updated.url,
      title: updated.title,
      company: updated.company,
      location: updated.location,
      description: updated.description,
      passed: updated.passed === 1,
      mustIncludeHits: JSON.parse(updated.must_include_hits || '[]'),
      mustExcludeHits: JSON.parse(updated.must_exclude_hits || '[]'),
      locationMatch: updated.location_match === 1,
      status: updated.status || 'new',
      emailSubject: updated.email_subject,
      processedAt: updated.processed_at,
      matchedAt: updated.matched_at || updated.latest_ran_at || null,
      checklistPassed: updated.checklist_passed,
      checklistTotal: updated.checklist_total
    });
  } catch (err) {
    console.error('[jobs/reparse]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Checklist: default system prompt ────────────────────────────────────────

// GET /api/checklist/default-system-prompt
router.get('/checklist/default-system-prompt', (req, res) => {
  res.json({ systemPrompt: DEFAULT_SYSTEM_PROMPT });
});

// ─── Checklist items ──────────────────────────────────────────────────────────

router.get('/checklist/items', (req, res) => {
  try {
    const db = getDb();
    const items = db.prepare(
      'SELECT id, label, prompt, system_prompt, enabled, created_at FROM checklist_items ORDER BY id ASC'
    ).all();
    return res.json(items.map((i) => ({ ...i, enabled: i.enabled === 1 })));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/checklist/items', (req, res) => {
  try {
    const { label, prompt, system_prompt } = req.body;
    if (!label || !prompt) return res.status(400).json({ error: 'label and prompt are required' });

    const db = getDb();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO checklist_items (label, prompt, system_prompt) VALUES (@label, @prompt, @system_prompt)')
      .run({
        label: String(label).trim(),
        prompt: String(prompt).trim(),
        system_prompt: String(system_prompt || '').trim()
      });

    const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(lastInsertRowid);
    return res.status(201).json({ ...item, enabled: item.enabled === 1 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/checklist/items/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Check not found' });

    const label         = req.body.label         !== undefined ? String(req.body.label).trim()         : existing.label;
    const prompt        = req.body.prompt        !== undefined ? String(req.body.prompt).trim()        : existing.prompt;
    const system_prompt = req.body.system_prompt !== undefined ? String(req.body.system_prompt).trim() : existing.system_prompt;
    const enabled       = req.body.enabled       !== undefined ? (req.body.enabled ? 1 : 0)            : existing.enabled;

    db.prepare(
      'UPDATE checklist_items SET label = @label, prompt = @prompt, system_prompt = @system_prompt, enabled = @enabled WHERE id = @id'
    ).run({ label, prompt, system_prompt, enabled, id });

    const updated = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
    return res.json({ ...updated, enabled: updated.enabled === 1 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/checklist/items/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    db.prepare('DELETE FROM checklist_results WHERE checklist_id = ?').run(id);
    const result = db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Check not found' });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Checklist results ────────────────────────────────────────────────────────

router.get('/checklist/results/:vacancyId', (req, res) => {
  try {
    const vacancyId = Number(req.params.vacancyId);
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        cr.id, cr.vacancy_id, cr.checklist_id, cr.passed, cr.reasoning, cr.ran_at,
        ci.label, ci.prompt, ci.system_prompt, ci.enabled
      FROM checklist_results cr
      JOIN checklist_items ci ON ci.id = cr.checklist_id
      WHERE cr.vacancy_id = ?
      ORDER BY ci.id ASC
    `).all(vacancyId);

    return res.json(rows.map((r) => ({
      id: r.id,
      vacancyId: r.vacancy_id,
      checklistId: r.checklist_id,
      label: r.label,
      prompt: r.prompt,
      systemPrompt: r.system_prompt,
      passed: r.passed === 1,
      reasoning: r.reasoning,
      ranAt: r.ran_at
    })));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/checklist/stats', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        ci.id,
        SUM(CASE WHEN cr.passed = 1 THEN 1 ELSE 0 END) AS pass_count,
        SUM(CASE WHEN cr.passed = 0 THEN 1 ELSE 0 END) AS fail_count
      FROM checklist_items ci
      LEFT JOIN checklist_results cr ON cr.checklist_id = ci.id
      GROUP BY ci.id
    `).all();
    const map = {};
    for (const r of rows) map[r.id] = { pass: r.pass_count, fail: r.fail_count };
    return res.json(map);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/checklist/run/:vacancyId', async (req, res) => {
  try {
    const vacancyId = Number(req.params.vacancyId);
    const results = await runChecklistForVacancy(vacancyId);
    const provider = (process.env.LLM_PROVIDER || 'opencode').toLowerCase();
    const model = provider === 'mock' ? null : (process.env.OPENCODE_MODEL || 'github-copilot/gpt-4.1');
    let quickMode = false;
    try {
      if (fs.existsSync(config.settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(config.settingsPath, 'utf8'));
        quickMode = settings.quickMode === true;
      }
    } catch { /* ignore */ }
    return res.json({ ok: true, vacancyId, results, model, provider, quickMode });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// ─── Settings helpers ─────────────────────────────────────────────────────────

function loadSettings() {
  try {
    if (fs.existsSync(config.settingsPath)) {
      return JSON.parse(fs.readFileSync(config.settingsPath, 'utf8'));
    }
  } catch {}
  return {};
}

function saveSettings(data) {
  fs.writeFileSync(config.settingsPath, JSON.stringify(data, null, 2), 'utf8');
}
// ─── Settings: LinkedIn cookies ──────────────────────────────────────────────

router.get('/settings/cookies', (_req, res) => {
  try {
    if (!fs.existsSync(config.sessionPath)) return res.json({ set: false, count: 0, cookieString: '' });
    const session = JSON.parse(fs.readFileSync(config.sessionPath, 'utf8'));
    const cookies = Array.isArray(session.cookies) ? session.cookies : [];
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    return res.json({ set: cookies.length > 0, count: cookies.length, cookieString });
  } catch {
    return res.json({ set: false, count: 0, cookieString: '' });
  }
});

router.post('/settings/cookies', (req, res) => {
  try {
    const { cookies } = req.body;
    if (!cookies || typeof cookies !== 'string') {
      return res.status(400).json({ error: 'cookies string is required' });
    }

    let parsedCookies;
    const trimmed = cookies.trim();

    try {
      const obj = JSON.parse(trimmed);
      if (Array.isArray(obj)) {
        parsedCookies = obj;
      } else if (obj && Array.isArray(obj.cookies)) {
        parsedCookies = obj.cookies;
      } else {
        return res.status(400).json({ error: 'Unrecognized JSON format. Expected an array of cookies or a Playwright storageState object.' });
      }
    } catch {
      // Fall back to raw cookie header string: name=value; name2=value2
      parsedCookies = trimmed.split(';').map((part) => {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) return null;
        return {
          name: part.slice(0, eqIdx).trim(),
          value: part.slice(eqIdx + 1).trim(),
          domain: '.linkedin.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: 'None'
        };
      }).filter(Boolean);

      if (parsedCookies.length === 0) {
        return res.status(400).json({ error: 'Could not parse cookies. Paste JSON from Cookie-Editor or a raw cookie header string.' });
      }
    }

    const normalized = parsedCookies.map((c) => ({
      name: String(c.name || ''),
      value: String(c.value || ''),
      domain: String(c.domain || '.linkedin.com'),
      path: String(c.path || '/'),
      expires: typeof c.expirationDate === 'number' ? c.expirationDate
             : typeof c.expires === 'number' ? c.expires
             : -1,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite || 'None'
    })).filter((c) => c.name);

    if (normalized.length === 0) {
      return res.status(400).json({ error: 'No valid cookies found in the pasted data.' });
    }

    const storageState = { cookies: normalized, origins: [] };
    fs.writeFileSync(config.sessionPath, JSON.stringify(storageState, null, 2), 'utf8');
    return res.json({ ok: true, count: normalized.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/settings/cookies', (_req, res) => {
  try {
    if (fs.existsSync(config.sessionPath)) fs.unlinkSync(config.sessionPath);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Settings: Proxy ──────────────────────────────────────────────────────────

router.get('/settings/proxy', (_req, res) => {
  const settings = loadSettings();
  const proxy = settings.proxy || null;
  return res.json({ set: !!proxy, proxy });
});

router.post('/settings/proxy', (req, res) => {
  try {
    const { server, username, password } = req.body;
    if (!server || typeof server !== 'string') {
      return res.status(400).json({ error: 'server is required (host:port)' });
    }
    const normalized = server.trim().startsWith('http') ? server.trim() : `http://${server.trim()}`;
    const proxy = { server: normalized };
    if (username) proxy.username = String(username).trim();
    if (password) proxy.password = String(password).trim();

    const settings = loadSettings();
    settings.proxy = proxy;
    saveSettings(settings);
    return res.json({ ok: true, proxy });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/settings/proxy', (_req, res) => {
  try {
    const settings = loadSettings();
    delete settings.proxy;
    saveSettings(settings);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Settings: Debug mode ─────────────────────────────────────────────────────

router.get('/settings/debug', (_req, res) => {
  const settings = loadSettings();
  return res.json({ debug: settings.debug === true });
});

router.post('/settings/debug', (req, res) => {
  try {
    const { debug } = req.body;
    if (typeof debug !== 'boolean') {
      return res.status(400).json({ error: 'debug must be a boolean' });
    }
    const settings = loadSettings();
    settings.debug = debug;
    saveSettings(settings);
    return res.json({ ok: true, debug });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Settings: Quick mode ───────────────────────────────────────────────────

router.get('/settings/quick-mode', (_req, res) => {
  const settings = loadSettings();
  return res.json({ quickMode: settings.quickMode === true });
});

router.post('/settings/quick-mode', (req, res) => {
  try {
    const { quickMode } = req.body;
    if (typeof quickMode !== 'boolean') {
      return res.status(400).json({ error: 'quickMode must be a boolean' });
    }
    const settings = loadSettings();
    settings.quickMode = quickMode;
    saveSettings(settings);
    return res.json({ ok: true, quickMode });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Gmail fetch ──────────────────────────────────────────────────────────────

// Shared fetch+process logic — used by the route handler and the hourly scheduler.
export async function gmailFetchAndProcess(query) {
  const emails = await fetchVacancyEmails(query);
  if (!emails.length) {
    return { processed: 0, totalVacancies: 0, emails: [] };
  }
  const results = [];
  for (const email of emails) {
    const result = await processEmail(email);
    results.push(result);
  }
  const totalVacancies = results.reduce((sum, r) => sum + (r.vacancyCount || 0), 0);
  const emailSummaries = results.map((r) => ({
    subject: r.emailSubject || '(no subject)',
    vacancyCount: r.vacancyCount || 0
  }));
  return { processed: emails.length, totalVacancies, emails: emailSummaries };
}

// POST /api/gmail/fetch
// Body (optional): { query: "<gmail search query>" }
// Fetches emails via Gmail API (OAuth2) and processes each through processEmail().
router.post('/gmail/fetch', async (req, res) => {
  if (!config.gmailUser || !config.gmailAppPassword) {
    return res.status(400).json({
      error: 'Gmail credentials not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env'
    });
  }
  try {
    const query = typeof req.body?.query === 'string' ? req.body.query : undefined;
    const result = await gmailFetchAndProcess(query);
    if (!result.processed) {
      return res.json({ ok: true, processed: 0, totalVacancies: 0, message: 'No emails found' });
    }
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export { router as apiRouter };

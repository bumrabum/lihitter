# lihitter — Agent Knowledge Base

## Project Overview

Node.js app that processes LinkedIn job digest emails, evaluates vacancies against user-defined rules, and stores/displays results. Stack: Express, better-sqlite3, node-html-parser. Job pages are fetched over plain HTTPS — no browser/Playwright.

## Key Files

| File                          | Purpose                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/lib/linkedin.js`         | `fetchLinkedInJobHtml` — plain HTTPS GET of the public page → Voyager API fallback                               |
| `src/lib/extractVacancies.js` | Extracts job URLs from email, normalises all to `https://www.linkedin.com/jobs/view/{id}/` via `normalizeJobUrl` |
| `src/lib/parseJobHtml.js`     | HTML parser for LinkedIn job pages — handles authenticated SPA and public static pages                           |

| `src/services/processEmail.js` | Email processing pipeline — calls `extractVacancyLinks` → `fetchLinkedInJobHtml` → `evaluateVacancy` |
| `src/lib/rules.js` | Rule evaluation engine |
| `src/lib/db.js` | SQLite persistence via better-sqlite3 |
| `src/config.js` | Centralised config — reads `.env`, `settings.json`, `session.json` paths |

## Debug Bar (`src/public/index.html`)

A fixed bar at the bottom of the Jobs page logs every key operation in real time. It collapses to a 38 px strip and expands to a scrollable log. Each entry shows **timestamp · type · URL/command · result**.

| Type      | Colour | Trigger                                                                                                                                                                                            | Result shown                                   |
| --------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `parse`   | blue   | Add Job button (manual URL add)                                                                                                                                                                    | job title on success, error message on failure |
| `reparse` | purple | Reparse button on any table row                                                                                                                                                                    | job title on success, error message on failure |
| `match`   | green  | Opening the Rules Match drawer tab                                                                                                                                                                 | `loaded` on success                            |
| `rematch` | amber  | Re-run checks button — **one summary entry** (job URL → `X/Y passed`) plus **one entry per `opencode run` invocation** (`opencode run --model <model> --format json` → `✓/✗ <label>: <reasoning>`) |

The model name for `rematch` entries comes from `POST /api/checklist/run/:vacancyId` which now returns `{ model, provider }` alongside `results`. If `LLM_PROVIDER=mock`, the command column shows `mock (no CLI)`. Default model is `github-copilot/gpt-4.1`; override with `OPENCODE_MODEL` in `.env`.

## Run / Test Commands

```
npm run dev          # start server with --watch
npm run test         # all tests
npm run test:parser  # parseJobHtml.test.js only
```

## LinkedIn URL Formats

Email job digest links use the `/comm/` path with auth tokens:

```
https://www.linkedin.com/comm/jobs/view/{id}?otpToken=...&trackingId=...
```

**Public canonical form** (no auth required, works in incognito):

```
https://www.linkedin.com/jobs/view/{id}/
```

Conversion: extract numeric job ID from any LinkedIn job URL, build `https://www.linkedin.com/jobs/view/{id}/`.

`extractJobId` regex in `linkedin.js`:

```js
url.match(/\/jobs\/(?:view|search)\/(\d+)/);
```

This already handles both `/jobs/` and `/comm/jobs/` paths.

## Public Page Fetching — Confirmed Working (April 2026)

LinkedIn public job pages (`/jobs/view/{id}/`) are **server-side rendered** and return full HTML via a plain HTTPS GET — no auth, no browser needed.

### Approach

- Plain `https.get` with browser-like User-Agent
- HTTP 200, ~230 KB HTML
- Full job description present in HTML (not JS-rendered)

### Confirmed DOM selectors for public pages (SSR static layout)

| Field       | Selector                                               |
| ----------- | ------------------------------------------------------ |
| Title       | `h1.top-card-layout__title` (also `h1.topcard__title`) |
| Company     | `a.topcard__org-name-link`                             |
| Location    | `span.topcard__flavor--bullet` (first match)           |
| Description | `.show-more-less-html__markup`                         |

These differ from the **authenticated SPA** selectors used after login:
| Field | selector |
|-------|----------|
| Title | `.job-details-jobs-unified-top-card__job-title h1` |
| Company | `.job-details-jobs-unified-top-card__company-name a` |
| Location | `.job-details-jobs-unified-top-card__primary-description-container` |
| Description | `.jobs-description-content__text` |

`parseJobHtml.js` already has both sets as ordered fallback arrays.

## Email Fetch Flow (implemented April 2026)

`fetchLinkedInJobHtml` in `src/lib/linkedin.js`:

1. Extract job ID from any LinkedIn job URL (handles `/comm/jobs/view/{id}?...` format)
2. Build public URL: `https://www.linkedin.com/jobs/view/{id}/`
3. Plain `https.get` — no cookies, no auth
4. Parse HTML with `parseLinkedInJobHtml` from `parseJobHtml.js`
5. If title + description both empty → fall back to Voyager internal API (requires session cookies)

`extractVacancyLinks` in `src/lib/extractVacancies.js`:

- All matched LinkedIn URLs are normalised to public canonical form via `normalizeJobUrl` before deduplication

## TODOs

See `TODO.md` for all open and completed tasks.

## Security Notes

- `session.json` (optional Voyager-fallback cookies) — never commit, already in `.gitignore`
- `.env` holds Gmail credentials — never commit
- `settings.json` may hold proxy credentials — never commit, already in `.gitignore`
- Webhook endpoints should validate `X-Webhook-Secret` header before processing

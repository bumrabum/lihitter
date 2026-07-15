# lihitter

LinkedIn job-alert triage bot. Reads LinkedIn job-alert emails from Gmail, fetches each vacancy from its public page (no LinkedIn login needed), scores it against your rules with an LLM, and shows results in a small web UI.

## How it works

1. Polls Gmail via IMAP every hour (plus on demand from the UI) for job-alert emails.
2. Extracts LinkedIn job links and fetches each public job page over plain HTTPS.
3. Evaluates the job against your rules/checklist via an LLM.
4. Stores everything in SQLite; review, apply, or dismiss jobs in the web UI.

## Quick start

```bash
cp .env.example .env   # fill in Gmail credentials (see below)
npm install
npm run dev
```

Open http://localhost:3001 — jobs viewer at `/`, checklist at `/checklist`, settings at `/settings`.

## Configuration

Everything lives in `.env` (see comments in `.env.example`). The essentials:

- **`GMAIL_USER` / `GMAIL_APP_PASSWORD`** — required. Use a Gmail App Password (Google Account → Security → App passwords), not your account password.
- **`GMAIL_QUERY`** — which emails to process, e.g. `from:linkedin newer_than:7d`.
- **LinkedIn credentials are not needed** — job pages are fetched publicly.
- **`APP_MODE=LOCAL`** disables basic auth for local dev; otherwise `AUTH_USER`/`AUTH_PASSWORD` protect the UI.

Optional `settings.json` (see `settings.example.json`) holds a proxy and UI toggles. Matching rules live in `rules.json` and the checklist UI.

## Tests

```bash
npm test
```

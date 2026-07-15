# TODO

## Open

## Done

- [x] Remove dead Playwright browser flow (`reviewLinkedInVacancy` / `reviewLinkedInVacancies`) and its test — runtime uses plain HTTPS fetch
- [x] Debug bar: show individual email subject lines in the `gmail` entry (currently shows only "3 emails, 23 jobs found" — expand to list each subject)
- [x] Server-side logging: add detailed logs for key operations (CLI commands launched, args, exit codes; HTTP fetch URLs; email processing steps) so server output is useful for debugging
- [x] Use GPT-4.1 for JD checklist match (free in GitHub Copilot)
- [x] Checklist items should reset when re-matching — e.g. `https://www.linkedin.com/jobs/view/4400233591/` shows 6/10 items although there are only 5 items
- [x] Bring green 100% match jobs to the top of the table
- [x] DATE MATCHED is empty in the jobs table

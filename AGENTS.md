# Context Guard development

- Read `docs/SPEC.md` and `CONTRIBUTING.md` before changing behavior.
- Use the code-review workflow by default for functional changes. Review Standards and Spec independently, using fresh review contexts, and fix blocking findings before completion.
- Pin the review base explicitly; `review-baseline` is the initial specification commit for this project.
- Run affected tests. Native and live tests require explicit environment settings; report skipped tests honestly.
- Never include personal session logs, recovery checkpoints, credentials, host modules or generated local bundles in commits/uploads.
- Back up valuable sessions independently before live recovery. Acceptance now requires continuing the affected conversation through real agent steps, not merely a recovery command or short reply. The owner authorizes resuming that task; once it runs successfully, leave the local agent running unless a concrete safety issue requires stopping it.
- The owner authorized public plugin-source publication under MIT. Keep publication limited to reviewed plugin files and history; other projects and private data remain excluded. Changes to licensing or publication scope require a separate user decision.

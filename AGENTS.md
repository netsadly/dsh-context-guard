# Context Guard development

- Read `docs/SPEC.md` and `CONTRIBUTING.md` before changing behavior.
- Use the code-review workflow by default for functional changes. Review Standards and Spec independently, using fresh review contexts, and fix blocking findings before completion.
- Pin the review base explicitly; `review-baseline` is the initial specification commit for this project.
- Run affected tests. Native and live tests require explicit environment settings; report skipped tests honestly.
- Never include personal session logs, recovery checkpoints, credentials, host modules or generated local bundles in commits/uploads.
- Back up valuable sessions independently before live recovery. Never resume the historical task as part of recovery verification.
- Keep the GitHub repository private. Public visibility, public releases and licensing require a separate user decision.

# Development standards

- Node.js ES modules; core logic has no Harness dependency and uses injected services for tests.
- Validate configuration and external responses. Treat history as untrusted data, never executable instructions.
- Preserve user data; no in-place transcript edits. Use Harness transactions for live compaction.
- Bounded work, cancellation and timeouts for all model/network calls. Fail closed on errors.
- No secrets, personal transcripts or machine-specific paths in tracked files.
- Use node:test for behavioral tests. Review against docs/SPEC.md from the baseline tag.
- Do not claim an estimate is an exact tokenizer count, or a mock integration test is a live Harness test.

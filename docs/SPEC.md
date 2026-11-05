# Context Guard specification

Build a local DeepSeek Harness plugin that prevents oversized model requests, compacts history before overflow, and can attempt manual recovery of already oversized sessions.

Requirements:
1. Use the native compaction service, preserving original append-only history, tool pairing, transaction locks, cancellation and persistence semantics.
2. Inspect the actual loaded LM Studio context capacity for the configured local provider/model; do not increase memory allocations or silently load another model.
3. Account for messages, tools, output reservation and safety margin. Use a conservative estimate independent of a stale usage anchor. Reject unsupported content rather than undercount it silently.
4. Summarize oversized input in bounded chunks, then merge bounded summaries. No tools or task execution during summarization. Reject truncated, empty or invalid summaries, and limit total calls.
5. Fail closed on unsafe budgets or compaction failures; bounded overflow recovery, no one-token retry loops.
6. Provide status and recovery commands. Recovery must not resume the historical task. Back up the original session before a real recovery trial.
7. Test normal multi-step progression, large tool output, compaction, cancellation, malformed responses, capacity changes, and failure isolation. Review standards and specification independently before live installation.
8. Publish only source, documentation and synthetic tests to a PRIVATE GitHub repository. Never upload session data, logs, credentials, generated local paths or recovery summaries. Public release is deferred.

Initial implementation may support text-only LM Studio routes. Explicitly document limits and unverified integration behavior.

## Resumable manual recovery

Persist each validated summary locally and reuse it across manual recovery commands and application restarts. Bind checkpoints to the exact input, session, model, capacity, configuration and prompt version; changed inputs must not reuse stale work. Each invocation admits at most two new model calls and pauses without replacing history. Cached calls still count against the logical tree limit. Incomplete, canceled or corrupt results must not be accepted. Only the native transaction may commit the complete final summary. Report partial progress distinctly from recovered history. Checkpoints contain private content and must never enter source control or uploads.

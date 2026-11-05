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
8. Publish only plugin source, documentation and synthetic tests. Never upload session data, logs, credentials, generated local paths or recovery summaries. The initial repository was private; the owner subsequently authorized public source publication under MIT, with the fresh-Windows validation gap disclosed.

Initial implementation may support text-only LM Studio routes. Explicitly document limits and unverified integration behavior.

## Resumable manual recovery

Persist each validated summary locally and reuse it across manual recovery commands and application restarts. Bind checkpoints to the exact input, session, model, capacity, configuration and prompt version; changed inputs must not reuse stale work. Each invocation admits at most two new model calls and pauses without replacing history. Cached calls still count against the logical tree limit. Incomplete, canceled or corrupt results must not be accepted. Only the native transaction may commit the complete final summary. Report partial progress distinctly from recovered history. Checkpoints contain private content and must never enter source control or uploads.

## Missing-section repair (2026-11-06)

If a complete summary omits a mandatory section, regenerate once from the original bounded source. Never append a fabricated `Failures: None`. Count repair against total and per-invocation limits, honor cancellation, and reject incomplete/invalid repair without committing history. Repair requests use the same bounded source and strengthened mandatory-section instructions. This is a bounded retry, not a guarantee that a local model always produces a valid summary.

Repair must change the corrective instructions while retaining original source, reserve space for either prompt, and include both prompts in checkpoint identity. Identical deterministic retries are insufficient.

## Live continuation acceptance
Default to independent Standards and Spec code-review. Acceptance requires the affected original conversation to resume real agent steps without context-guard failure. Do not stop a successfully running agent just to finish verification. Under hard budget pressure include completed balanced tool groups when retained results cause overflow; never split call/result pairs. Avoid repeatedly summarizing a checkpoint-only prefix. Proactive thresholds are not hard input limits; final request guarding stays mandatory.

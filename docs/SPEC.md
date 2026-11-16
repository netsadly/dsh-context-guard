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

## Local output ceiling (2026-11-14)

Treat configured outputTokens as the maximum agent output reservation for the guarded provider. Apply the same ceiling during pre-step pressure checks and agent request construction, including restored sessions with larger historical maxTokens. Preserve valid smaller requests, other providers, and original durable events. Final stream guarding must still budget the actual request; summary output remains separately bounded by summaryTokens.

## Non-reducing soft compaction (2026-11-15)

A native non-reducing-summary rejection before replacement may be treated as a no-op only for advisory pressure when a fresh measurement still fits the hard budget and cancellation has not occurred. Preserve the original history. Do not swallow other summary errors or actual provider overflow; the final request guard remains mandatory.

## Useful advisory compaction (2026-11-15)

Preserve all tools, model settings, output/safety budgets and final-stream checking. Before optional soft-pressure compaction, defer very small selected prefixes that are unlikely to repay a structured checkpoint. Remember an unchanged non-reducing span per session; do not regenerate it at every step. After successful compaction, wait for meaningful measured input growth before another optional attempt. The growth allowance scales with the current available input budget and is bounded. Hard pressure or a provider-confirmed overflow bypasses all these deferrals.

All decisions still re-query the actual loaded model context. Deferral identities must distinguish route, capacity, output budget and surface replacement generation; a changed capacity must not reuse old soft-pressure decisions. Do not change the loaded model to test adaptation: exercise capacity changes with injected responses and final request guards, and perform real multi-turn tool tests at the user's actual loaded capacity. Record comparable fresh-session task timings, actual tool definitions and compaction attempts before and after, excluding human inter-turn delay. Keep failed and interrupted trials separately identified.

## Task provenance and stalled work (2026-11-15)

Preserve the current model, MTP, loaded context, tool registry and durable events. Derive task reminders only from actual human-origin durable messages, never runtime notices or checkpoints. A short continuation must not turn incidental files or prior assistant plans into new user goals. Keep reminders bounded, count them before admission and in the final request, and avoid appending duplicates while one remains active.

Exclude hidden reasoning and recurring runtime notices from summary input. Ground each bounded chunk/merge in original human request excerpts. Enforce a 1400-character checkpoint maximum and reject leaked checkpoint-format requirements in Constraints unless supported by human requests. Allow one bounded repair, preserve cancellation/call accounting, and isolate old cached summaries with a new prompt identity.

If three identical read-only tool calls return identical results within the last eight results, or two token-exhausted turns produce no visible text since the latest substantive request/completed turn, stop spending on that loop. Produce one bounded, explicitly labeled stage answer from attributed evidence using the same local model without tools or thinking for that call only. Keep the normal tool registry and selected reasoning level intact for later work. A new substantive user request resets detection. Bound finalization time and report inability to answer rather than fabricate success; cancellation must still cancel. This is an automatic stop-loss, not a proof that arbitrary reasoning cannot drift.

Validate actual host configuration-only agent/request semantics, large-history finalization before normal compaction, new-task restoration, source provenance, summary repairs, and the captured long-research failure pattern. Compare reasoning levels at fixed settings and distinguish transport of a selected value from demonstrated model behavior.

## Current system instructions during finalization (2026-11-16)

Preserve every system message from the current effective request, in order, when constructing a stalled-work stage answer. Do not resurrect obsolete system messages from durable history, mutate the request, or truncate the preset to make it fit. Count the preserved instructions in the final request budget and fail closed if they exceed it. Finalization guidance supplements the current persona, tone and language instructions. Keep the model, MTP, context capacity, registered tools and original events unchanged. Validate repeated native compaction, a stage answer and subsequent real tool use with an existing user-selected preset; synthetic checks alone do not establish live role adherence.

Healthy overlapping tokenizer requests may wait serially within their existing timeout, with at most four waiting callers and one actual RPC. A cancelled/timed-out in-flight RPC must retain its lock until settlement; do not add another RPC behind an abandoned request. Waiting cancellation must not start a new RPC.

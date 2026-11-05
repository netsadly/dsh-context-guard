# Private validation record

Environment: DeepSeek Harness 0.2.1-rc.5, LM Studio SDK 1.5.0, local text model loaded with a 30,208-token context. This is a version-specific experimental build, not a public release.

## Findings

- The loaded context was much smaller than the model's advertised maximum. Oversized history and a near-zero output allowance made repeated continuation fail.
- Native compaction defaults did not fit this small loaded context.
- The native adapter did not forward the requested disabled-thinking setting for summaries. The compaction-only local transport explicitly sends the corresponding settings and rejects incomplete output.
- Native patch entries use names as matching guards: replacing the service requires disabling the original and inserting a new entry.
- Desktop manual commands were observed to abort at approximately five minutes. A plugin timeout of 600 seconds does not override that host deadline. Long summaries caused recovery attempts to roll back. The final prompt asks for compact English checkpoints while retaining original identifiers and paths.

## Automated checks

- Full suite with matching native modules: 24 passed, 1 opt-in live test skipped, 0 failed.
- Syntax checks and git whitespace checks passed.
- Native tests exercise actual session/compaction and patch code with simulated maintenance and persistence. They are not a substitute for desktop acceptance.
- The opt-in synthetic live-model checkpoint test was then run separately against the final prompt: 1 passed, 0 failed (about 6.6 seconds). Thus all 25 distinct test cases passed across these two runs. Desktop recovery acceptance is recorded below separately.

## Initial desktop acceptance (before resumable recovery)

- Installed and enabled the generated local bundle through Harness. The status command returned the actual 30,208-token loaded capacity, 8,192 output reservation, 19,968 available input budget and 15,974 proactive trigger.
- Recovery of the large historical session **did not succeed**. The final attempt completed six local summary calls, started another call, then was canceled by the desktop command deadline. No new replacement summary was committed. Do not describe this session as rescued.
- Read-back verification after the failed attempt found all 440 original events unchanged and in order. The effective message count remained 48. The padded tokenizer estimate was unchanged at 81,598 before and after; this is not an exact provider-template count.
- The independently saved original backup is retained locally. Attempt markers appended by Harness explain the larger event-log count; they are not replacement history.
- A post-recovery reply test was intentionally not run because recovery had not succeeded. The original task was never resumed during acceptance.
- These failures motivated the resumable checkpoint workflow subsequently implemented and tested below.

## Resumable recovery acceptance — 2026-11-06

- Installed the updated local bundle. Three manual invocations paused normally, reporting saved/reused checkpoints of 2/0, 1/2 and 2/3. No partial replacement was committed.
- Exited and restarted Harness while paused. The next invocation reused persisted work and completed successfully: **46 history items recovered**. The historical task was not resumed.
- Disk read-back verified all **440 original events** unchanged and in order. Effective messages fell from **48 to 3**. Padded tokenizer estimates fell from **81,598 to 9,724**, below the 19,968 input budget. These are padded estimates, not exact provider-template counts.
- Post-recovery desktop reply acceptance passed in **26 seconds**, returning exactly the requested short confirmation. The new turn ended normally and its event log contained **zero tool calls**. No historical task was resumed.
- Latest non-live suite: **29 passed, 1 opt-in live test skipped, 0 failed**. It includes durable restart reuse, cancellation, corruption, logical call limits, nested overflow subdivision and native paused/final transaction behavior. The synthetic live test is run separately from desktop recovery to avoid model contention.
- Final synthetic live-model test subsequently passed separately in about **6.6 seconds**. Across these runs, all **30 distinct test cases** passed; desktop recovery and reply acceptance are additional checks.
- Standards review found no blocking violation; its bounded-read robustness suggestion was implemented. Spec review found nested overflow could consume every invocation without advancing; persisted subdivision markers and a regression test fixed it, and re-review passed.
- Source/history file lists were checked: only plugin source, configuration, documentation and synthetic tests are included. Private checkpoints, session logs, generated local paths, backups and other projects are excluded. Repository visibility remains private.

## Review and limitations

Standards and Spec were reviewed separately. Blocking findings were fixed with regression coverage for terminal stream detection, cancellation, pending-message accounting, import generation, tokenizer single-flight behavior and native bundle patching.

Text-only and local-provider scope remains intentional. Token counts include conservative padding but are not exact provider chat-template accounting. Summaries are lossy; structure validation cannot prove factual completeness. Original session events and an independent local backup remain the authority. Private logs, backups and generated installation files are excluded from this repository.

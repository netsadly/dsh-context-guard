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

## Desktop acceptance

- Installed and enabled the generated local bundle through Harness. The status command returned the actual 30,208-token loaded capacity, 8,192 output reservation, 19,968 available input budget and 15,974 proactive trigger.
- Recovery of the large historical session **did not succeed**. The final attempt completed six local summary calls, started another call, then was canceled by the desktop command deadline. No new replacement summary was committed. Do not describe this session as rescued.
- Read-back verification after the failed attempt found all 440 original events unchanged and in order. The effective message count remained 48. The padded tokenizer estimate was unchanged at 81,598 before and after; this is not an exact provider-template count.
- The independently saved original backup is retained locally. Attempt markers appended by Harness explain the larger event-log count; they are not replacement history.
- A post-recovery reply test was intentionally not run because recovery had not succeeded. The original task was never resumed during acceptance.
- Reliable recovery of records this large needs a future resumable checkpoint workflow or a supported host command with a longer deadline. That feature is not implemented in this build.

## Review and limitations

Standards and Spec were reviewed separately. Blocking findings were fixed with regression coverage for terminal stream detection, cancellation, pending-message accounting, import generation, tokenizer single-flight behavior and native bundle patching.

Text-only and local-provider scope remains intentional. Token counts include conservative padding but are not exact provider chat-template accounting. Summaries are lossy; structure validation cannot prove factual completeness. Original session events and an independent local backup remain the authority. Private logs, backups and generated installation files are excluded from this repository.

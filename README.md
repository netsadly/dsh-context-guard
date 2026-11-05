# dsh-context-guard

[中文介绍、安装教程与使用说明](README.zh-CN.md) · [开源声明](docs/OPEN_SOURCE_STATEMENT.zh-CN.md)

Framework designed by the author **netsadly**; implementation code written by **GPT Astra**. This is an independent community project, not an official DeepSeek, LM Studio or OpenAI product. Only this plugin's source, documentation and synthetic tests are published; the author's other projects and private data are excluded. The plugin is licensed under the [MIT License](LICENSE), copyright (c) 2026 netsadly. See [third-party license notes](THIRD_PARTY_NOTICES.md) for dependencies. The package remains npm-private to prevent accidental registry publication; this does not restrict the MIT license.

Experimental MIT-licensed context guard for **DeepSeek Harness 0.2.1-rc.5 + LM Studio**. This source release replaces the native `compaction-basic` service while retaining its transactional session replacement machinery.

## What it does

- Queries the exact **already loaded** model's context capacity before requests; does not load models.
- Uses LM Studio's tokenizer on serialized messages and tools, adds 10%, 32 tokens per message and 512 framing tokens, and takes the larger value alongside Harness's meter.
- Reserves the requested output budget plus 2,048 safety tokens. Triggers compaction at 80% of the remaining input budget.
- Keeps a recent tail and native tool-call/result boundaries. Large histories are summarized in bounded chunks and merged without tools.
- Summary-only requests explicitly disable local model thinking. Ordinary conversation reasoning settings are preserved.
- Rejects empty, malformed, interrupted or truncated checkpoints. Original events remain in the append-only log.
- Rejects oversized final requests with the native overflow protocol; allows at most one overflow recovery per turn. Invalid historical output caps below 128 are replaced with the configured 8,192-token default.

The budget is a **padded estimate**, not an exact measurement of the provider's chat template. This cannot fix every `max-tokens` result: a single long answer or long reasoning can legitimately exhaust its output allowance.

## Before installation

**Validation gap:** No fresh Windows environment was available. The complete Harness installation, startup, enable/disable and native-service restoration workflow has **not been verified on a fresh Windows installation**. An isolated dependency install on the existing machine is not a substitute for that test.

Support is limited to **Harness 0.2.1-rc.5, local LM Studio and text conversations**. Enabling this plugin disables the global native `compaction-basic` entry, affecting more than the current conversation. Other providers do not receive this plugin's compaction protection; do not assume native compaction remains available as a fallback. Before switching providers or using multimodal content, disable this plugin, restart while idle and verify the native service is restored. Image/audio/file blocks are rejected. Revalidate after host updates.

## Installation

The source release is experimental and carries the validation gap above. Do not upload `private/`, transcripts, backups, machine-specific entry points or host dependencies.

From the repository root, choose **exactly one** SDK route below and continue in the same PowerShell window. Both require `@lmstudio/sdk` **1.5.0** and Node.js 22 or newer.

**A: Reuse an existing SDK** (the previously recorded desktop acceptance route). Replace the example with its real entry; skip B:

```powershell
$sdkEntry = 'C:\SDK\node_modules\@lmstudio\sdk\dist\index.mjs'
```

**B: Install the SDK into this checkout** (requires npm access):

```powershell
npm ci --ignore-scripts --legacy-peer-deps
if ($LASTEXITCODE -ne 0) { throw 'SDK installation failed; stop and investigate' }
$sdkEntry = Join-Path (Get-Location) 'node_modules\@lmstudio\sdk\dist\index.mjs'
```

`npm ci` uses the committed lockfile; `--legacy-peer-deps` leaves native peer dependencies to the existing Harness installation. Dependency installation scripts are disabled. This is not a clean-machine desktop acceptance claim.

Generate the offline desktop bundle using the SDK selected above. Replace only the example host path:

```powershell
$hostModules = 'C:\Apps\DeepSeek Harness\resources\app.asar\dsh\node_modules'
# Keep $sdkEntry from A or B; do not assign it again.
if (-not $sdkEntry -or -not (Test-Path -LiteralPath $sdkEntry -PathType Leaf)) { throw 'SDK entry missing; check the selected route' }
node scripts/prepare-local.mjs $hostModules $sdkEntry
```

The script checks that the SDK entry is a readable file before creating or replacing configuration. It does not verify the SDK version, its transitive dependencies or host modules inside Electron's `app.asar` archive. Successful generation does not prove plugin startup. Use the matching host version and verify running status after installation.

Install the printed `private/local-plugin` directory through Harness's **Plugins → Add plugin** dialog. This generated bundle uses absolute paths and must remain at its generated location. Regenerate it after changing source, then restart Harness while idle to load the new entry. Runtime directories are content-addressed, including resolved dependency paths. Never distribute the generated bundle to another machine. Do not remove or update the referenced SDK installation while the plugin is enabled.

## Commands and recovery

- `/context-guard status`: show loaded capacity, reservations and estimated input.
- `/context-guard recover`: compact the idle conversation without resuming its task. Native `/compact` also uses the replacement service.

Select `context-guard` from the composer's **+** command menu, then type `status` or `recover` after the command chip and send. Pasting a raw slash command as ordinary text may send it to the model instead of invoking the registry.

Before recovering a valuable record, **independently copy its session file and verify its checksum**. The command preserves original events but does not itself create an independent backup. Run recovery only while idle; check the summary and retained recent messages before continuing work.

Uninstall/disable through Harness's plugin UI to restore the original service. A successful checkpoint remains in session history after uninstall; disabling is not an undo of compression. Use the independent backup for full restoration, with Harness closed and its session storage workflow respected.

## Validation

```powershell
npm run check
npm test
$env:DSH_TEST_MODULES='<Harness node_modules directory extracted for Node>'
npm test
$env:DSH_LIVE_MODEL='<already loaded exact model id>'
$env:DSH_SDK_URL='<optional installed SDK file URL>'
node --test test/live.test.mjs
```

Default tests require no model or downloaded dependencies. Native tests require matching host modules; live tests are opt-in and send synthetic data only to loopback LM Studio. Skipped integration tests are not passes.

Native tests exercise the real Session and BasicCompactionEngine transaction code with fake LLM, maintenance admission and flush. They verify event retention and terminal marker closure, **not** actual Agent scheduling or disk persistence. Live tests verify tokenizer access and complete model-generated checkpoints. Desktop installation and recovery are separate acceptance steps.

## Limitations

Manual `recover` now saves validated intermediate summaries under `~/.dsh/context-guard-checkpoints`. Each invocation starts at most two new model calls, with a 210-second summary deadline, then reports **Recovery paused**. Run the same command again until it reports **Recovered**; an application restart does not discard completed checkpoints. Only the final native transaction replaces context. This does not resume the historical task. Exact input/session/model/configuration/prompt changes isolate cached work. Corrupt checkpoints fail closed. These files are **unencrypted, plaintext JSON** containing private summaries. The plugin retains them locally and does not upload them to GitHub; host, operating-system, backup and sync behavior is outside its guarantees. Checksums detect accidental corruption, not malicious tampering or authenticity: a writer can change both content and checksum; deleting them while Harness is idle only discards recovery progress. Automatic proactive compaction retains its existing behavior and does not use this manual checkpoint store.

- Text-only local provider; unsupported image/audio/file blocks fail closed. Other providers do not get this plugin's compaction behavior while it replaces the global service.
- SDK 1.5.0 cannot cancel `countTokens` RPCs. Caller cancellation/timeouts stop waiting; one outstanding RPC is retained until it settles, and further tokenization is rejected rather than accumulated. Restart the plugin if the SDK connection never settles.
- Concurrent local requests may receive `TOKENIZER_BUSY`. The installed bundle allows **600 seconds** total for a summary tree, with at most 32 calls; the core fallback is 180 seconds when no timeout is supplied. Large records require several sequential model calls, so this timeout is independent of the per-request 5-second capacity/tokenizer check.
- Summaries are lossy and can contain model mistakes. Heading validation checks structure, not factual completeness. The original record is the recovery authority.
- Desktop manual commands were observed to abort after about five minutes, even with the plugin's 600-second limit. The shorter summary prompt reduces work, but cannot override the host deadline; slow models or very large records can still fail safely without committing a replacement.
- Internal Harness APIs are version-pinned; revalidate on every Harness update.

## Latest fixes and validation

Missing mandatory summary sections trigger at most one regeneration from the original bounded source using a distinct corrective prompt. Repair calls count toward both invocation and logical-tree limits, including after checkpoint reuse. Checkpoint format/identity v2 isolates older caches; updating may recompute recovery progress while leaving original session history intact.

Under hard input pressure, compaction can include completed, balanced tool-call/result groups while retaining the newest human instruction. It avoids recompressing a lone checkpoint. A proactive threshold is not a hard input limit; final request guarding still applies.

The latest original-conversation continuation trial lost its computer connection during automatic compaction. Successful continuation through real agent steps is **not yet confirmed**. This publication does not certify that trial; the publishing check did not restart, resume or stop the local agent.

## Recorded recovery result

The [validation record](docs/VALIDATION.md) describes one successful restart/resume trial: 46 history items recovered, all 440 original events unchanged, and padded input estimates reduced from 81,598 to 9,724. A subsequent short reply made no tool calls. These are historical, version-specific observations, not a new live recovery test for this documentation change. They do not establish resumed historical tasks, complete factual retention or recovery of every crashed session.

## Review policy

Every functional change is reviewed along two separate axes before a release: **Standards** (`CONTRIBUTING.md`) and **Spec** (`docs/SPEC.md`). Pin `review-baseline`, run tests, review `git diff review-baseline...HEAD`, fix blocking findings, then repeat affected checks. This is the project's default code-review workflow; the runtime plugin does not invoke a cloud coding model or spend review credits during ordinary conversations.

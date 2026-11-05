# dsh-context-guard

[中文介绍、安装教程与使用说明](README.zh-CN.md) · [开源声明草案](docs/OPEN_SOURCE_STATEMENT.zh-CN.md)

Framework designed by the author **netsadly**; implementation code written by **GPT Astra**. This is an independent community project, not an official DeepSeek, LM Studio or OpenAI product. Only this plugin's source, documentation and synthetic tests are in scope for a future public release; the author's other projects and private data are excluded. The repository remains private, and a formal license has not yet been selected.

Private experimental context guard for **DeepSeek Harness 0.2.1-rc.5 + LM Studio**. Not a public release. This replaces the native `compaction-basic` service while retaining its transactional session replacement machinery.

## What it does

- Queries the exact **already loaded** model's context capacity before requests; does not load models.
- Uses LM Studio's tokenizer on serialized messages and tools, adds 10%, 32 tokens per message and 512 framing tokens, and takes the larger value alongside Harness's meter.
- Reserves the requested output budget plus 2,048 safety tokens. Triggers compaction at 80% of the remaining input budget.
- Keeps a recent tail and native tool-call/result boundaries. Large histories are summarized in bounded chunks and merged without tools.
- Summary-only requests explicitly disable local model thinking. Ordinary conversation reasoning settings are preserved.
- Rejects empty, malformed, interrupted or truncated checkpoints. Original events remain in the append-only log.
- Rejects oversized final requests with the native overflow protocol; allows at most one overflow recovery per turn. Invalid historical output caps below 128 are replaced with the configured 8,192-token default.

The budget is a **padded estimate**, not an exact measurement of the provider's chat template. This cannot fix every `max-tokens` result: a single long answer or long reasoning can legitimately exhaust its output allowance.

## Installation

Keep this repository private until installation/recovery validation is complete. Do not upload `private/`, transcripts, backups, machine-specific entry points or host dependencies.

For a normal development environment, install the pinned SDK dependency and provide the matching Harness peer dependencies. Add the package via Harness's plugin UI. `cordis.patch.yml` replaces the `compaction-basic` entry.

For offline desktop testing, reuse the installed host modules and an installed `@lmstudio/sdk` 1.5.0:

```powershell
node scripts/prepare-local.mjs '<Harness app.asar/dsh/node_modules>' '<installed SDK/dist/index.mjs>'
```

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

Manual `recover` now saves validated intermediate summaries under `~/.dsh/context-guard-checkpoints`. Each invocation starts at most two new model calls, with a 210-second summary deadline, then reports **Recovery paused**. Run the same command again until it reports **Recovered**; an application restart does not discard completed checkpoints. Only the final native transaction replaces context. This does not resume the historical task. Exact input/session/model/configuration/prompt changes isolate cached work. Corrupt checkpoints fail closed. These files contain private summaries, are retained locally, and are not uploaded; deleting them while Harness is idle only discards recovery progress. Automatic proactive compaction retains its existing behavior and does not use this manual checkpoint store.

- Text-only local provider; unsupported image/audio/file blocks fail closed. Other providers do not get this plugin's compaction behavior while it replaces the global service.
- SDK 1.5.0 cannot cancel `countTokens` RPCs. Caller cancellation/timeouts stop waiting; one outstanding RPC is retained until it settles, and further tokenization is rejected rather than accumulated. Restart the plugin if the SDK connection never settles.
- Concurrent local requests may receive `TOKENIZER_BUSY`. The installed bundle allows **600 seconds** total for a summary tree, with at most 32 calls; the core fallback is 180 seconds when no timeout is supplied. Large records require several sequential model calls, so this timeout is independent of the per-request 5-second capacity/tokenizer check.
- Summaries are lossy and can contain model mistakes. Heading validation checks structure, not factual completeness. The original record is the recovery authority.
- Desktop manual commands were observed to abort after about five minutes, even with the plugin's 600-second limit. The shorter summary prompt reduces work, but cannot override the host deadline; slow models or very large records can still fail safely without committing a replacement.
- Internal Harness APIs are version-pinned; revalidate on every Harness update.

## Review policy

Every functional change is reviewed along two separate axes before a release: **Standards** (`CONTRIBUTING.md`) and **Spec** (`docs/SPEC.md`). Pin `review-baseline`, run tests, review `git diff review-baseline...HEAD`, fix blocking findings, then repeat affected checks. This is the project's default code-review workflow; the runtime plugin does not invoke a cloud coding model or spend review credits during ordinary conversations.

# Third-party license notes

The MIT license at this repository's root covers this plugin's original source and documentation. Dependencies retain their own licenses. This source repository does not redistribute `node_modules`, Harness binaries/modules, model weights or generated local bundles.

Reviewed for the initial source publication against the pinned package metadata and installed SDK dependency license files:

| Dependency | Version | License information |
| --- | --- | --- |
| `@lmstudio/sdk` | 1.5.0 | Apache-2.0; package metadata and bundled LICENSE agree |
| `@lmstudio/lms-isomorphic` | 0.4.6 | Metadata says Apache-2.0; bundled LICENSE says MIT, copyright 2025 Element Labs Inc. Preserve the supplied license; this project does not resolve or relicense that upstream discrepancy. |
| `ansi-styles` | 4.3.0 | MIT |
| `chalk` | 4.1.2 | MIT |
| `color-convert` | 2.0.1 | MIT |
| `color-name` | 1.1.4 | MIT |
| `has-flag` | 4.0.0 | MIT |
| `jsonschema` | 1.5.0 | MIT |
| `supports-color` | 7.2.0 | MIT |
| `ws` | 8.22.1 | MIT |
| `zod` | 3.25.76 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |
| `@deepseek-ai/dsh-compaction-basic` | 0.2.1-rc.5 | MIT (npm metadata; supplied by installed Harness) |
| `@deepseek-ai/dsh-compaction` | 0.2.1-rc.5 | MIT (npm metadata; supplied by installed Harness) |
| `@deepseek-ai/dsh-llm` | 0.2.1-rc.5 | MIT (npm metadata; supplied by installed Harness) |

No dependency-license condition was identified that prevents publishing this plugin's own source under MIT. This is not a license grant for the separate Harness application, LM Studio application or model weights. If distributing dependencies or a binary bundle in the future, separately review their full dependency trees, preserve required copyright/license/NOTICE files and comply with the applicable terms. The local generated bundle is deliberately excluded from this publication.

Sources: [LM Studio SDK](https://github.com/lmstudio-ai/lmstudio.js), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), pinned npm packages and their installed LICENSE files. License review does not expand the tested runtime compatibility scope.

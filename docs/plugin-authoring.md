# Plugin Authoring and Catalog Submission

DeepSeek Harness Lite plugins follow the official Cordis loading model and use public DeepSeek Harness service interfaces. This document covers Lite's bundled plugin contract and the evidence required to list an external plugin. It does not create a separate plugin framework.

## Choose the integration path

| Path | Ownership | Release expectation |
| --- | --- | --- |
| Bundled plugin | Maintained in this repository under `plugins/` | Unit, security, activation, assembled-runtime, typecheck, and build gates |
| External verified plugin | Maintained elsewhere and pinned in the public catalog | Published metadata plus isolated install/build/config-load/activation evidence at one commit |
| External listed plugin | Maintained elsewhere | Metadata reviewed; executable verification remains incomplete |

A topic, package keyword, or catalog discovery result never activates or recommends a plugin automatically.

## Package contract

A bundled plugin package uses the `@dsh-lite/plugin-<id>` name, is an ESM package, exports its built entry point, and declares only the public packages it needs. Keep the plugin independently loadable and independently testable. Do not import repository-internal build paths from another plugin.

Follow official Loader conventions for the contribution being implemented. Expose a stable plugin name and an `apply` callback; expose `inject` and `Config` only when the plugin actually needs services or configuration. Register tools, listeners, policies, or projections through lifecycle-aware APIs so disposal removes every contribution.

Before relying on a service or event:

1. Confirm it is exported from an installed public package.
2. Pin the exact supported upstream release through the repository lock.
3. Add an activation test using a real Cordis context.
4. Exercise the plugin through the assembled Lite runtime when it contributes runtime behavior.

Private upstream source paths and monkey patches are out of scope.

## Security requirements

All plugin output must be bounded and must not expose secrets. Apply the narrower rules for the authority the plugin uses:

- **Environment:** Request specific values from host configuration. Never traverse or return all of `process.env`.
- **Network:** Accept HTTP(S) only, resolve and validate every destination, revalidate every redirect, block private and special-use addresses, and limit redirects, bytes, and elapsed time.
- **Filesystem:** Resolve canonical paths, reject symlink escapes, constrain access to the selected workspace, use bounded files, and use same-directory temporary-file replacement where data integrity matters. Do not describe path-based `rename` as race-free when a hostile local actor can replace the parent directory between validation and publication; Node.js does not expose a portable directory-fd-relative rename primitive.
- **Processes:** Deny unmatched commands, compare executable and argument rules structurally, avoid shell-string concatenation, and store only sanitized audit facts.
- **Sessions:** Project an explicit allowlist of event types and fields. Do not use a secret denylist as an export schema.
- **Lifecycle:** Register cleanup for tools, listeners, files, timers, requests, and subprocesses. Cleanup errors must not hide the primary operation result.

Document the plugin's authority, defaults, failure behavior, output bounds, and data retention in its package README.

## Bundled reference plugins

| Package | Required public behavior |
| --- | --- |
| `@dsh-lite/plugin-health` | Register `lite_health`; return sanitized upstream version, profile, packs, plugins, and runtime status |
| `@dsh-lite/plugin-safe-fetch` | Export `assertPublicHttpUrl(url, lookup)` and provide bounded fetch with redirect revalidation |
| `@dsh-lite/plugin-workspace-notes` | Export `resolveNotesPath(workspace, candidate)`; limit notes to `.dsh-lite/notes.md` and provide bounded note-section formatting |
| `@dsh-lite/plugin-command-allowlist` | Export `decideCommand(argv, rules)`; deny by default and emit sanitized durable denial events |
| `@dsh-lite/plugin-session-export` | Export `projectSession(events, format)`; produce sanitized Markdown or JSON from allowed fields |

These contracts are examples of diagnostic, network, durable local context, execution-policy, and session-projection extensions. New plugins should solve a distinct problem rather than copy an example under a new id.

The source checkout installs all five repository plugin packages for static imports, but the resolved profile activates only explicitly selected plugins and those contributed by selected packs. In v0.1.0, `workspace` contributes only workspace notes and session export, while `research` contributes only safe fetch. Generic upstream filesystem/search and `web_fetch` tools are intentionally excluded until their containment and SSRF boundaries are release-gated.

## Tests

At minimum, a bundled plugin needs:

- focused happy-path and malformed-input unit tests;
- a negative security test for each authority boundary;
- deterministic size, redirect, timeout, path, command, or event-field boundary tests as applicable;
- real Cordis activation and disposal coverage without a model key;
- assembled runtime coverage when the contribution affects a running agent;
- checks that sentinel credentials never appear in output, errors, snapshots, or generated files.

Run the repository's plugin, runtime, typecheck, and build gates. Do not claim compatibility from a unit test alone.

## Adding a plugin to a pack

Pack contributions are declarative. Add the plugin id to the pack manifest, add its exact package dependency, and add only the Cordis row needed to load it. Then verify that:

- enabling the pack contributes the plugin once;
- disabling the pack removes its package and Cordis row;
- duplicate ids fail before profile publication;
- every declared platform activates successfully or is explicitly excluded;
- compatibility closures and generated locks are regenerated from source inputs.

Never hand-edit a generated closure hash or lock hash.

## External catalog record

Submit external plugins through `catalog/plugins.json`. Each record must contain enough source data to reproduce the decision:

| Field | Requirement |
| --- | --- |
| Repository and package | Canonical public source URL and installable package name |
| Source commit | Full immutable commit id; moving branches and tags are insufficient |
| License | SPDX identifier backed by the pinned source |
| Compatibility | Declared DeepSeek Harness and Lite versions, without future-version claims |
| Evidence | Last verification time and manifest/license/install/build/config-load/activation outcomes |
| Risk flags | Network, filesystem, subprocess, native code, telemetry, credentials, dynamic loading, or other elevated authority |

The verification job clones the pinned commit into an isolated temporary directory. It may inspect metadata and source, install, build, scan for committed secrets, load configuration, and activate the plugin. It must not exercise network or subprocess behavior unless an explicit reviewed test policy permits that behavior.

## Classification and updates

- `bundled`: maintained and release-gated here.
- `verified`: every required external check passed at the recorded commit.
- `listed`: metadata is reviewable, but one or more executable checks are absent or incomplete.
- `blocked`: a license, secret, installation, build, activation, or safety failure prevents recommendation.

Verification is point-in-time. A new source commit, dependency graph, package artifact, compatibility claim, or risk surface requires new evidence. Generated catalog pages must be rendered from source records and reports; edit the source or verifier, not generated promotional text.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the public contribution workflow and [SECURITY.md](../SECURITY.md) for private vulnerability reports.

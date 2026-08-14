<p align="center">
  <img src="assets/logo.png" alt="DeepSeek Harness Lite" width="720">
</p>

<h1 align="center">DeepSeek Harness Lite</h1>

<p align="center">
  A lightweight, local-first distribution layer for the official DeepSeek Harness runtime.
</p>

<p align="center">
  <a href="https://github.com/sakurarain1213/deepseek-harness-lite/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sakurarain1213/deepseek-harness-lite/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="Upstream: DeepSeek Harness 0.1.0-rc.6" src="https://img.shields.io/badge/upstream-0.1.0--rc.6-blue.svg"></a>
</p>

> **Unofficial community project.** This repository is independently maintained and is not affiliated with, sponsored by, or endorsed by DeepSeek. The project image is a community-provided asset, not an official project endorsement.

[简体中文](README.zh.md) | [Architecture](docs/architecture.md) | [Plugin authoring](docs/plugin-authoring.md) | [Security](SECURITY.md)

DeepSeek Harness Lite keeps the official Harness agent loop, session model, tool registry, and LLM interfaces. It adds a smaller installation profile, removable capability packs, repository-owned plugins, and reproducible compatibility evidence. It is an independent repository, not a GitHub fork and not a replacement runtime.

## What Lite changes

| Area | Lite behavior |
| --- | --- |
| Runtime core | Uses official public DeepSeek Harness packages without copying or patching upstream source |
| Default profile | Installs the text-only `chat-only` closure |
| Optional capability | Adds exact dependency and Cordis rows through removable packs |
| Plugins | Activates only explicitly selected or pack-contributed Lite plugins |
| Compatibility | Pins one verified upstream package set and keeps latest-upstream observation separate |
| Publication | Builds immutable profiles and switches `current.json` only after validation |

## Install

Requirements: Git, Node.js `^22.19.0` or `>=24`, and Corepack. PowerShell 7 (`pwsh`) is required only when the `shell` pack is enabled on Windows. v0.1.0 runs from a repository checkout and is not published to npm.

### Windows PowerShell

```powershell
git clone https://github.com/sakurarain1213/deepseek-harness-lite.git
Set-Location deepseek-harness-lite
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
node apps/cli/dist/src/bin.js init --config examples/chat-only/lite.config.json --home .dsh-lite-home
node apps/cli/dist/src/bin.js doctor --home .dsh-lite-home
node apps/cli/dist/src/bin.js inspect --home .dsh-lite-home
```

### macOS

```sh
git clone https://github.com/sakurarain1213/deepseek-harness-lite.git
cd deepseek-harness-lite
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
node apps/cli/dist/src/bin.js init --config examples/chat-only/lite.config.json --home .dsh-lite-home
node apps/cli/dist/src/bin.js doctor --home .dsh-lite-home
node apps/cli/dist/src/bin.js inspect --home .dsh-lite-home
```

### Linux

```sh
git clone https://github.com/sakurarain1213/deepseek-harness-lite.git
cd deepseek-harness-lite
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
node apps/cli/dist/src/bin.js init --config examples/chat-only/lite.config.json --home .dsh-lite-home
node apps/cli/dist/src/bin.js doctor --home .dsh-lite-home
node apps/cli/dist/src/bin.js inspect --home .dsh-lite-home
```

`doctor` and `inspect` are keyless. For a real model turn, pass credentials through the current process environment only.

Windows PowerShell:

```powershell
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
$env:DEEPSEEK_API_KEY = "<your-key>"
$env:DEEPSEEK_MODEL = "deepseek-v4-flash"
node apps/cli/dist/src/bin.js run "Reply with: ready" --home .dsh-lite-home
```

macOS/Linux:

```sh
DEEPSEEK_BASE_URL='https://api.deepseek.com/v1' \
DEEPSEEK_API_KEY='<your-key>' \
DEEPSEEK_MODEL='deepseek-v4-flash' \
node apps/cli/dist/src/bin.js run 'Reply with: ready' --home .dsh-lite-home
```

Never put credentials in `lite.config.json`, generated profiles, fixtures, logs, or commits. `DEEPSEEK_MODEL` defaults to `deepseek-v4-flash`; the base URL and API key have no defaults.

## Profiles and capability packs

| Selection | Contents | Typical use |
| --- | --- | --- |
| `chat-only` | Official text runtime; no optional pack or plugin | Minimal chat and API validation |
| `developer` | `workspace` pack by default | Local work with bounded notes and session export |
| `workspace` | `lite_notes` and sanitized session export | Durable project context without generic filesystem/search tools |
| `shell` | Local subprocess, sandbox policy, command allowlist, Bash or PowerShell rows | Explicit local command execution |
| `research` | `lite_safe_fetch` | Bounded public HTTP(S) retrieval without upstream generic `web_fetch` |

Packs are declarative and removable. Changing the selection regenerates the exact dependency closure, lock, and Cordis rows. Disabled capability packages are physically absent from the generated profile.

The v0.1.0 `workspace` pack intentionally excludes upstream generic filesystem and search tools. The `research` pack intentionally excludes upstream generic `web_fetch`. Those broader surfaces remain off until their containment and SSRF boundaries pass the release gate.

## Bundled plugins

| Package | Contribution | Security boundary |
| --- | --- | --- |
| `@dsh-lite/plugin-health` | Sanitized `lite_health` diagnostics | Does not enumerate environment values |
| `@dsh-lite/plugin-safe-fetch` | Bounded public HTTP(S) fetch | Revalidates redirects; blocks private and special-use destinations; limits bytes and time |
| `@dsh-lite/plugin-workspace-notes` | Fixed-path durable notes | Restricts data to `.dsh-lite/notes.md`; checks canonical paths and links; bounds UTF-8 bytes |
| `@dsh-lite/plugin-command-allowlist` | Deny-by-default shell policy | Parses tokens structurally and rejects shell syntax; default rules are read-only |
| `@dsh-lite/plugin-session-export` | Markdown or JSON session projection | Exports an explicit event and field allowlist |

Repository plugins install with the source checkout for static, reviewable imports. Installation does not activate them. A resolved profile mounts only direct selections and contributions from selected packs.

## Plugin catalog

Catalog status is derived from evidence, not from repository topics, popularity, or metadata alone.

| Status | Meaning |
| --- | --- |
| `bundled` | Maintained in this repository and covered by release gates |
| `verified` | An external pinned commit passed the published install, build, activation, license, and risk checks |
| `listed` | Metadata is reviewable, but executable verification is incomplete |
| `blocked` | License, secret, install, build, activation, or safety evidence prevents recommendation |

External submissions must pin a full source commit, declare an SPDX license and Harness compatibility, include install/build/activation evidence, and disclose risk flags. See [Plugin authoring](docs/plugin-authoring.md) and the generated [catalog](catalog/generated/README.md).

## Architecture

```text
lite.config.json
       |
       v
CLI -> resolver -> exact closure + Cordis rows -> immutable profile publication
                    ^                         |
                    |                         v
             capability packs       official Harness runtime
                                              |
                                              v
                                  official tool registry + Lite plugins
```

Lite owns configuration, closure generation, publication, plugins, and evidence. Official packages own the agent loop, sessions, model integration, and tool registry. Read [Architecture](docs/architecture.md) for trust boundaries and the publication protocol.

## Upstream compatibility

The stable channel pins the complete upstream `0.1.0-rc.6` package inventory in [`compat/upstream-lock.json`](compat/upstream-lock.json). Generated closures and locks cover every pack combination on Windows, macOS, and Linux.

Compatibility is **best-effort and release-gated**, not permanent:

- stable uses the exact upstream release that passed the recorded gates;
- the latest-upstream workflow only detects new registry metadata;
- an upstream update requires regenerated closures and locks plus the complete release gates;
- Lite config and pack schemas remain stable where practical;
- incompatible upstream changes are handled through migration notes and versioned releases.

See [Upstream maintenance](docs/upstream-maintenance.md).

## Windows support

Windows is a supported v0.1.0 platform. The native path uses PowerShell rows, Windows package closures, PATHEXT-aware probes, and final-path profile construction so pnpm absolute junctions remain valid. `current.json` changes only after the candidate passes validation.

The release gate includes a native regression named `keeps a native Windows absolute junction valid after publication`. Windows is part of the same release-blocking CI matrix as Ubuntu and macOS; it is not configured with `continue-on-error`. Local validation also covers `init`, `doctor`, `inspect`, a real OpenAI-compatible API turn, profile cleanup, secret scanning, and all five plugins.

See [Windows support](docs/windows-roadmap.md) for the exact gates and platform requirements.

## Install-size evidence

The committed clean measurement was recorded on macOS arm64 with Node.js `22.22.3` and pnpm `10.15.0`. It is one-platform evidence, not a universal size promise.

| Installation | Bytes | Files | Installed packages | Direct dependencies | Workspaces |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lite checkout with build/test dependencies | 139,890,898 | 4,107 | 121 | 64 | 14 |
| Generated `darwin-chat-only` closure | 2,345,263 | 335 | 20 | 18 | N/A |
| Official `@deepseek-ai/dsh@0.1.0-rc.6` aggregate | 253,526,108 | 32,237 | 524 | 1 | N/A |

[`compat/reports/install-size.json`](compat/reports/install-size.json) is the source of truth. Run `corepack pnpm@10.15.0 measure:install` again whenever the dependency graph or measurement method changes.

## Security and maintenance

- Credentials stay in process environment variables; diagnostics redact secret-like fields.
- Generated profiles use exact dependencies, committed lock hashes, and profile-local resolution checks.
- Optional packs expand authority and must be selected explicitly.
- Network, filesystem, process, and session plugins enforce separate narrow boundaries.
- A valid Lite configuration is not a sandbox. Review enabled packs and plugins before running untrusted tasks.

Report vulnerabilities through GitHub private vulnerability reporting as described in [SECURITY.md](SECURITY.md). Do not include real keys or private logs.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for code, pack, documentation, and catalog changes. Original Lite code is available under the [MIT License](LICENSE). Upstream and third-party packages retain their own copyrights and licenses; see [NOTICE.md](NOTICE.md).

"DeepSeek" and "DeepSeek Harness" identify the upstream project. Their use here does not imply affiliation, sponsorship, or endorsement.

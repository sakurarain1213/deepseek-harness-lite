# DeepSeek Harness Lite

> **Unofficial community project.** DeepSeek Harness Lite is independently maintained, is not endorsed by DeepSeek, and does not reuse the DeepSeek logo.

[简体中文](README.zh.md) | [Architecture](docs/architecture.md) | [Plugin authoring](docs/plugin-authoring.md) | [Security](SECURITY.md)

DeepSeek Harness Lite is a developer-preview distribution of the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) runtime. It composes the official public packages into a small chat profile, optional capability packs, five example plugins, and reproducible compatibility locks. It is not a source fork and does not replace the upstream agent loop, session model, tool registry, or LLM interfaces.

## Quick start

Prerequisites: Node.js `^22.19.0` or `>=24` and Corepack. The first release runs from a repository checkout and is not published to npm:

```sh
git clone https://github.com/sakurarain1213/deepseek-harness-lite.git
cd deepseek-harness-lite
corepack enable
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
node apps/cli/dist/src/bin.js init --config examples/chat-only/lite.config.json --home .dsh-lite-home
node apps/cli/dist/src/bin.js doctor --home .dsh-lite-home
node apps/cli/dist/src/bin.js inspect --home .dsh-lite-home
```

`doctor` and `inspect` do not require a model credential. To run one model turn, provide credentials only in the process environment:

```sh
DEEPSEEK_BASE_URL='https://api.deepseek.com' \
DEEPSEEK_API_KEY='<your-key>' \
DEEPSEEK_MODEL='deepseek-v4-flash' \
node apps/cli/dist/src/bin.js run 'Reply with: ready' --home .dsh-lite-home
```

Do not put credentials in `lite.config.json`, generated profiles, fixtures, or commits. `DEEPSEEK_MODEL` defaults to `deepseek-v4-flash`; the base URL and API key have no defaults.

## Profiles and packs

The `chat-only` profile is the minimal text runtime. The `developer` preset enables `workspace`. Packs are declarative and removable: changing the selected packs regenerates an exact dependency closure and Cordis configuration rather than leaving disabled packages installed.

| Pack | Adds | Default | Platforms modeled |
| --- | --- | --- | --- |
| `workspace` | Workspace-bounded durable notes and session export | Enabled by `developer` | macOS, Linux, Windows |
| `shell` | Local subprocess plus Bash on macOS/Linux or PowerShell on Windows, with sandbox policy | Off | macOS, Linux, Windows |
| `research` | Bounded public HTTP(S) fetch | Off | macOS, Linux, Windows |

Pack metadata includes exact dependencies, Cordis rows, platform declarations, conflicts, and probes. Platform metadata is not a support claim; see [Windows status](#windows-status).

For v0.1.0, `workspace` intentionally does not load the upstream generic filesystem or search tools, and `research` does not load the upstream generic `web_fetch` tool. Those broader tools remain disabled until their workspace-containment and SSRF boundaries can be demonstrated under Lite's release gate. This is a deliberate authority reduction, not a compatibility accident.

## Repository plugins

The repository's five plugins demonstrate separate extension and security boundaries.

| Plugin | Contribution | Security boundary |
| --- | --- | --- |
| `@dsh-lite/plugin-health` | `lite_health` diagnostic tool | Returns sanitized runtime metadata and never traverses environment values |
| `@dsh-lite/plugin-safe-fetch` | Bounded HTTP(S) fetch | Revalidates redirects and rejects private, loopback, link-local, multicast, and metadata-service destinations |
| `@dsh-lite/plugin-workspace-notes` | Bounded workspace note read/write tool and note-section formatter | Fixes data to `.dsh-lite/notes.md` and performs canonical-path and symlink checks; see the documented concurrent parent-replacement residual in [Security](SECURITY.md) |
| `@dsh-lite/plugin-command-allowlist` | Shell execution policy | Accepts only simple tokens, denies shell syntax, and gives the shell pack a narrow read-only `pwd`/`git status`/`git diff`/`git log` policy |
| `@dsh-lite/plugin-session-export` | Markdown or JSON session projection | Exports an explicit allowlist of event fields |

All five repository-owned packages are `bundled`: install, build, and activation evidence is pinned to source commit `2c8346eee9b0e3baf7b57cbb6f59fe12696d7c2a`. External catalog entries use separate `verified`, `listed`, or `blocked` states. See [plugin authoring and catalog submission](docs/plugin-authoring.md).

The source checkout installs these small repository plugin packages together so the Runtime can use static, reviewable imports. Installation does not imply activation: a resolved profile mounts only the plugins selected directly or contributed by its selected packs. Official Harness dependencies for heavier capabilities are physically absent from a generated profile when their pack is not selected.

## Compatibility evidence

The `stable` channel is bound to one coherent, exact upstream package set in [`compat/upstream-lock.json`](compat/upstream-lock.json). Committed closure metadata and per-platform lock templates under [`packages/core/compat/`](packages/core/compat/) cover every pack combination. The CLI validates their integrity before installing a generated profile.

This is **best-effort verified compatibility**, not a guarantee that every future DeepSeek Harness release will work. Stable evidence gates releases. The latest-upstream lane detects changes separately and must never rewrite or weaken the stable lane. See [upstream maintenance](docs/upstream-maintenance.md).

## Install-size measurement

Run `pnpm measure:install`. The measurement creates a clean installation of the actual 14-workspace repository checkout, the generated chat-only official-package closure, and the official aggregate CLI under the same platform, Node.js version, package-manager invocation, registry, store, and cache conditions. It records `node_modules` bytes and files, direct dependency counts, unique installed package counts, workspace counts where applicable, and environment metadata in `compat/reports/install-size.json`.

The committed 2026-08-14 macOS arm64 measurement with Node.js `22.22.3`, pnpm `10.15.0`, and one isolated shared store/cache recorded:

| Installation | Installed bytes | Files | Unique installed packages | Direct dependencies | Workspaces |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lite repository checkout, including build/test dependencies | 139,890,898 | 4,107 | 121 | 64 | 14 |
| Generated core `darwin-chat-only` closure | 2,345,263 | 335 | 20 | 18 | N/A |
| Official `@deepseek-ai/dsh@0.1.0-rc.6` aggregate install | 253,526,108 | 32,237 | 524 | 1 | N/A |

The checkout row matches this release's install-from-source quick start and therefore includes development/build tooling; the core row measures only the generated minimal runtime closure. These are one-platform measurements, not universal promises. [`compat/reports/install-size.json`](compat/reports/install-size.json) is the source of truth; rerun and update the evidence whenever the dependency graph or method changes.

## Security model

- Configuration and generated profiles reject credential-shaped fields.
- API credentials stay in the process environment and diagnostics redact secret-like keys.
- Generated profiles use exact dependencies and committed lock integrity hashes.
- Capability packs are explicit; optional functionality does not silently activate.
- Plugin catalog status is evidence-based. Discovery or metadata review alone does not make a plugin recommended.
- Network, filesystem, process, and session-export plugins enforce their own narrow boundaries.
- A valid configuration is not a sandbox. Review enabled packs and plugins before using Lite on untrusted tasks or repositories.

Read [SECURITY.md](SECURITY.md) for supported versions and private reporting, and [architecture.md](docs/architecture.md) for trust boundaries.

## Windows status

Windows is modeled from day one in paths, platform-dependent package closures, PowerShell rows, executable probes, and lock templates. Native Windows support remains **planned/experimental**. It advances to supported only after the stable matrix succeeds on a GitHub-hosted Windows runner and maintainers remove `continue-on-error` in a reviewed change. Cross-platform unit tests or generated Windows locks alone are not promotion evidence. See the [Windows roadmap](docs/windows-roadmap.md).

## Contributing

Use [CONTRIBUTING.md](CONTRIBUTING.md) for code, documentation, pack, and catalog changes. Catalog submissions must pin a source commit, declare an SPDX license and compatibility range, disclose risk flags, and produce install/build/activation evidence before they can be classified as verified.

## License and attribution

Original DeepSeek Harness Lite code is available under the [MIT License](LICENSE). DeepSeek Harness remains an upstream project with its own copyright and MIT license. Dependencies retain their respective licenses. See [NOTICE.md](NOTICE.md) for attribution.

“DeepSeek” and “DeepSeek Harness” identify the upstream project. Their use here does not imply affiliation, sponsorship, or endorsement.

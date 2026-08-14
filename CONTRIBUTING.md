# Contributing to DeepSeek Harness Lite

Thank you for improving DeepSeek Harness Lite. This is an unofficial community project; contributions must not imply DeepSeek affiliation or endorsement and must not add DeepSeek logos or other brand assets without explicit permission.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Before you start

- Search existing issues and discussions before proposing a large change.
- Keep changes within Lite-owned surfaces: the CLI, `lite.config.json`, capability-pack manifests, bundled plugins, compatibility evidence, and documentation.
- Use official DeepSeek Harness public package exports. Do not import upstream `src/*`, patch installed upstream files, or copy the upstream monorepo.
- Add no dependency casually. Explain why an existing package or local utility is insufficient.
- Never commit credentials, `.env` files, generated Lite homes, or model responses containing private data.

## Development setup

Use Node.js `^22.19.0` or `>=24` and the repository-pinned pnpm version.

```sh
corepack enable
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 typecheck
```

Keep the diff focused and add tests at the closest ownership boundary. Run `corepack pnpm@10.15.0 compat:check` after changing a pack manifest, dependency closure, Cordis patch, or upstream lock.

The complete release gate also includes repository verification, secret scanning, license auditing, and clean-install measurement. A maintainer must run the root commands for those gates once their Task 6 scripts are present.

## Pull requests

Describe:

- the user-visible problem and intended behavior;
- the Lite-owned contract changed, if any;
- tests and commands run, with any gaps;
- security, compatibility, platform, and dependency effects;
- generated evidence changed and the source inputs that required it.

Do not mix generated compatibility data with unrelated refactors. Never hand-edit integrity hashes or generated reports to make a gate pass.

## Capability packs

A pack must declare exact dependencies, supported platforms, conflicts, plugin contributions, diagnostic probes, and a deterministic Cordis patch. It must be removable without leaving package or configuration rows behind. Test all declared platforms through injected platform values; native platform support still requires native CI evidence.

See [architecture.md](docs/architecture.md) for pack boundaries.

## Plugins

Bundled plugins need focused behavior and security tests, real Cordis activation coverage, bounded output, and cleanup through the runtime lifecycle. Do not read all of `process.env`, log secret-bearing objects, silently broaden filesystem/network/process access, or depend on private upstream modules.

See [plugin-authoring.md](docs/plugin-authoring.md) for package and catalog requirements.

## Public catalog submissions

The catalog is curated evidence, not an automatically populated directory. A submission must add or update the source entry in `catalog/plugins.json` with:

- repository URL and package name;
- a pinned source commit, not a moving branch or tag;
- SPDX license identifier;
- declared DeepSeek Harness and Lite compatibility;
- verification timestamp and checks performed;
- explicit risk flags for network, filesystem, subprocess, native code, telemetry, credentials, and dynamic loading.

Verification runs against the pinned commit in an isolated temporary directory. It checks metadata, license, clean install, build, static secret patterns, configuration loading, and activation. Network or subprocess behavior runs only under an explicit reviewed test policy.

Catalog states have precise meanings:

| State | Meaning |
| --- | --- |
| `bundled` | Maintained here and release-gated |
| `verified` | External pinned commit passed all published required checks |
| `listed` | Metadata was reviewed, but executable verification is incomplete |
| `blocked` | A license, secret, install, activation, or safety problem prevents recommendation |

Discovery under a topic, popularity, or a successful metadata review never grants `verified` status. Generated catalog output must come from source data and evidence, not manual promotional copy.

## Licensing

Contributions to original Lite code are accepted under this repository's [MIT License](LICENSE). Preserve third-party notices. Identify any copied or adapted material in the pull request and update [NOTICE.md](NOTICE.md) when required.

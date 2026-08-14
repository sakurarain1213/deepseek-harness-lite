# Upstream Maintenance

DeepSeek Harness is in developer preview and may make compatibility-breaking changes. DeepSeek Harness Lite therefore offers **best-effort verified compatibility** for exact tested package sets. It does not promise permanent compatibility with future upstream versions.

## Evidence channels

| Channel | Purpose | Release effect |
| --- | --- | --- |
| `stable` | Reproduce the exact upstream package set in `compat/upstream-lock.json` | Required to pass for every Lite commit and release |
| `latest` / `next` | Observe aggregate versions, fine-grained package availability, and dist-tag skew | Metadata-only and `planned` until a candidate graph is installed and executed; never weakens stable evidence |

The CLI release path accepts the exact stable channel/version pair. The latest channel is maintenance evidence, not a reproducible user install choice.

## Source of truth

The stable package set is recorded in [`compat/upstream-lock.json`](../compat/upstream-lock.json). Generated profile closures and per-platform frozen lock templates live under [`packages/core/compat/`](../packages/core/compat/). Each closure records:

- platform and enabled pack ids;
- the complete exact dependency inventory;
- hashes for the canonical inventory, Cordis rows, and lock template;
- the upstream channel and Harness version;
- the generator's pnpm version and canonical pack/platform order.

The package-manager lock and generated closure evidence support the same source lock; none may be updated independently to conceal version skew.

## Detecting an upstream release

The scheduled observation may use the aggregate upstream release to identify a candidate version, but it must inspect every required fine-grained package explicitly. A set assembled by accepting unrelated `latest` tags is incoherent even if each package exists. Registry resolution alone is metadata evidence, not compatibility evidence, and its report remains `planned`/unmeasured.

For each candidate:

1. Resolve the aggregate release candidate and its corresponding official package line.
2. Fetch registry metadata for every required public package.
3. Reject missing packages, mismatched release lines, moving or unpublished versions, and unsupported Node.js engines.
4. Generate candidate data outside the stable paths.
5. Run the full compatibility matrix and retain a machine-readable pass or failure report.

A latest failure is useful evidence. It must not overwrite a passing stable lock, delete the prior stable report, or silently fall back to a mixed package set.

## Promoting a candidate to stable

An automated update may prepare a pull request limited to the upstream source lock and generated compatibility evidence. It must not auto-merge while upstream remains in developer preview.

A maintainer reviews the candidate in this order:

1. Read upstream release notes and public API changes.
2. Confirm the exact package set is coherent and contains no unintended aggregate CLI dependency.
3. Regenerate every platform/pack closure and lock template from the reviewed source lock.
4. Run Core config, resolution, materialization, integrity, and activation tests.
5. Run all five bundled plugin unit and real Cordis activation tests.
6. Run assembled runtime and built CLI process tests.
7. Run repository verification, secret scanning, license auditing, and clean-install measurement.
8. Run one bounded real-API smoke locally with credentials supplied only through the process environment.
9. Review stable and latest reports, known breaks, disabled capabilities, and native platform results.
10. Publish a Lite patch release only after the evidence is complete and the changelog is accurate.

The real-API smoke must use a short prompt, no tool calls, a strict output cap, and no credential persistence. CI may skip it when no repository secret exists, but the release record must state that gap rather than imply it passed.

## Compatibility report content

A public report must identify the Lite commit, exact upstream package set, platform, Node.js version, package manager version, pack/plugin selection, commands executed, result, timestamp, and known limitations. It may say only what that evidence proves.

Examples of acceptable claims:

- “Stable `0.1.0-rc.6` package set passed the recorded macOS job.”
- “Latest failed during plugin activation; stable remains unchanged.”
- “Windows passed the recorded blocking native CI job for this Lite commit and stable upstream lock.”

Do not claim universal, future, or permanent compatibility.

## Backward compatibility

Within one Lite major version:

- old `lite.config.json` schemas remain readable or receive a deterministic migration with a backup;
- command names and bundled plugin ids remain stable unless a documented deprecation precedes removal;
- user override patches are not rewritten silently;
- pack removal restores the previous dependency and Cordis row set.

This policy does not freeze upstream private APIs or file formats. Lite does not copy or translate upstream session storage unless the upstream public API explicitly supports it. When upstream removes a required public interface, maintainers may temporarily block promotion, disable an affected optional capability with an explicit report, or prepare a Lite major-version change.

## Install-size evidence

Run `pnpm measure:install` under the same platform, Node.js version, package-manager invocation, registry, store, and cache conditions for the actual repository checkout, the chat-only Core closure, and the official aggregate CLI. `compat/reports/install-size.json` records `node_modules` bytes and file counts, direct dependency counts, workspace/package counts, and environment metadata. Package-manager state files containing temporary absolute paths are excluded so repeated clean measurements are byte-stable.

After the source commit passes the complete release gate, generate `compat/reports/stable.json` with `node packages/compat/bin/stable-report.mjs --commit <full-source-commit> --output compat/reports/stable.json`. The later evidence commit must not claim a different source SHA than the bundled plugin catalog.

Never transfer a number from a developer's existing checkout into the README. Publish size claims only from the generated clean-install report and replace or remove them when the package set or measurement method changes.

## Incident handling

If stable compatibility regresses:

1. Keep the last known-good lock and report available.
2. Mark the affected Lite/upstream combination explicitly; do not relabel latest evidence as stable.
3. Determine whether the cause is upstream API change, registry artifact, platform dependency, plugin behavior, or Lite code.
4. Fix the smallest owning boundary and rerun the complete affected matrix.
5. Publish a patch and security advisory when impact warrants it.

Upstream vulnerabilities should be reported to upstream maintainers as well as handled in Lite's locked release. Follow [SECURITY.md](../SECURITY.md) for private coordination.

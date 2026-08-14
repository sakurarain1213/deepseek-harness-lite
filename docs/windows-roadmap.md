# Windows Support

Windows is a supported DeepSeek Harness Lite v0.1.0 platform. Its `windows-latest` job is part of the same release-blocking CI matrix as Ubuntu and macOS. The repository does not use `continue-on-error` for Windows.

Support applies to the stable upstream lock recorded in `compat/upstream-lock.json`, the Node.js engines declared in `package.json`, and the commands and capability packs covered by the release gate. It is not a claim that untested future Harness versions will work.

## Requirements

- Git for Windows.
- Node.js `^22.19.0` or `>=24` with Corepack.
- PowerShell 7 (`pwsh`) when the `shell` pack is selected.
- A filesystem that supports ordinary pnpm directory junctions.

The `chat-only`, `workspace`, and `research` selections do not require `pwsh`. Windows shell behavior uses the official PowerShell package rows and does not emulate Bash.

## Native publication design

pnpm creates package junctions with absolute targets on Windows. Moving a completed installation from `.stage-<uuid>` to `versions/<uuid>` invalidates those targets even when the move itself succeeds.

Windows publication therefore constructs the candidate directly in its final immutable `versions/<uuid>` directory. A strict publisher lease protects that directory while it is being built. The publisher validates the full profile and runtime before atomically replacing `current.json`. A failed build is removed without changing the visible profile.

POSIX publication retains the stage-and-rename path. Both implementations use the same reader leases, previous pointer, retirement markers, path-containment checks, and conservative cleanup rules. A publisher only prunes version directories that existed when that publication began, so concurrent publishers cannot delete each other's newly created versions.

## Release gates

Every supported Windows release must pass all of the following on a native runner:

1. Frozen root installation with pnpm `10.15.0` and a supported Node.js version.
2. Unit tests, integration tests, plugin tests, typecheck, and build.
3. Built CLI `init`, `doctor`, `inspect`, and keyless failure-path checks.
4. Profile materialization and installed-profile validation for chat-only and every capability-pack combination.
5. PowerShell probing and shell-pack activation.
6. Transaction publication, concurrency, recovery, cleanup, path containment, and link/junction safety tests.
7. A native PASS for `keeps a native Windows absolute junction valid after publication`; a skipped result is not accepted.
8. Repository verification, secret scanning, license auditing, compatibility checks, and packed-production checks.
9. A reviewed stable report tied to one real Lite source commit and the exact stable upstream package inventory.
10. A release-blocking `windows-latest` job with no hidden Windows-specific failure or permissive `continue-on-error` setting.

The real API smoke is a separate maintainer check because public CI has no model credential. Its result must be stated separately from public CI evidence.

## Current boundaries

- `workspace` uses the bounded notes and session-export plugins; it does not expose upstream generic filesystem or search tools.
- `research` uses the bounded Lite fetch plugin; it does not expose upstream generic `web_fetch`.
- `shell` requires `pwsh` and uses the deny-by-default command allowlist.
- Antivirus scanners and external file locks may delay cleanup; retry behavior is bounded and publication keeps the previous valid profile visible on failure.
- Generated locks cover `win32`, but each upstream update still requires a fresh native blocking run.

## Ongoing support

Every stable lock update must keep the Windows job green. A Windows regression blocks release and must be documented immediately. Restoring `continue-on-error`, skipping native junction coverage, replacing PowerShell behavior with Bash emulation, or silently dropping security probes requires an explicit support-policy change and is not a routine workaround.

Useful Windows contributions include native file-lock reproductions, long-path cases, PowerShell activation coverage, junction containment tests, antivirus interaction reports, and deterministic install measurements. Include the Windows edition, architecture, Node.js version, pnpm version, selected packs, and exact Lite/upstream commits.

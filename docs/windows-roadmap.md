# Windows Roadmap

Windows is a first-day architecture target and a current **planned/experimental** platform. DeepSeek Harness Lite does not claim native Windows support until its stable workflow passes on a GitHub-hosted Windows runner and maintainers deliberately remove `continue-on-error` in a reviewed change.

Generated Windows locks, platform-injected unit tests, or a successful Windows run on one developer machine are useful evidence, but none is sufficient for promotion.

The resulting native Windows stable job must be release-blocking. A passing job that still uses `continue-on-error` leaves Windows planned/experimental.

## Already modeled

- `win32` is part of the public platform type and pack manifest schema.
- CLI paths resolve through Windows path semantics when the injected platform is `win32`.
- Profile publication and recovery account for Windows directory replacement and cleanup behavior.
- Every pack declares Windows in its platform metadata.
- The workspace and research packs use the same bounded repository-plugin surfaces as other platforms; v0.1.0 does not enable upstream generic filesystem/search or `web_fetch` tools on Windows.
- The shell pack selects `pwsh`, `@deepseek-ai/dsh-pwsh-local`, `@deepseek-ai/dsh-pwsh-sandbox`, and `@deepseek-ai/dsh-tool-pwsh` on Windows.
- Executable probes use `PATH` and `PATHEXT` semantics for Windows.
- Committed compatibility metadata includes `win32` closure and lock templates for every pack combination.

These decisions prevent a later Windows port from requiring a new configuration format or pack model.

## Current limitations

- Windows evidence must come from a native Windows runner; cross-platform generation does not prove install, process, filesystem, PowerShell, or cleanup behavior.
- Native package availability and install-script policy may differ from macOS and Linux.
- Filesystem locking, symlink/junction behavior, executable suffixes, quoting, signal handling, and atomic directory operations need runner-backed coverage.
- Shell behavior differs by design: Windows uses PowerShell rows, not emulated Bash rows.
- Until the stable native job passes and is made blocking, README and compatibility reports must say planned/experimental rather than supported.

## Promotion gates

Windows becomes a supported release platform only when all of the following pass on `windows-latest` using the stable upstream lock:

1. Frozen root installation under the repository-pinned pnpm and a supported Node.js version.
2. Unit tests, typecheck, and build.
3. Built `dsh-lite init`, `doctor`, `inspect`, and keyless error-path process tests.
4. Profile materialization and installed-profile validation for chat-only and every pack combination.
5. PowerShell executable probing and shell-pack activation.
6. Transactional publication, recovery, cleanup, path containment, and link/junction safety tests.
7. Five bundled plugin unit, security, activation, and assembled-runtime tests.
8. Stable compatibility, secret scan, license audit, repository verification, and clean-install measurement.
9. A reviewed compatibility report with no Windows-specific known failure hidden by retries or skipped assertions.
10. Removal of `continue-on-error` from the Windows stable CI job in a reviewed commit.

The last step is mandatory. A green non-blocking job does not silently change project policy.

## CI progression

### Stage 1: Planned/experimental

Windows runs the same stable matrix where practical but may be configured with `continue-on-error`. Failures are retained as evidence and do not weaken macOS/Linux stable status. Documentation makes no support claim.

### Stage 2: Promotion review

After a complete native pass, maintainers inspect logs and reports for skipped work, conditional exclusions, native dependency substitutions, and cleanup flakiness. They rerun the workflow and review any Windows-only exceptions.

### Stage 3: Supported

Maintainers remove `continue-on-error`, update the public compatibility report and README in the same reviewed release change, and make Windows failure release-blocking. The Lite schema and pack ids remain unchanged.

### Stage 4: Ongoing support

Every stable lock update must keep the Windows lane green. A later regression changes the compatibility report immediately and blocks releases; it must not be hidden by restoring `continue-on-error` without an explicit support-status review.

## Contribution priorities

Useful Windows contributions include native failure reproductions, PowerShell activation tests, junction and symlink containment cases, antivirus/file-lock cleanup behavior, long-path handling, and deterministic install reports. Include the Windows edition, architecture, Node.js version, pnpm version, selected profile/packs, and exact Lite and upstream commits.

Do not solve Windows issues by adding a separate configuration schema, silently dropping security probes, falling back to mixed upstream package versions, or changing Windows to Bash semantics.

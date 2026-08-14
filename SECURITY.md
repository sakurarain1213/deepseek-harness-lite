# Security Policy

DeepSeek Harness Lite is a developer-preview, unofficial community project. It composes upstream packages and optional plugins that may access the network, filesystem, or local processes. Review the exact stable lock, enabled packs, and enabled plugins for your threat model.

## Supported versions

Security fixes target the latest released Lite `0.1.x` version while the project is in developer preview. Older preview snapshots and unverified upstream package combinations are not supported. A configuration using the `latest` upstream lane is compatibility-test material, not a supported production combination.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull request, or plugin catalog entry.

Use GitHub's private vulnerability reporting for `sakurarain1213/deepseek-harness-lite`. Include:

- affected Lite version, commit, platform, and Node.js version;
- selected upstream version, profile, packs, and plugins;
- reproduction steps or a minimal proof of concept;
- security impact and required attacker capabilities;
- whether credentials or personal data may have been exposed;
- any proposed mitigation, if known.

If private vulnerability reporting is unavailable, contact the repository owner through their GitHub profile before sharing sensitive details. Do not send real API keys, tokens, private repository contents, or unredacted session logs.

Maintainers will acknowledge a complete report, reproduce it in an isolated environment, coordinate a fix and advisory when warranted, and credit reporters who request attribution. Response timing is best effort; this project does not promise a fixed service-level agreement.

## Scope

Reports are in scope when they involve Lite-owned behavior, including:

- credential persistence or disclosure;
- diagnostic or export redaction failures;
- generated-profile integrity or package-resolution bypasses;
- path or symlink escapes;
- private-network or redirect-policy bypasses;
- command-allowlist bypasses;
- plugin catalog misclassification from falsified or insufficient evidence;
- unsafe temporary-directory, subprocess, or cleanup behavior.

Vulnerabilities solely in DeepSeek Harness or another dependency should also be reported to that project's maintainers. You may notify Lite maintainers privately when the issue affects a locked Lite release so the lock or guidance can be updated.

## Security boundaries

- Credentials belong in process environment variables or ignored local secret stores, never tracked configuration.
- `doctor` and `inspect` are intended to be keyless; their output must remain sanitized.
- Stable profiles install exact dependency closures whose committed metadata and locks carry integrity hashes.
- Optional packs expand authority. `workspace`, `shell`, and `research` should be enabled only when required.
- In v0.1.0, `workspace` exposes only bounded durable notes and session export, and `research` exposes only bounded public HTTP(S) fetch. Upstream generic filesystem/search and `web_fetch` tools remain disabled until containment and SSRF boundaries are proven by the release gate.
- The workspace-notes writer revalidates canonical paths and symlinks before same-directory replacement. A hostile local actor with permission to replace the verified parent directory in the interval before the final path-based `rename` could still redirect that write; Node.js has no portable directory-fd-relative rename primitive. Do not use the notes plugin across mutually untrusted local OS users or processes.
- Catalog verification reduces risk at one pinned commit; it is not a permanent safety guarantee or a substitute for source review.
- Lite cannot make a compromised host, package registry, upstream dependency, model endpoint, or user-selected plugin trustworthy.

Generated-profile publication normally retains the current immutable version plus one previous version. `current.json` remains readable in its original `{ "version": "..." }` form and new publications add an optional `previous` pointer. Readers register a process-identity lease before receiving a version; retirement uses a marker and a second lease scan before deletion. Consequently, active reader versions remain available even when they are older than `previous`.

Retention is deliberately fail-closed rather than a hard two-version disk quota. A remote-host, malformed, unreadable, symlinked, or otherwise unverifiable reader lease blocks reclamation; a long-lived process can also retain every version it has resolved until it exits. Same-host leases and retirement markers are reclaimed by a later publication only when the owner PID is dead or its process-start identity no longer matches. Reclamation skips any version entry that is not a strict UUID, ordinary directory, and real immediate child of `versions/`; a symlinked or escaped `versions/` directory prevents publication before candidate construction.

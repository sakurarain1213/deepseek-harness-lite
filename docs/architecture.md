# Architecture

DeepSeek Harness Lite is an unofficial community distribution layer over public DeepSeek Harness packages. It owns profile resolution, capability-pack composition, generated-install integrity, the `dsh-lite` command, and compatibility evidence. It does not own or reimplement the upstream agent loop, session domain, tool registry, system-prompt service, or LLM vocabulary.

## Design constraints

- Consume official public package exports only. Do not import upstream `src/*` paths or patch installed packages.
- Do not depend on the aggregate `@deepseek-ai/dsh` package. Lite selects fine-grained official packages so disabled capabilities are absent from the installed profile.
- Treat an upstream release as one coherent package set. Never assemble a release by independently following each package's moving dist-tag.
- Validate a complete candidate before publishing it. A failed change must leave the last valid generated profile usable.
- Model paths, executable probes, and platform dependencies through an injected platform value so Windows behavior does not require an architectural fork.

## Components

| Component | Responsibility |
| --- | --- |
| `apps/cli` | Parse `init`, `doctor`, `inspect`, and `run`; resolve paths; turn internal failures into bounded diagnostics |
| `packages/core` | Validate configuration, resolve packs and plugins, generate profiles, verify locks and installed closures, publish state atomically |
| `packages/runtime` | Boot official Cordis and Harness services, register the OpenAI-compatible DeepSeek adapter, run one task, dispose the runtime |
| `packages/packs/*` | Declare exact optional dependencies, platform-specific dependencies, Cordis rows, conflicts, and probes |
| `plugins/*` | Provide the five independently loadable Lite extension examples |
| `compat/upstream-lock.json` | Record the exact stable upstream package set |
| `packages/core/compat/` | Store deterministic closure metadata and lock templates for platform/pack combinations |
| `catalog/` | Store curated plugin source data and generated verification output |

## Configuration contract

`lite.config.json` schema version 1 requires `upstream`, `profile`, `packs`, and `plugins`:

```json
{
  "schemaVersion": 1,
  "upstream": {
    "channel": "stable",
    "version": "0.1.0-rc.6"
  },
  "profile": "chat-only",
  "packs": [],
  "plugins": []
}
```

The checked-in [`examples/chat-only/lite.config.json`](../examples/chat-only/lite.config.json) is the canonical minimal example. `stable` must match the committed upstream lock exactly. `latest` belongs to compatibility testing; it is not a reproducible release selection.

Profile resolution is deterministic:

1. Parse the strict schema and reject unknown fields.
2. Verify the selected upstream channel and version against the stable lock.
3. Expand the profile preset and requested packs in canonical order.
4. Reject duplicate ids, unknown ids, dependency cycles, conflicts, and unsupported platforms.
5. Add plugins contributed by packs and validate all plugin ids.
6. Select the committed compatibility closure for the platform and exact pack set.

Within a Lite major version, checked-in configuration remains readable or receives an explicit deterministic migration. This promise applies to Lite-owned configuration, command names, and bundled plugin ids. It does not promise that Lite can convert private or changed upstream on-disk session formats.

## Generated profile lifecycle

`dsh-lite init --config <path> --home <path>` resolves the configuration and constructs a candidate home. The candidate contains the normalized configuration, resolved profile metadata, an exact package manifest, a frozen lock, and generated Cordis rows.

Before publication, Core verifies:

- compatibility metadata and lock hashes;
- exact package versions and profile-local resolution;
- dependency closure against the selected pack set;
- absence of credential-shaped fields in generated configuration;
- required package and executable probes;
- Cordis row loading and activation in an isolated context.

State publication is transactional. A new immutable version becomes current only after validation succeeds. Recovery rejects symlinked or unowned staging paths and does not recursively delete paths it cannot prove belong to the Lite transaction.

Successful immutable versions live under `versions/`. The current pointer remains backward-compatible with the original `{ "version": "..." }` form and new publications record `{ "version": "...", "previous": "..." }`. After a normal successful publication, reclamation retains the current version and one previous version.

`resolveCurrentTree` registers a reader lease before returning a version. A leased version may therefore remain beyond the normal two-version window. Before deleting an old version, the publisher creates a retirement marker, re-reads the current pointer, and scans leases again; this closes the reader-versus-reclaimer race. A later publication reclaims leases and retirement markers only when the same host can prove the owning process is dead or its process-start identity changed. Remote-host, malformed, unreadable, symlinked, or otherwise ambiguous ownership fails closed and can intentionally exceed the nominal retention bound. Long-lived processes have no explicit release operation in v0.1.0, so versions they have resolved remain protected until the process exits and a later publication proves that identity dead.

Reclamation never recursively deletes a non-UUID entry, symlink, non-directory, or path whose real location is not an immediate child of `versions/`. A symlinked or escaped `versions/` directory rejects publication before candidate construction begins.

`doctor`, `inspect`, and `run` reopen the current profile, resolve the source configuration again, compare it with stored resolved metadata, and revalidate the installed profile. `inspect` prints a redacted resolved tree. `doctor` returns a keyless health result. `run` boots the validated profile and performs one turn.

## Runtime path

The runtime starts an official Cordis context and registers the official LLM, session, system-prompt, tool, agent-registry, and agent-loop services. It then loads the generated pack rows, mounts only the selected repository plugins, registers a DeepSeek-compatible adapter, runs the requested task through the official agent interface, waits for completion, and disposes the context. During `init`, the same assembled pack/plugin combination is booted and disposed inside the unpublished candidate tree; a failure prevents the outer home transaction from advancing its current pointer.

All five repository plugin packages are installed in a source checkout to support static, auditable imports. The profile resolver still controls activation: only plugins selected directly or contributed by selected packs are mounted. Official packages belonging only to an unselected heavier capability pack are omitted from the generated dependency closure and therefore remain physically removable.

The adapter requires `DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY`. `DEEPSEEK_MODEL` is optional and defaults to `deepseek-v4-flash`. Values are read from the process environment and are not written into Lite configuration or generated profile files.

## Capability composition

Core is text-only. It deliberately excludes filesystem, subprocess, Web, LSP, MCP, workflow, subagent, scheduler, GUI, and telemetry-exporter capabilities unless an explicit pack adds a narrower reviewed contribution.

| Pack | Selected contribution | Platform behavior |
| --- | --- | --- |
| `workspace` | `workspace-notes` and `session-export` repository plugins; no generic filesystem/search Cordis rows | Same bounded plugin surface on macOS, Linux, and Windows |
| `shell` | subprocess, local sandbox, sandbox policy, shell environment, shell tool | Bash rows on macOS/Linux; PowerShell rows on Windows |
| `research` | `safe-fetch` repository plugin; no generic upstream `web_fetch` Cordis row | Public HTTP(S) fetch with destination, redirect, byte, and time bounds |

v0.1.0 deliberately omits the upstream generic filesystem/search and `web_fetch` tools. They are broader than the reviewed Lite plugin surfaces and remain disabled until native containment and SSRF tests can prove the intended boundary on every claimed platform.

Every platform and pack combination maps to a committed closure record and frozen lock template. A combination with no matching record fails closed instead of resolving fresh dependencies implicitly.

## Compatibility model

Compatibility has two lanes:

- **Stable:** exact upstream packages from `compat/upstream-lock.json`; gates commits and releases.
- **Latest/next metadata:** a scheduled/manual observation lane that resolves candidate package availability and tag skew without changing stable evidence. It remains planned until the candidate graph is installed and executed by a promotion workflow.

The contract is best-effort verified compatibility. Evidence describes a specific Lite commit, upstream package set, platform, Node.js version, package inventory, and command set. It does not extend to untested future upstream versions. See [upstream-maintenance.md](upstream-maintenance.md).

## Trust boundaries

| Boundary | Controls | Residual risk |
| --- | --- | --- |
| Package registry to generated profile | Exact versions, frozen lock, committed hashes, profile-local resolution | A compromised dependency or registry artifact remains a supply-chain risk |
| User configuration to runtime | Strict schema, known ids, pack closure and platform checks | A user can intentionally enable powerful packs |
| Secrets to diagnostics/files | Environment-only credentials, credential-field rejection, recursive redaction | A selected endpoint, dependency, or plugin may mishandle data outside Lite's controls |
| Network plugin to destination | Scheme, DNS/address, redirect, size, and time checks | Public endpoints can return hostile content |
| Workspace notes plugin to host filesystem | One fixed notes path, canonical-path and symlink checks, bounded contents, temporary-file publication | Access inside the selected workspace is intentional authority; a hostile local actor that can replace the verified parent directory between the final check and `rename` may redirect the write because Node.js has no portable directory-fd-relative rename API |
| Shell plugin to local process | Explicit pack plus deny-by-default allowlist plugin | Any permitted command has the invoking user's OS authority |
| External plugin to catalog user | Pinned commit and published evidence classification | Verification is point-in-time and cannot prove permanent safety |

Lite configuration validation is not a complete sandbox. Operators must review the selected profile, packs, plugins, workspace, endpoint, and host permissions.

## Windows boundary

Windows participates in data modeling and generated compatibility artifacts today, but it remains planned/experimental until native CI proves the stable path. Promotion requires a successful GitHub-hosted Windows stable job and a reviewed removal of `continue-on-error`. See [windows-roadmap.md](windows-roadmap.md).

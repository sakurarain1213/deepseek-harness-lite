# Changelog

All notable changes to DeepSeek Harness Lite will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses semantic versioning for the Lite-owned CLI, configuration, pack, and catalog contracts; upstream DeepSeek Harness versions are tracked separately by exact compatibility evidence.

## [0.1.0] - 2026-08-14

### Added

- Developer-preview `dsh-lite` CLI with `init`, `doctor`, `inspect`, and one-shot `run` commands.
- Schema version 1 configuration with `chat-only` and `developer` profiles.
- Declarative `workspace`, `shell`, and `research` capability packs. The v0.1.0 workspace and research packs intentionally omit upstream generic filesystem/search and `web_fetch` tools until their containment and SSRF boundaries can be proven.
- Five release-gated bundled plugins covering health diagnostics, safe fetch, workspace notes, command allowlisting, and session export.
- Exact upstream stable lock and deterministic per-platform compatibility closures for every pack combination.
- Bilingual repository documentation, security and contribution policies, upstream attribution, and Windows promotion criteria.

### Compatibility

- Stable DeepSeek Harness package line: `0.1.0-rc.6`, with supporting packages pinned in `compat/upstream-lock.json`.
- Compatibility asset checks work from a cold pnpm metadata cache while preserving exact pins, canonical seed integrity, and byte-for-byte generated assets.
- Compatibility seeds, generated closures, and the generated plugin catalog stay LF-normalized so strict integrity hashes and catalog checks survive Windows checkouts.
- Linux shell profiles authorize only the audited `node-pty` build and require a real native module before publication.
- Windows child processes execute Corepack through its JavaScript entry without shell command interpolation, preserving paths and arguments containing spaces or metacharacters.
- Windows profile containment normalizes namespaced junction targets before comparison while continuing to reject paths outside the installed profile.
- Native shell installation and runtime checks execute only on their matching runner platform; foreign-platform coverage remains deterministic compatibility metadata.
- Resource-intensive profile, Corepack, and transactional-filesystem integration files run in a narrow serialized phase, while unrelated test files retain parallel execution.
- Public CI retains source history so bundled-plugin provenance remains independently verifiable.
- Windows remains planned/experimental until native stable CI passes and `continue-on-error` is removed.

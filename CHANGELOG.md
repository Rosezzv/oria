# Changelog

All notable public releases of ORIA are documented in this file.

## [v0.1.0-alpha.3] - Update Awareness & Guided Upgrade

- **Unified Update Detection (`src/semver.ts`, `src/update.ts`)**: Shared by CLI and MCP with zero-dependency strict SemVer 2.0.0 comparison (BigInt core & numeric prerelease ordering: `alpha.10 > alpha.9`, `alpha < beta < rc < stable`), `stable` / `preview` channels, single-page automatic checks (latest 30 releases) and bounded same-origin manual pagination (up to 5 pages / 150 releases, retaining best per-channel releases), single-page URL-bound ETag caching, draft exclusion, prerelease-flag mismatch guards, downgrade refusal, and explicit availability status (`update_available`, `up_to_date`, `no_eligible_release`, `check_failed`, `not_checked`).
- **First-Use Consent, Local-First Default & Strict Privacy**: Defaults to offline with zero automatic network requests before explicit opt-in; corrupt or incomplete consent state fails closed to offline. Disabling stops future requests across processes, cancels in-process requests, and discards late responses. Enabled checks run on demand at most once every 24 hours (including failures) via anonymous public GitHub Releases requests with no vault content, paths, installed version, or device identifiers (GitHub still sees standard network metadata such as IP address). Remote release bodies are discarded, timestamps require strict ISO-8601 UTC, and URLs are reconstructed strictly from validated tags.
- **Non-Blocking Cross-Agent Update Awareness**: Shared user-scoped state in `~/.oria/update/` (strictly isolated outside all ORIA vault trees and never included in ZIP backups, while preserving user attachments with any filename). Core MCP knowledge tools and background refresh start/completion all use lock-free reads and 0ms fail-fast try-locks so lock contention or slow networks never stall reads, searches, or writes; non-TTY CLI commands and `--json` outputs never wait on network checks. Bounded `reminded_versions` prevents duplicate alerts across Claude Code, Codex, Antigravity, Grok Bot, and channel switches.
- **Read-Only Guided Upgrade (`src/upgrade-guide.ts`)**: `oria updates guide` and `oria_updates guide` inspect current version, install kind (metadata-only `--no-optional-locks` Git checks without scanning worktree content filters or exposing raw non-official Git remote URLs), and vault overlap warnings purely read-only, providing consistent stop-writes-first backup, nested-vault migration, side-by-side build, Agent restart, Skill reload/re-import, and verification steps. Alpha.3 intentionally omits automatic directory replacement and automatic rollback to keep the core minimal and protect user assets.

## [v0.1.0-alpha.2] - Reliability & Data Safety Update

- Preserve all portable files in backups, including metadata-like filenames. Refuse nonportable paths and nonempty destinations rather than silently omitting or removing files.
- Stage the existing directory entry and publish note replacements without overwriting external edits at the live path. Retain recoverable files on conflicts and resume interrupted replacements. Remove the staging link before success so subsequent editor saves, moves, renames, and deletions work normally.
- Decouple Markdown and import results from FTS. Recognized index corruption is repaired on search.
- Apply the secret guard to written metadata and restored content. Add consistent MCP data framing, safer installer quoting, and bilingual recovery instructions.
- Keep Markdown and ZIP formats compatible. Restart every client sharing a Vault when upgrading from Alpha.1.

## [v0.1.0-alpha.1] - 2026-11-24

Initial public Alpha release of ORIA — **Your AI changes. Your knowledge stays.**

### Added
- **Local-first Markdown Knowledge Core**: Stores notes as plain UTF-8 Markdown with YAML frontmatter under `~/.oria/vault/library/`, with no cloud account, remote server, or model API required.
- **Cross-Agent Access (CLI + stdio MCP + Skills)**:
  - Unified stdio MCP server exposing 8 tools (`oria_save`, `oria_search`, `oria_read`, `oria_update`, `oria_list`, `oria_archive`, `oria_history`, `oria_restore`) tested with **Claude Code**, **Codex**, and **Antigravity** on macOS arm64.
  - Local CLI adapter (`--agent grok-bot` / `ORIA_AGENT`) and dedicated [skills/oria-grok-bot/SKILL.md](skills/oria-grok-bot/SKILL.md) tested with **Grok Bot** via macOS local command execution (zero public tunnels or remote bridges).
  - Friendly macOS/Linux installer helper ([scripts/install.sh](scripts/install.sh)) that validates Node.js 24 LTS, builds ORIA, initializes `~/.oria/vault`, and prints copy-paste agent setup commands.
- **Multilingual Offline Search**: Built-in Node.js SQLite FTS5 `trigram` + short-term literal matching supporting English, 2-character Chinese terms, mixed-language queries, and codepoint-safe excerpts around emojis and NFD text.
- **Safe Cross-Agent Editing & Provenance**:
  - Trusted source attribution (`created_by`, `updated_by`, and immutable creation-source filename prefix).
  - Optimistic concurrency control (`expected_revision` full-file SHA-256) serialized by SQLite transactions.
  - `append` and single-match `patch` edits, shortening protection (`SHORTENING_PROTECTED`, CLI-only `--allow-rewrite`), and automatic pre-write byte-exact snapshots in `.oria-history/` with preview and restore.
- **Security, Resilience & Portable Backups**:
  - High-confidence secret/private-key guard (`SECRET_DETECTED`, CLI-only `--allow-secrets`) and explicit untrusted-data framing on MCP read/search responses.
  - Fault-isolated vault scanning (a single manually broken YAML file or Finder duplicate warns in `list` without locking out healthy notes) and automatic OS metadata filtering (`.DS_Store`, `Icon\r`, `._*`, `Thumbs.db`, `Desktop.ini`).
  - Portable Format-2 ZIP export and validated restore (`oria export` / `oria import`) covering notes, attachments, empty directories, and history snapshots with ZIP Slip, symlink, checksum, and size-limit protection.

### Known Alpha Limitations
- Real-device verification has been completed on **macOS arm64** only; Linux and Windows installation and cross-OS ZIP round-trips are not yet verified on real hardware.
- Automatic Skill triggering ("proactively offering to save") varies across agent harnesses and is still being refined.
- Exported ZIP archives are integrity-checked but **not encrypted**; treat them as private backups.
- V0.1 Alpha capacity limits: 10,000 entries, 2 MiB per note, 32 MiB per file, 256 MiB uncompressed backup total.

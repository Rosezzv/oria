# Changelog

All notable public releases of ORIA are documented in this file.

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

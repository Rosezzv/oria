# ORIA

[简体中文](README.md) | English

> **Your AI changes. Your knowledge stays.**

**A local-first, Markdown-first, user-owned knowledge layer for AI agents.**

If you move between **Claude Code**, **Codex**, **Antigravity**, and **Grok Bot**, your best research, architecture decisions, and project context end up scattered across chat transcripts and vendor-specific memory silos. ORIA is not another chatbot or proprietary memory plugin — it is a shared local Markdown vault that lives independently of any single AI harness:

- Distill durable work into readable Markdown from one agent using natural language.
- Switch to another agent, search for that note, and keep editing the **same file** without copy-pasting context.
- Browse or edit your files anytime in Finder, VS Code, or Obsidian, and export the entire vault as a portable ZIP whenever you move machines.

**Zero cloud account, zero remote backend, and zero model API required at runtime.**  
*(Privacy note: ORIA itself runs entirely offline on your machine, but any remote-model agent you connect may still transmit notes it reads to its underlying model provider.)*

---

## Core Features (V0.1 Alpha)

- **Markdown as the Single Source of Truth**: Every note is stored as plain UTF-8 Markdown with YAML frontmatter under `~/.oria/vault/library/`. Your files remain readable without ORIA, and the local SQLite search index can be deleted and rebuilt at any time.
- **One Vault Across Multiple Agents**: Connect **Claude Code**, **Codex**, and **Antigravity** via a unified stdio MCP server, connect **Grok Bot** via macOS local command execution (`oria mcp --agent grok-bot` is also supported for local stdio MCP clients), or operate directly from the standalone CLI.
- **Trusted Provenance**: Filenames and `created_by` / `updated_by` metadata track `claude-code`, `codex`, `antigravity`, and `grok-bot` (falling back to `unknown` when undeclared or unrecognized). For MCP hosts, agent identity is injected by the local server launch config (`--agent`) and cannot be overridden by model arguments; for Grok Bot local CLI execution, identity is declared via `--agent grok-bot` (or `ORIA_AGENT=grok-bot`). Cross-agent updates preserve the original filename and `created_by` while updating `updated_by`.
- **Built-in Safeguards Against Data Loss & Leaks**:
  - Updates verify `expected_revision` (full-file SHA-256). The old file moves into recoverable staging, then the new revision is published without clobbering an existing entry.
  - Supports `append` and exact single-match `patch` edits, with shortening protection (`SHORTENING_PROTECTED`) that blocks accidental full-body truncation (intentional rewrites require explicit `--allow-rewrite` in the CLI).
  - Automatically saves byte-exact pre-write snapshots under `.oria-history/` for preview and restore.
  - Checks for common high-confidence secret patterns in written bodies, metadata, and restored content (`SECRET_DETECTED`; explicit `--allow-secrets` override is CLI-only).
  - Wraps MCP read and search responses with explicit untrusted-data framing to reduce prompt-injection risk from stored notes.
- **Multilingual Offline Full-Text Search**: Powered by Node.js built-in SQLite FTS5 (`trigram`) combined with short-term literal matching. Supports English, two-character Chinese terms, and mixed Chinese/English multi-term AND queries (e.g. `部署 rollback`).
- **Daemon-Free & Fault-Tolerant**: No background file-watcher daemon. Each operation reconciles directly against disk, cleanly picking up manual edits, renames, and moves. A single damaged YAML file or duplicate ID raises an isolated warning in `list`.
- **Portable ZIP Backup & Verified Restore**: Format-2 backups bundle notes, attachments, empty directories, history snapshots, and a SHA-256 manifest. Imports validate against ZIP Slip, symlinks, checksum mismatches, size bombs, and accidental overwrites, then reconcile the search index on the next search.

---

## Cross-Agent Workflow

1. **Save from Claude Code**: Finish an analysis and say *"Save our local backup design to ORIA."* ORIA writes standalone Markdown with a stable UUID and `created_by: claude-code`.
2. **Continue in Codex**: Open Codex and say *"Find the local backup design in ORIA and add a rollback section."* Codex retrieves the same file, applies an `append` or `patch`, updates `updated_by: codex`, and ORIA snapshots the previous revision automatically.
3. **Review in Antigravity or Grok Bot**: Search, read the full note, or inspect past revisions without re-explaining prior context.
4. **Move Machines**: Run `oria export` to generate a portable ZIP, then `oria import` on a new directory or computer to restore everything and keep working.

---

## Quick Start

### System Requirements

- **Node.js 24 LTS** (uses built-in `node:sqlite`, so no native C++ build toolchain is needed)
- Network access to npm during dependency installation; everyday usage runs completely offline
- Optional: Git (when available, ORIA detects the current Git repository name as the default project)

### Installation

#### Option A: Guided Setup Script (Recommended)

```sh
git clone https://github.com/Rosezzv/oria.git
cd oria
./scripts/install.sh
```

The script checks for Node.js 24 LTS, installs dependencies, builds ORIA, initializes `~/.oria/vault`, and prints copy-paste configuration commands pre-filled with your actual local paths for **Claude Code**, **Codex**, **Antigravity**, and **Grok Bot**.

#### Option B: Manual Setup

```sh
git clone https://github.com/Rosezzv/oria.git
cd oria
npm ci
npm run build
node dist/cli.js init
```

Optionally run `npm link` to register `oria` globally. If your global npm prefix is not writable, replace `oria` with `node dist/cli.js` in the commands below.

The default vault path is `~/.oria/vault`. To use another location, pass `--vault /absolute/path` or set `ORIA_VAULT` (precedence: `--vault` > `ORIA_VAULT` > `~/.oria/vault`). **Point every connected agent to the same vault path.**

---

## Agent Integrations

Run the commands below from the root of your `oria` clone. Using the absolute Node.js binary path (`process.execPath`) ensures desktop hosts can locate Node 24 even when installed via version managers like `fnm` or `nvm`.

### 1. Claude Code & Codex

```sh
oria_node="$(node -p 'process.execPath')"
oria_cli="$PWD/dist/cli.js"
oria_vault="$HOME/.oria/vault"

# Register MCP server
claude mcp add --transport stdio --scope user oria -- \
  "$oria_node" "$oria_cli" mcp --agent claude-code --vault "$oria_vault"

codex mcp add oria -- \
  "$oria_node" "$oria_cli" mcp --agent codex --vault "$oria_vault"

# Install shared skill
mkdir -p "$HOME/.claude/skills/oria" "$HOME/.agents/skills/oria"
cp -i skills/oria/SKILL.md "$HOME/.claude/skills/oria/"
cp -i skills/oria/SKILL.md "$HOME/.agents/skills/oria/"
```

Verify registration with `claude mcp list` and `codex mcp list`.

> **Codex approval note**: Interactive Codex sessions may prompt before MCP write tools run. In dedicated non-interactive workflows, scope approval tightly to the specific tool and invocation — for example, pass `-c 'mcp_servers.oria.tools.oria_update.approval_mode="approve"'` to `codex exec` (see [Codex MCP docs](https://developers.openai.com/codex/mcp)).

### 2. Antigravity

Merge the following entry into your global `~/.gemini/config/mcp_config.json` (or workspace `.agents/mcp_config.json`), and copy `skills/oria/SKILL.md` to `~/.gemini/config/skills/oria/SKILL.md` (or workspace `.agents/skills/oria/SKILL.md`):

```json
{
  "mcpServers": {
    "oria": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/oria/dist/cli.js",
        "mcp",
        "--agent",
        "antigravity",
        "--vault",
        "/absolute/path/to/.oria/vault"
      ]
    }
  }
}
```

Then refresh MCP servers under **Skills & Customizations** (or **`...` > MCP Servers**) in Antigravity. See [Antigravity Customization Discovery](https://antigravity.google/docs/customization-discovery/) and [MCP Configuration](https://antigravity.google/docs/mcp).

### 3. Grok Bot (macOS Local Command Execution, Zero Public Exposure)

Grok Bot executes its primary session in a cloud Linux VM and cannot attach directly to a local `stdio` or `127.0.0.1` MCP server. Instead, ORIA reuses the built-in local command execution in `Grok Bot.app` (**Settings → Computer → Your computer → Execution on this computer**) to invoke the existing local CLI — **no public tunnel, no remote bridge daemon, and no compromise to local-first security**.

1. In **Grok Bot.app**, open **Settings → Computer → Your computer → Execution on this computer** and keep **Ask every time** enabled (recommended). Review the command, Vault path, and data before approving. Local execution grants command access to your machine. Absolute paths identify the program and `--agent` declares provenance. Output may be used by the cloud session. Keep the app open and your Mac unlocked while running commands.
2. Import [skills/oria-grok-bot/SKILL.md](skills/oria-grok-bot/SKILL.md) as a private Skill in Grok Bot and fill in your local absolute paths so non-interactive shells locate Node 24 cleanly:
   ```sh
   # Run from the ORIA repository root to print your local paths
   echo "NODE:  $(node -p 'process.execPath')"
   echo "CLI:   $PWD/dist/cli.js"
   echo "VAULT: $HOME/.oria/vault"
   ```
3. Ask Grok Bot to search, save, or update notes in ORIA on your local computer. It runs `node /.../dist/cli.js --vault "$HOME/.oria/vault" --agent grok-bot --json ...`, recording `created_by` / `updated_by: grok-bot` while preserving revision checks, history snapshots, multilingual search, and secret protection.

> **Notes**:
> - If you also use a local terminal agent that supports stdio MCP (such as xAI's `Grok Build` / `grok mcp`), you can register `oria mcp --agent grok-bot --vault "$HOME/.oria/vault"` directly.
> - Remote HTTPS MCP bridges (which require public endpoints and auth) are intentionally omitted in V0.1.

### MCP Tools (9 Tools)

| Tool | Purpose |
|---|---|
| `oria_save` | Save user-approved Markdown (supports explicit `project`, workspace `project_hint`, and `general` fallback) |
| `oria_search` | Full-text search globally or within a project (supports English, 2-char Chinese, and mixed-language queries) |
| `oria_read` | Read a note's Markdown and metadata by UUID, or preview a stored historical `revision` |
| `oria_update` | Update body (`append` or single-match `patch` recommended) or metadata using `expected_revision` (`clear_source_reference: true` clears source) |
| `oria_list` | List project counts, recent notes, and any isolated warnings for malformed/duplicate files |
| `oria_archive` | Mark a note as archived using `expected_revision` (content remains searchable and readable) |
| `oria_history` | List stored pre-write snapshots for a document UUID |
| `oria_restore` | Restore a user-confirmed historical snapshot as a new revision using the current `expected_revision` |
| `oria_updates` | Check current version/update status, run a manual check, opt in/out of daily checks, snooze, ignore a version, or show read-only safe upgrade guidance |

---

## Update Reminders & Upgrade Guide (Optional Network)

Update checks are **off by default**. ORIA makes zero automatic network requests unless you opt in, and disabling them keeps every core vault feature 100% offline.

- **How it works**: After your first normal ORIA task, your agent asks once whether to turn on update reminders. After that, manage it in plain language:
  - *"What version of ORIA am I running?"* / *"Check if ORIA has an update."*
  - *"Remind me when ORIA has updates."* / *"Remind me later."* / *"Ignore this version."* / *"Stop checking for updates."*
  - *"Show me how to upgrade ORIA."*
- **Privacy & low friction**: When enabled, ORIA checks public GitHub Releases on demand at most once every 24 hours (no background daemon, never blocks vault reads or writes). **No notes, paths, installed version, or device identifiers are sent** and there is no telemetry (GitHub still sees standard network metadata such as your IP address). State stays outside your vault in `~/.oria/update/` (never included in ZIP backups) and is shared across all four agents to avoid duplicate prompts.
- **Safe upgrades**: Alpha.3 provides a **read-only upgrade guide** rather than auto-replacing or deleting your directories. Run `oria updates guide` or ask your agent for step-by-step side-by-side instructions — always **stop all agents/editors writing to your vault first, then export a final backup**, install the new release alongside the old one, and refresh/reload your agent Skills (nested vaults are guided to migrate to an independent folder first; Grok Bot requires re-importing its Skill). See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details.

---

## CLI Usage

Every core operation works standalone from the terminal without any agent. All commands accept `--json` for scripting; run `oria --help` for full options:

```sh
# Save, search (including Chinese & mixed-language queries), list, and read
printf '%s\n' 'V0.1 decision: local Markdown vault with portable ZIP migration.' |
  oria save --title 'V0.1 Decision' --project ORIA --type decision
oria search 'portable'
oria search '部署 rollback'
oria list --project ORIA
oria read '<NOTE_UUID>'

# Local append, exact patch, history preview, restore, and archive
oria update '<NOTE_UUID>' --expected-revision '<CURRENT_HASH>' --append-file addition.md
oria update '<NOTE_UUID>' --expected-revision '<CURRENT_HASH>' --patch-file patch.json
oria history '<NOTE_UUID>'
oria read '<NOTE_UUID>' --revision '<HISTORICAL_HASH>'
oria restore '<NOTE_UUID>' --revision '<HISTORICAL_HASH>' --expected-revision '<CURRENT_HASH>'
oria archive '<NOTE_UUID>' --expected-revision '<CURRENT_HASH>'

# Version status, update checks, and read-only upgrade guidance
oria updates status
oria updates check                      # One-time manual check (does not change auto-check consent)
oria updates enable --channel preview   # Enable daily checks (stable or preview channel)
oria updates disable                    # Disable automatic checks (stay offline)
oria updates snooze --days 7            # Defer reminders for 7 days
oria updates ignore                     # Ignore the currently available version (higher versions still notify)
oria updates notice                     # Emit any pending consent/update notice
oria updates guide                      # Read-only inspection and safe side-by-side upgrade steps
```

- `patch.json` must be JSON with exact `{"find":"original passage","replace":"updated passage"}` where `find` matches exactly once.
- Intentional large rewrites or saving secret-like patterns can only be authorized explicitly via CLI flags `--allow-rewrite` / `--allow-secrets` (never exposed to MCP tools).

### Backup & Migration

```sh
oria export
oria --vault "$HOME/.oria/restored" import "/path/to/oria-backup.zip"
oria --vault "$HOME/.oria/restored" search 'portable'
```

- Exports default to `<vault>/.oria/backups/oria-*.zip` and print the full archive path.
- Imports target an empty vault (re-importing the exact same snapshot is idempotent); if the target vault contains different data, ORIA refuses to overwrite it.
- Plain attachments stored inside `library/` and referenced via relative Markdown links are preserved byte-for-byte with original path spelling.
- **Security note**: Exported ZIP archives verify integrity via SHA-256 and CRC32, but they are **not encrypted**. Store and transfer them as private data.

---

## Vault Directory Structure

```text
~/.oria/vault/
├── library/                        # User-owned assets (Source of Truth; included in ZIP backups)
│   ├── projects/
│   │   ├── oria/
│   │   │   └── claude-code-local-backup-design-25e75a22858e.md
│   │   └── general/
│   ├── attachments/                # Attachments (or place next to notes with relative links)
│   └── .oria-history/              # Byte-exact pre-write snapshots (by UUID / SHA-256)
└── .oria/                          # Rebuildable local runtime state (never Source of Truth)
    ├── coordination.sqlite         # Coordinates ORIA processes sharing a Vault
    ├── state.sqlite                # Rebuildable SQLite FTS5 cache
    ├── replacement/                # Current replacement journal, when present
    ├── recovered/                  # Conflict copies for review, when present
    ├── backups/                    # Default ZIP export directory
    └── staging/                    # Atomic write/import staging directory
```

---

## Validation Status & Known Limitations

- **Automated Test Suite**: `npm test` runs end-to-end and regression tests covering CLI, MCP, concurrent revision conflicts, Chinese/mixed/emoji search, single-file fault isolation, backup completeness, secret detection, ZIP safety & index rebuild, and cross-agent workflows.
- **Verified on Real Hardware (macOS arm64)**: Initial real-world verification completed with **Claude Code**, **Codex**, **Antigravity**, and **Grok Bot** (macOS local command execution).
- **Not Yet Verified on Real Hardware**: Linux and Windows installation, cross-OS ZIP round-trips, and consistent automatic Skill triggering ("proactively offering to save") across agent harnesses.
- **V0.1 Alpha Limits**: 10,000 entries, 2 MiB per note, 32 MiB per file, and 256 MiB uncompressed backup total (history snapshots count toward total capacity).
- **Explicit V0.1 Non-Goals**: Standalone desktop/web UI, cloud accounts or multi-device sync, vector embeddings / RAG, BYOK Q&A, and silent full-conversation capture.

---

### Upgrading from Alpha.1 and reviewing recovery copies

Stop older CLI/MCP processes sharing the Vault before starting the new version. Markdown, UUIDs, history paths, and ZIP formats remain compatible. Save and close the same file in any external editor before an ORIA write.

Backups preserve portable files byte for byte, including attachments whose names resemble OS metadata. A nonportable name such as Finder's `Icon\r` (with a literal carriage return) blocks export and the original stays intact. Import is for empty Vaults, and re-importing an identical snapshot is safe. `index_status: rebuild_on_search` confirms the assets have been published or already matched. The next search reconciles the index. Reading and backup work independently of the FTS cache.

A successful operation leaves no staging link to the live note. You can then save it in an external editor or move, rename, or delete it in your file manager. ORIA preserves a recovery copy if it detects that an editor kept writing to the old file.

On `RECOVERY_PENDING`, inspect the indicated `.oria/recovered/` or `.oria/replacement/` directory. Copy and compare the preserved version with the live file in `library/`, then merge or move the files to a safe location before retrying export. Pending copies block export to avoid omitting data. ORIA may miss writes through an old open file descriptor after the next ORIA operation.

## Alpha Testing & Feedback

ORIA is currently in **Alpha**. Feedback is welcome via [GitHub Issues](https://github.com/Rosezzv/oria/issues):

- Installation or setup friction (especially from non-technical users)
- Save, search, or partial-update issues across different agent harnesses
- Ideas for improving backup/restore, multilingual search, or note organization

> **Privacy Notice**: ORIA's source code is open source, but your vault belongs solely to you. Before opening an issue or sharing logs, strip out personal note contents, local paths, tokens, and secrets.

For deeper architecture notes and release history, see [ARCHITECTURE.md (Chinese)](ARCHITECTURE.md) and [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)

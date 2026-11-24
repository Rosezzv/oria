#!/usr/bin/env bash
# ORIA Alpha Installer Helper (macOS / Linux)
# Builds ORIA locally, initializes ~/.oria/vault, and prints ready-to-copy agent configs.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT_DIR="${ORIA_VAULT:-$HOME/.oria/vault}"

echo "=== ORIA Local Setup ==="
echo "Your AI changes. Your knowledge stays."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed."
  echo "Please install Node.js 24 LTS first: https://nodejs.org (or 'brew install node@24' on macOS)."
  exit 1
fi

NODE_BIN="$(node -p 'process.execPath')"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
NODE_VER="$(node -v)"

if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Error: Node.js 24 LTS or newer is required (found $NODE_VER at $NODE_BIN)."
  echo "Please install Node.js 24 LTS: https://nodejs.org (or 'brew install node@24' on macOS)."
  exit 1
fi

echo "[1/3] Installing dependencies and building ORIA ($NODE_VER)..."
cd "$ROOT_DIR"
npm ci
npm run build

echo "[2/3] Initializing local vault at $VAULT_DIR..."
"$NODE_BIN" "$ROOT_DIR/dist/cli.js" --vault "$VAULT_DIR" init

CLI_PATH="$ROOT_DIR/dist/cli.js"
VERSION="$("$NODE_BIN" "$CLI_PATH" --version)"

echo "[3/3] Done! ORIA $VERSION is ready."
echo ""
echo "Vault location: $VAULT_DIR"
echo "Markdown notes: $VAULT_DIR/library/projects/"
echo ""
echo "--- Copy-paste setup for your AI Agents ---"
echo ""
echo "1) Claude Code:"
echo "   claude mcp add --transport stdio --scope user oria -- \"$NODE_BIN\" \"$CLI_PATH\" mcp --agent claude-code --vault \"$VAULT_DIR\""
echo "   mkdir -p \"\$HOME/.claude/skills/oria\" && cp -i \"$ROOT_DIR/skills/oria/SKILL.md\" \"\$HOME/.claude/skills/oria/\""
echo ""
echo "2) Codex:"
echo "   codex mcp add oria -- \"$NODE_BIN\" \"$CLI_PATH\" mcp --agent codex --vault \"$VAULT_DIR\""
echo "   mkdir -p \"\$HOME/.agents/skills/oria\" && cp -i \"$ROOT_DIR/skills/oria/SKILL.md\" \"\$HOME/.agents/skills/oria/\""
echo ""
echo "3) Antigravity (~/.gemini/config/mcp_config.json):"
cat <<EOF
   {
     "mcpServers": {
       "oria": {
         "command": "$NODE_BIN",
         "args": ["$CLI_PATH", "mcp", "--agent", "antigravity", "--vault", "$VAULT_DIR"]
       }
     }
   }
EOF
echo "   mkdir -p \"\$HOME/.gemini/config/skills/oria\" && cp -i \"$ROOT_DIR/skills/oria/SKILL.md\" \"\$HOME/.gemini/config/skills/oria/\""
echo ""
echo "4) Grok Bot (macOS local execution):"
echo "   Import $ROOT_DIR/skills/oria-grok-bot/SKILL.md as a private Skill and set:"
echo "   NODE:  $NODE_BIN"
echo "   CLI:   $CLI_PATH"
echo "   VAULT: $VAULT_DIR"
echo ""
echo "Optional: run 'npm link' in $ROOT_DIR to use 'oria' directly in your terminal."

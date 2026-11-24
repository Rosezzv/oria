# ORIA

简体中文 | [English](README.en.md)

> **Your AI changes. Your knowledge stays.**

**Local-first、Markdown-first、User-owned 的跨 Agent 个人知识资产层。**

当你频繁在 **Claude Code**、**Codex**、**Antigravity**、**Grok Bot** 等不同 AI Agent 之间切换时，高价值的研究结论、架构决策、方案与项目上下文，往往会散落在各自的聊天记录或私有记忆里。ORIA 不再造一个聊天机器人，而是提供一个**独立于任何单一 AI 宿主**的本地 Markdown 知识库：

- 在一个 Agent 里用自然语言把成果沉淀成人类与 AI 都能直接读懂的 Markdown；
- 换到另一个 Agent，直接搜出来继续编辑**同一份文档**，无需手工复制粘贴或重新解释背景；
- 随时在 Finder / VS Code / Obsidian 里直接查看、修改，或一键导出为可迁移的 ZIP 带走。

**运行时零云端、零账号、零模型 API 依赖**（注：将笔记交给使用远程模型的 Agent 时，该 Agent 仍可能把读取到的内容发送给其对应的模型服务）。

---

## 核心特性（V0.1 Alpha）

- **Markdown 为唯一真相（Source of Truth）**：所有资产以纯 UTF-8 Markdown + YAML Frontmatter 存放在本地 `~/.oria/vault/library/`，脱离 ORIA 也能永久阅读；SQLite 检索索引随时可删可重建。
- **跨 Agent 共同维护同一份资产**：支持 **Claude Code**、**Codex**、**Antigravity** 通过统一 stdio MCP 接入，支持 **Grok Bot** 通过 macOS 本地命令执行接入（同时兼容 `oria mcp --agent grok-bot`），也可通过独立 CLI 在终端离线操作。
- **可信来源追踪**：文件名前缀与 `created_by` / `updated_by` 支持 `claude-code`、`codex`、`antigravity`、`grok-bot`（未声明或未识别记 `unknown`）。MCP 接入由本地启动参数 `--agent` 注入，拒绝模型自报家门；Grok Bot 本地 CLI 接入通过 `--agent grok-bot`（或 `ORIA_AGENT=grok-bot`）标记来源。跨 Agent 更新时不改文件名、保留原始创建者并更新最后修改者。
- **防误覆盖、防截断、防泄密**：
  - 更新通过全文件 SHA-256 的 `expected_revision` 处理冲突。旧文件先进入恢复暂存，新文件以不覆盖现有文件的方式发布；
  - 支持 `append`（追加）与精确单处匹配的 `patch`（局部替换），正文被清空或大幅缩短时触发 `SHORTENING_PROTECTED`（仅 CLI 支持 `--allow-rewrite` 显式授权）；
  - 每次更新前自动保留原字节历史快照（`.oria-history/`），支持历史预览与安全恢复；
  - 对正文、元数据和写入的历史内容检查常见敏感格式（`SECRET_DETECTED`，仅 CLI 支持 `--allow-secrets` 显式放行）；
  - MCP 读取与搜索结果附带不可信数据边界声明，降低知识库内容注入风险。
- **中英混排本地全文搜索**：内置 SQLite FTS5 `trigram` + 短词字面匹配，支持英文、两字中文词与中英混排多词 AND 检索（如 `部署 rollback`）。
- **容错与无 Daemon 设计**：无需常驻后台进程；每次操作按需对账磁盘，天然兼容人类手动编辑、重命名和移动文件；单篇损坏的 YAML 或重复 ID 会隔离告警，不锁死其余健康笔记。
- **可移植 ZIP 备份与校验恢复**：格式 2 备份包完整包含笔记、附件、空目录、历史原文与 SHA-256 清单；导入时严格防 ZIP Slip、符号链接、超限解压与目标数据误覆盖。导入结果独立于索引状态，搜索时自动重建索引。

---

## 典型体验闭环

1. **在 Claude Code 保存**：完成一份调研后说「把刚才的本地备份方案保存到 ORIA」→ 自动归档为可读 Markdown，记录 `created_by: claude-code` 与稳定 UUID。
2. **在 Codex 接力编辑**：打开 Codex 说「去 ORIA 找本地备份方案，补充回滚策略并更新」→ 命中同一文档，使用 `append` 或 `patch` 局部修改，`updated_by` 更新为 `codex`，修改前原文自动存入历史。
3. **在 Antigravity 复用与审查**：打开 Antigravity 直接搜索、读取原文或回看历史版本，无需重新传递背景。
4. **随时搬家**：运行 `oria export` 导出 ZIP，在新目录或新电脑 `oria import` 即可完整恢复并继续检索和编辑。

---

## 快速开始

### 环境要求

- **Node.js 24 LTS**（使用内置 `node:sqlite`，无原生 C++ 编译依赖）
- 安装依赖阶段需要访问 npm；构建完成后日常运行完全离线
- 安装 Git 时，ORIA 可自动识别当前 Git 仓库名作为默认项目

### 安装与初始化

#### 方式 A：一键安装脚本（推荐，适合快速上手）

```sh
git clone https://github.com/Rosezzv/oria.git
cd oria
./scripts/install.sh
```

脚本会自动检查 Node.js 24 LTS、安装依赖并构建 ORIA、初始化 `~/.oria/vault`，最后直接打印已填好你本机真实路径的 **Claude Code / Codex / Antigravity / Grok Bot** 接入命令，按提示复制即可。

#### 方式 B：手动分步安装

```sh
git clone https://github.com/Rosezzv/oria.git
cd oria
npm ci
npm run build
node dist/cli.js init
```

可选执行 `npm link` 将 `oria` 注册为全局命令；若全局 npm 目录不可写，用 `node dist/cli.js` 替代下文中的 `oria` 即可。

默认知识库路径为 `~/.oria/vault`。如需自定义路径，可通过 `--vault /绝对路径` 或环境变量 `ORIA_VAULT` 指定（优先级：`--vault` > `ORIA_VAULT` > `~/.oria/vault`）。**请确保所有 Agent 指向同一个 Vault 路径。**

---

## 连接你的 AI Agent

在 ORIA 仓库根目录执行。以下命令均使用当前 Node 的绝对路径，确保桌面应用宿主也能正确定位通过 `fnm`/`nvm` 等版本管理器安装的 Node 24。

### 1. Claude Code 与 Codex

```sh
oria_node="$(node -p 'process.execPath')"
oria_cli="$PWD/dist/cli.js"
oria_vault="$HOME/.oria/vault"

# 注册 MCP Server
claude mcp add --transport stdio --scope user oria -- \
  "$oria_node" "$oria_cli" mcp --agent claude-code --vault "$oria_vault"

codex mcp add oria -- \
  "$oria_node" "$oria_cli" mcp --agent codex --vault "$oria_vault"

# 安装共享 Skill
mkdir -p "$HOME/.claude/skills/oria" "$HOME/.agents/skills/oria"
cp -i skills/oria/SKILL.md "$HOME/.claude/skills/oria/"
cp -i skills/oria/SKILL.md "$HOME/.agents/skills/oria/"
```

可用 `claude mcp list` 和 `codex mcp list` 检查注册状态。

> **Codex 写入审批提示**：Codex 交互会话可能会弹出 MCP 写入审批。若在专用非交互场景下放行更新，建议将权限最小化到单次调用与单个工具，例如为 `codex exec` 传入 `-c 'mcp_servers.oria.tools.oria_update.approval_mode="approve"'`（参见 [Codex MCP 工具策略](https://developers.openai.com/codex/mcp)）。

### 2. Antigravity

将以下配置合并到全局 `~/.gemini/config/mcp_config.json`（或工作区 `.agents/mcp_config.json`），并将 `skills/oria/SKILL.md` 复制到 `~/.gemini/config/skills/oria/SKILL.md`（或工作区 `.agents/skills/oria/SKILL.md`）：

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

保存后在 Antigravity 左侧 **Skills & Customizations**（或右上角 **`...` > MCP Servers**）刷新即可生效。参见 [Antigravity 配置发现](https://antigravity.google/docs/customization-discovery/) · [MCP 配置](https://antigravity.google/docs/mcp)。

### 3. Grok Bot（macOS 本地命令执行接入，零公网暴露）

Grok Bot 的核心 Agent 运行在云端 Linux VM 中，无法直接连接本机的 `stdio` 或 `127.0.0.1` MCP，但它的 macOS 客户端（`Grok Bot.app`）支持在用户授权下直接在本机执行命令（**Settings → Computer → Your computer → Execution on this computer**）。ORIA 优先复用这一原生本地执行能力调用现有 CLI，**无需公网隧道、无需常驻桥接服务、不破坏 Local-first 架构**。

1. 在 **Grok Bot.app** 中打开 **Settings → Computer → Your computer → Execution on this computer**，推荐保持 **Ask every time**（每次本地执行前由你确认）。这项权限可运行本机命令。确认具体命令、Vault 路径和待返回内容后再放行。绝对路径用于定位程序，CLI 的 `--agent` 是来源声明。Grok Bot 可以将命令输出用于云端会话。使用时需保持应用运行且 Mac 未锁屏。
2. 在 Grok Bot 的 **Skills** 面板（或对话）中导入 [skills/oria-grok-bot/SKILL.md](skills/oria-grok-bot/SKILL.md) 作为私有 Skill，并将其中的 Node 24 与 ORIA 路径替换为你本机的绝对路径（防止非交互 Shell 找不到版本管理器安装的 Node）：
   ```sh
   # 在 ORIA 仓库根目录运行，获取需填入 Skill 的本地路径
   echo "NODE: $(node -p 'process.execPath')"
   echo "CLI:  $PWD/dist/cli.js"
   echo "VAULT: $HOME/.oria/vault"
   ```
3. 在 Grok Bot 对话中即可直接要求它「在我的本地电脑上用 ORIA 搜索/保存/更新 XX 笔记」——它会调用 `node /.../dist/cli.js --vault "$HOME/.oria/vault" --agent grok-bot --json ...`，自动写入 `created_by` / `updated_by: grok-bot`，完整复用修订校验、历史快照、中文检索和敏感信息拦截。

> **说明**：
> - 若你同时使用支持本地 stdio MCP 的终端工具（如 xAI `Grok Build` 的 `grok mcp`），也可以直接注册 `oria mcp --agent grok-bot --vault "$HOME/.oria/vault"`；
> - 如需在 Mac 离线/未开桌面端时从云端访问，才需要考虑 Remote HTTPS MCP Bridge（需公网出口与鉴权），V0.1 默认不引入。

### 使用的 8 个 MCP 工具

| 工具名 | 用途 |
|---|---|
| `oria_save` | 保存用户确认的 Markdown（支持显式 `project`、工作区 `project_hint` 与 `general` 安全回退） |
| `oria_search` | 全局或按项目全文检索（支持英文、两字中文与中英混排） |
| `oria_read` | 按 UUID 读取最新正文与元数据，或指定 `revision` 预览历史版本 |
| `oria_update` | 基于 `expected_revision` 更新正文（推荐 `append` / `patch`）或元数据（`clear_source_reference: true` 可清除来源） |
| `oria_list` | 列出所有项目统计、最近文档与异常文件告警 |
| `oria_archive` | 基于 `expected_revision` 归档文档（内容仍可搜索和读取） |
| `oria_history` | 列出指定文档已保存的历史快照 |
| `oria_restore` | 预览并经确认后，基于当前 `expected_revision` 恢复历史快照为新版本 |

---

## 独立 CLI 用法

即使不通过任何 Agent，也可以在终端直接使用全部核心能力（所有命令均支持 `--json` 便于脚本调用，运行 `oria --help` 查看完整参数）：

```sh
# 保存、搜索、列出与读取
printf '%s\n' 'V0.1 决策：本地 Markdown 与可移植 ZIP。' |
  oria save --title 'V0.1 决策' --project ORIA --type decision
oria search '可移植'
oria search '部署 rollback'
oria list --project ORIA
oria read '<笔记 UUID>'

# 局部追加、精确替换、历史预览与恢复
oria update '<笔记 UUID>' --expected-revision '<当前 Hash>' --append-file addition.md
oria update '<笔记 UUID>' --expected-revision '<当前 Hash>' --patch-file patch.json
oria history '<笔记 UUID>'
oria read '<笔记 UUID>' --revision '<历史 Hash>'
oria restore '<笔记 UUID>' --revision '<历史 Hash>' --expected-revision '<当前 Hash>'
oria archive '<笔记 UUID>' --expected-revision '<当前 Hash>'
```

- `patch.json` 格式为 `{"find":"原文片段","replace":"新片段"}`，`find` 必须在原文中恰好匹配一次。
- 如确需大幅重写或写入含敏感样式文本，仅可在终端显式附加 `--allow-rewrite` / `--allow-secrets`。

### 备份与迁移

```sh
oria export
oria --vault "$HOME/.oria/restored" import "/path/to/oria-backup.zip"
oria --vault "$HOME/.oria/restored" search '可移植'
```

- 默认导出至 `<vault>/.oria/backups/oria-*.zip`，并输出完整文件路径。
- 导入面向空 Vault，相同快照可重复导入。目标已有不同数据时返回冲突。便携文件按原字节保存，包括名字形似系统元数据的附件。若存在如 Finder `Icon\r`（真实名称含回车）的不可移植文件，导出会明确报错并保留原文件。
- 导入结果的 `index_status: rebuild_on_search` 表示资产已发布或已匹配，下次搜索再检查和重建索引。损坏的 FTS 缓存可以重建，读笔记和备份无需 FTS。
- 可以在 Markdown 中使用相对路径引用 `library/` 下的普通附件，备份会按原路径拼写与字节完整保留。
- **注意**：导出 ZIP 包含完整性校验但不做自动加密，请勿将其直接当作加密容器公开分享。

---

## Vault 目录结构

```text
~/.oria/vault/
├── library/                        # 用户真实资产（Source of Truth，完整纳入 ZIP 备份）
│   ├── projects/
│   │   ├── oria/
│   │   │   └── claude-code-本地备份决策-25e75a22858e.md
│   │   └── general/
│   ├── attachments/                # 附件目录（或放在任意笔记旁并用相对路径引用）
│   └── .oria-history/              # 修改前的原字节历史快照（按 UUID / SHA-256 存放）
└── .oria/                          # 本地可重建运行态（不作为真相源）
    ├── coordination.sqlite         # 同一 Vault 的 ORIA 进程之间协调
    ├── state.sqlite                # 可重建的 SQLite FTS5 缓存
    ├── replacement/                # 可恢复的当前替换记录（需要时存在）
    ├── recovered/                  # 等待人工核对的冲突副本（需要时存在）
    ├── backups/                    # 默认导出 ZIP 目录
    └── staging/                    # 原子写入/导入暂存目录
```

---

## 验证状态与已知边界

- **自动化测试**：运行 `npm test` 执行端到端与回归测试（CLI、MCP、并发冲突、中文/Emoji 检索、单文件损坏隔离、文件备份完整性、密钥拦截、ZIP 安全往返与索引重建，以及跨 Agent 读写更新）。
- **已真机初步实测（macOS arm64）**：Claude Code、Codex、Antigravity、Grok Bot（macOS 客户端本地命令执行接入）。
- **待补充验证**：Linux / Windows 真机安装与跨平台 ZIP 往返，以及各宿主 Skill 的自然语言自动触发稳定度。
- **V0.1 Alpha 容量上限**：10,000 个条目、单篇笔记 2 MiB、单文件 32 MiB、未压缩备份总容量 256 MiB（历史快照计入总容量）。
- **明确不做（V0.1 边界）**：独立 GUI App、云端账号与多设备实时同步、向量 Embedding / RAG、BYOK 问答、静默录制全量聊天记录。

### 从 Alpha.1 升级与核对恢复副本

升级前关闭连接同一 Vault 的旧版 CLI/MCP 进程，再统一启用新版。Markdown、UUID、历史目录与 ZIP 格式保持兼容。请在 ORIA 写入前让外部编辑器保存并关闭正在编辑的同一文件。

操作成功后，正文不保留暂存硬链接，可以照常在外部编辑器保存，或在文件管理器移动、改名和删除。若检测到旧文件被继续写入，则保留冲突副本。

如果收到 `RECOVERY_PENDING`，先检查错误中指向的 `.oria/recovered/` 或 `.oria/replacement/`。请先复制并比较留存原文与 `library/` 里的当前原文，把需要的内容合并或移至安全目录；处理完后再试导出。待核对的副本会阻止导出，以免漏备。保留先前文件句柄的外部编辑器如果迟至下一次 ORIA 操作之后才写入，仍无法保证其改动被捕获。

## 反馈与参与 Alpha 测试

当前处于 **Alpha 测试阶段**，欢迎通过 [GitHub Issues](https://github.com/Rosezzv/oria/issues) 反馈：
- 安装或配置过程中遇到的卡点（尤其欢迎非技术背景的使用反馈）；
- 不同 Agent 宿主下的保存、检索、局部更新体验问题；
- 备份恢复、中文检索或文档组织上的改进建议。

> **隐私提醒**：ORIA 的程序开源，但你的知识库永远只属于你自己。提交 Issue 或日志前，请务必移除个人笔记正文、私人路径、Token 或密钥。

更多设计细节与版本记录请见 [架构说明 (ARCHITECTURE.md)](ARCHITECTURE.md) 与 [更新日志 (CHANGELOG.md)](CHANGELOG.md)。

## License

[MIT](LICENSE)

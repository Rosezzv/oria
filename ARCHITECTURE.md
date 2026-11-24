# ORIA V0.1 架构

CLI 和 stdio MCP 使用同一个 Knowledge Core。Agent Skill 负责解释何时保存、如何建议归档与如何使用检索结果。项目采用 TypeScript、Node.js 24 LTS、内置 SQLite FTS5、YAML frontmatter、官方 MCP SDK 和流式 ZIP 库。许可证选用 MIT。

| 参考方案 | 与 ORIA 的关系 |
| --- | --- |
| Basic Memory | Python 3.12+、SQLAlchemy、SQLite、MCP，采用 AGPL-3.0-or-later。Markdown 本位和可重建索引值得参考。它以链接与知识图谱为主，直接采用会带来不同的数据模型、运行时与许可证。 |
| Memorix | Apache-2.0，Node 多包项目，涉及 SQLite、可选原生依赖、Hooks、同步和终端 Agent。各宿主有独立安装适配，值得参考。其默认数据模型以 Agent observation 和本地 SQLite 为中心。 |
| ORIA | 从零实现 Markdown vault、可移植备份、冲突校验。保持独立 CLI 与标准 stdio MCP。 |

来源：[Basic Memory 架构](https://docs.basicmemory.com/reference/technical-information)、[Basic Memory 依赖](https://github.com/basicmachines-co/basic-memory/blob/main/pyproject.toml)、[Memorix 仓库](https://github.com/AVIDS2/memorix)、[Memorix 依赖](https://github.com/AVIDS2/memorix/blob/main/package.json)。

## 数据与身份

- 默认地址是 `~/.oria/vault`。CLI 和 MCP 统一读取 `--vault`、`ORIA_VAULT` 或默认目录，优先级从左到右。
- `library/` 下是完整用户数据。新文档写入 `library/projects/<project>/<agent>-<title>-<id前缀>.md`。附件可放入 `library/attachments/` 或任意文档附近。`library/.oria-history/` 保留文档历史。`.oria/` 持有可重建的 SQLite 索引、备份和暂存文件。
- UUID 写在 frontmatter 中。在 `library/` 内重命名或移动 Markdown 保留 UUID，`project` 字段决定逻辑分类。修改项目只更新逻辑归属，原路径上的相对链接继续有效。
- 项目优先使用显式参数，其次是接入方提供的项目上下文，最终使用 `general`。CLI 可根据 Git 根目录名识别项目。MCP 可用会话的单一 Git workspace root，或使用 Skill 提交的项目建议。规范化和路径校验在 Core 完成。
- MCP Agent 身份只由本地启动配置（`--agent` 或 `ORIA_AGENT`）决定，MCP 工具参数拒绝模型传入来源字段；CLI 也支持显式 `--agent` 或 `ORIA_AGENT`（供 Grok Bot 等本地命令执行宿主标注 `grok-bot` 来源），未声明或无法识别时统一回退为 `unknown`。需诚实说明：本地 CLI 模式的 `--agent` 属于本机命令级声明，而 MCP 模式对模型不可覆盖。手动编辑 Markdown 时，现有字段记录最近一次经 ORIA 写入的来源。
- 生成文件名时统一为 NFC，路径验证与冲突检测也使用 NFC。用户在文件系统里写下的路径按原有拼写读写和打包，手工编辑的附件链接可以保持原样。在规范化敏感的系统上，改动相对文件名或手动移动笔记仍可能需要用户调整原有链接。

## 查询与版本控制

- 每次操作按需扫描磁盘，通过文件内容 SHA-256 识别更新，兼容修改、移动、重命名和删除。系统文件名不参与备份过滤。日常笔记扫描只跳过通过文件类型检查的非便携 Finder 图标文件。日常读/搜/列/写遇到无关单篇损坏 YAML 或重复 ID 时会隔离告警而不锁死健康笔记，`export`/`import` 保持全库严格校验。FTS5 trigram 对 NFC 规范化的标题、正文和标签建立索引；空格分隔的词按 AND 查询，长度小于三个 Unicode 字符的词以字面子串匹配，摘要按 Unicode 码点切片避免截断代理项。FTS 使用 `.oria/state.sqlite`，读笔记、备份和导入无需打开它。搜索发现损坏数据库或不兼容索引 schema 时重建。`.oria/coordination.sqlite` 用于跨进程锁。升级时停止使用该 Vault 的所有旧版 ORIA 进程。
- `revision` 是完整 Markdown 字节的 SHA-256，涵盖 frontmatter 和正文。更新、归档与恢复均在 Core 校验 `expected_revision`。旧参数 `version`（CLI 的 `--version`）作为兼容别名。追加保留原正文，按需添加一个段落间隔。局部替换要求原文精确匹配一次。MCP 通过 `clear_source_reference: true` 清除来源，避免在工具 Schema 中暴露不兼容正则或 `anyOf: [string, null]`。
- 非空正文被清空，或者正文少掉至少 100 个非空白 Unicode 字符且剩余不足 70% 时，Core 报 `SHORTENING_PROTECTED`；检测到高置信度私钥或常见平台 Token 时，Core 报 `SECRET_DETECTED`。CLI 的 `--allow-rewrite` 与 `--allow-secrets` 仅由用户在终端显式授权，MCP schema 不暴露这两个开关。MCP 工具返回的文本附带不可信数据边界提示。保存、更新、归档和恢复扫描即将写入的完整文档。已有历史和 ZIP 保留原字节。所有写入仍须校验当前 Hash。
- Core 先保存旧文件原文至 `.oria-history/<UUID>/<SHA-256>.md`。随后把磁盘上的旧目录条目移到持久暂存位置，对实际移走的文件重新校验 Hash，再通过独占硬链接发布新文件。要求同一个支持硬链接的本地文件系统。若外部程序占据目标名，其文件与旧副本都会被保留。先使发布标记持久化，再清理新正文的暂存硬链接。中断且无发布标记时，以实际文件身份判断是否已经发布。发布标记存在后，后续编辑、移动或删除不触发冲突，复核仅针对旧文件句柄。
- 下一次 ORIA 操作会检查外部程序是否通过旧文件句柄继续写入。发现差异时保留到 `.oria/recovered/` 并告警，导出在处理前返回 `RECOVERY_PENDING`。旧句柄迟于下一次操作的写入仍有风险，同一正文应避免并行编辑。两次目录操作之间存在可恢复的路径缺席窗口。UUID、原路径、创建归属与历史格式保持不变。手动删除当前文件后，已有历史仍可读取。

ORIA 笔记由 UTF-8 Markdown 和 YAML frontmatter 组成。当前格式为 `oria_format: 1`，包含 `id`、`title`、`project`、`type`、`created_at`、`updated_at`、`created_by`、`updated_by` 和 `tags`。可选字段包括来源 `source_reference` 和归档时间 `archived_at`。时间用 ISO 8601，默认生成 UTC 时间。其它普通文件可以留在同一目录树中。

## 备份

ZIP 根目录包含 `oria-manifest.json` 和 `library/` 内的内容。格式 2 随笔记迁移全部文档历史、附件与相对路径。格式 1 可恢复已有笔记和附件，`.oria-history` 目录自格式 2 起保留。清单记录格式版本、目录、文件大小和 SHA-256。导入验证清单、CRC、哈希、路径、文件类型、文档及历史快照的 ID 和文件名哈希，再原子发布到空 vault。相同的备份可重复导入，有差异的非空目标返回冲突，导入过程不按名称删除文件。成功导入返回资产状态与 `index_status: rebuild_on_search`。目录刷盘失败时另附持久性告警。完整备份由 CLI 显式操作。ZIP 完整性检查可检出损坏，格式没有签名或加密。历史快照保存的是 Markdown，当年的附件版本需在当年的完整 ZIP 中查找。

路径按大小写及 Unicode 等价检查重复，拒绝路径穿越、Windows 保留名称、链接和特殊文件。文件操作以本地用户专有的 vault 为边界。不要把 vault 或其上级目录交给同一台机器上的不受信任进程修改。

## 宿主接入依据

- Claude Code 接受 stdio MCP，个人技能目录为 `~/.claude/skills`。[MCP](https://code.claude.com/docs/en/mcp) · [Skills](https://code.claude.com/docs/en/skills)
- Codex 接受 stdio MCP，个人技能目录为 `~/.agents/skills`。[MCP](https://developers.openai.com/codex/mcp) · [Skills](https://developers.openai.com/codex/skills)
- Antigravity App 和 CLI 的个人技能目录可共用 `~/.gemini/config/skills`。MCP 使用 `mcp_config.json`。[配置发现](https://antigravity.google/docs/customization-discovery/) · [MCP](https://antigravity.google/docs/mcp)
- Grok Bot（`com.anysphere.sand`）的核心会话与云端 MCP 客户端运行在云端 Linux VM 中，无法直连本机 `stdio`/`127.0.0.1` MCP；通过其 macOS 客户端内置的本地命令执行（**Settings → Computer → Your computer → Execution on this computer**）调用 ORIA CLI（`--agent grok-bot --json`）并配合 `skills/oria-grok-bot/SKILL.md` 复用现有 Core，无需公网隧道或额外常驻服务。本地 stdio MCP 客户端（如 `Grok Build`）也可直接使用 `oria mcp --agent grok-bot`。

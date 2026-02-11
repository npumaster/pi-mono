> pi 可以创建技能。让它为你的用例构建一个。

# 技能

技能是 agent 按需加载的独立能力包。技能提供特定任务的专用工作流、设置说明、辅助脚本和参考文档。

Pi 实现了 [Agent Skills 标准](https://agentskills.io/specification)，对违规行为会发出警告，但保持宽容。

## 目录

- [位置](#位置)
- [技能如何工作](#技能如何工作)
- [技能命令](#技能命令)
- [技能结构](#技能结构)
- [Frontmatter](#frontmatter)
- [验证](#验证)
- [示例](#示例)
- [技能仓库](#技能仓库)

## 位置

> **安全提示：** 技能可以指示模型执行任何操作，并且可能包含模型调用的可执行代码。使用前请审查技能内容。

Pi 从以下位置加载技能：

- 全局：`~/.pi/agent/skills/`
- 项目：`.pi/skills/`
- 包：`package.json` 中的 `skills/` 目录或 `pi.skills` 条目
- 设置：包含文件或目录的 `skills` 数组
- CLI：`--skill <path>`（可重复，即使使用 `--no-skills` 也是累加的）

发现规则：
- 技能目录根目录下的直接 `.md` 文件
- 子目录下的递归 `SKILL.md` 文件

使用 `--no-skills` 禁用发现（显式的 `--skill` 路径仍会加载）。

### 使用来自其他 Harness 的技能

要使用来自 Claude Code 或 OpenAI Codex 的技能，请将其目录添加到设置中：

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

对于项目级 Claude Code 技能，添加到 `.pi/settings.json`：

```json
{
  "skills": ["../.claude/skills"]
}
```

## 技能如何工作

1. 启动时，pi 扫描技能位置并提取名称和描述
2. 系统提示包含符合 [规范](https://agentskills.io/integrate-skills) 的 XML 格式的可用技能
3. 当任务匹配时，agent 使用 `read` 加载完整的 SKILL.md（模型并不总是这样做；使用提示或 `/skill:name` 强制执行）
4. agent 遵循说明，使用相对路径引用脚本和资产

这是渐进式披露：只有描述始终在上下文中，完整的说明按需加载。

## 技能命令

技能注册为 `/skill:name` 命令：

```bash
/skill:brave-search           # 加载并执行技能
/skill:pdf-tools extract      # 加载带参数的技能
```

命令后的参数作为 `User: <args>` 附加到技能内容中。

通过交互模式下的 `/settings` 或 `settings.json` 切换技能命令：

```json
{
  "enableSkillCommands": true
}
```

## 技能结构

技能是一个包含 `SKILL.md` 文件的目录。其他一切都是自由形式的。

```
my-skill/
├── SKILL.md              # 必需：frontmatter + 说明
├── scripts/              # 辅助脚本
│   └── process.sh
├── references/           # 按需加载的详细文档
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md 格式

```markdown
---
name: my-skill
description: 这个技能做什么以及何时使用它。要具体。
---

# My Skill

## Setup

首次使用前运行一次：
\`\`\`bash
cd /path/to/skill && npm install
\`\`\`

## Usage

\`\`\`bash
./scripts/process.sh <input>
\`\`\`
```

使用相对于技能目录的相对路径：

```markdown
详见 [参考指南](references/REFERENCE.md)。
```

## Frontmatter

根据 [Agent Skills 规范](https://agentskills.io/specification#frontmatter-required)：

| 字段 | 必需 | 描述 |
|-------|----------|-------------|
| `name` | 是 | 最多 64 个字符。小写 a-z, 0-9, 连字符。必须与父目录匹配。 |
| `description` | 是 | 最多 1024 个字符。技能做什么以及何时使用它。 |
| `license` | 否 | 许可证名称或对捆绑文件的引用。 |
| `compatibility` | 否 | 最多 500 个字符。环境要求。 |
| `metadata` | 否 | 任意键值映射。 |
| `allowed-tools` | 否 | 预批准工具的空格分隔列表（实验性）。 |
| `disable-model-invocation` | 否 | 当为 `true` 时，技能从系统提示中隐藏。用户必须使用 `/skill:name`。 |

### 命名规则

- 1-64 个字符
- 仅小写字母、数字、连字符
- 无前导/尾随连字符
- 无连续连字符
- 必须与父目录名称匹配

有效：`pdf-processing`, `data-analysis`, `code-review`
无效：`PDF-Processing`, `-pdf`, `pdf--processing`

### 描述最佳实践

描述决定了 agent 何时加载技能。要具体。

好：
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

差：
```yaml
description: Helps with PDFs.
```

## 验证

Pi 根据 Agent Skills 标准验证技能。大多数问题会产生警告，但仍会加载技能：

- 名称与父目录不匹配
- 名称超过 64 个字符或包含无效字符
- 名称以连字符开头/结尾或包含连续连字符
- 描述超过 1024 个字符

未知的 frontmatter 字段被忽略。

**例外：** 缺少描述的技能不会被加载。

名称冲突（来自不同位置的相同名称）会发出警告并保留找到的第一个技能。

## 示例

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
```markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

\`\`\`bash
cd /path/to/brave-search && npm install
\`\`\`

## Search

\`\`\`bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
\`\`\`

## Extract Page Content

\`\`\`bash
./content.js https://example.com
\`\`\`
```

## 技能仓库

- [Anthropic Skills](https://github.com/anthropics/skills) - 文档处理 (docx, pdf, pptx, xlsx), web 开发
- [Pi Skills](https://github.com/badlogic/pi-skills) - 网络搜索, 浏览器自动化, Google APIs, 转录

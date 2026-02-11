# 🏖️ OSS Vacation

**问题追踪器和 PR 将于 2026 年 2 月 16 日重新开放。**

在此之前，所有 PR 都将被自动关闭。获批准的贡献者可以在假期后提交 PR 而无需重新批准。如需支持，请加入 [Discord](https://discord.com/invite/3cU7Bz4UPx)。

---

<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="pi logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@mariozechner/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@mariozechner/pi-coding-agent?style=flat-square" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由以下机构慷慨捐赠
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

Pi 是一个极简的终端编码工具。让 Pi 适应你的工作流，而不是反过来，无需 fork 和修改 Pi 的内部结构。通过 TypeScript [扩展](#扩展)、[技能](#技能)、[提示词模板](#提示词模板)和[主题](#主题)来扩展它。将你的扩展、技能、提示词模板和主题放在 [Pi 包](#pi-包)中，并通过 npm 或 git 与他人分享。

Pi 附带强大的默认设置，但跳过了子智能体和计划模式等功能。相反，你可以要求 Pi 构建你想要的东西，或者安装符合你工作流的第三方 Pi 包。

Pi 在四种模式下运行：交互式、打印或 JSON、用于进程集成的 RPC，以及用于嵌入到你自己的应用程序中的 SDK。查看 [openclaw/openclaw](https://github.com/openclaw/openclaw) 了解真实的 SDK 集成案例。

## 目录

- [快速开始](#快速开始)
- [提供者与模型](#提供者与模型)
- [交互模式](#交互模式)
  - [编辑器](#编辑器)
  - [命令](#命令)
  - [键盘快捷键](#键盘快捷键)
  - [消息队列](#消息队列)
- [会话](#会话)
  - [分支](#分支)
  - [压缩](#压缩)
- [设置](#设置)
- [上下文文件](#上下文文件)
- [自定义](#自定义)
  - [提示词模板](#提示词模板)
  - [技能](#技能)
  - [扩展](#扩展)
  - [主题](#主题)
  - [Pi 包](#pi-包)
- [编程用法](#编程用法)
- [理念](#理念)
- [CLI 参考](#cli-参考)

---

## 快速开始

```bash
npm install -g @mariozechner/pi-coding-agent
```

使用 API 密钥进行身份验证：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

或者使用你现有的订阅：

```bash
pi
/login  # 然后选择提供者
```

然后直接与 Pi 交谈。默认情况下，Pi 为模型提供四个工具：`read`、`write`、`edit` 和 `bash`。模型使用这些工具来完成你的请求。通过 [技能](#技能)、[提示词模板](#提示词模板)、[扩展](#扩展) 或 [Pi 包](#pi-包) 添加功能。

**平台说明：** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [终端设置](docs/terminal-setup.md) | [Shell 别名](docs/shell-aliases.md)

---

## 提供者与模型

对于每个内置提供者，Pi 维护一个支持工具的模型列表，随每个版本更新。通过订阅 (`/login`) 或 API 密钥进行身份验证，然后通过 `/model` (或 Ctrl+L) 选择该提供者的任何模型。

**订阅：**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Gemini CLI
- Google Antigravity

**API 密钥：**
- Anthropic
- OpenAI
- Azure OpenAI
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- OpenCode Zen
- Hugging Face
- Kimi For Coding
- MiniMax

有关详细的设置说明，请参阅 [docs/providers.md](docs/providers.md)。

**自定义提供者与模型：** 如果它们支持受支持的 API (OpenAI, Anthropic, Google)，可以通过 `~/.pi/agent/models.json` 添加提供者。对于自定义 API 或 OAuth，请使用扩展。参见 [docs/models.md](docs/models.md) 和 [docs/custom-provider.md](docs/custom-provider.md)。

---

## 交互模式

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

界面从上到下：

- **启动标题** - 显示快捷键（`/hotkeys` 查看所有）、加载的 AGENTS.md 文件、提示词模板、技能和扩展
- **消息** - 你的消息、助手响应、工具调用和结果、通知、错误和扩展 UI
- **编辑器** - 你输入的地方；边框颜色指示思考级别
- **页脚** - 工作目录、会话名称、总 Token/缓存使用量、成本、上下文使用量、当前模型

编辑器可以被其他 UI 临时替换，例如内置的 `/settings` 或来自扩展的自定义 UI（例如，允许用户以结构化格式回答模型问题的问答工具）。[扩展](#扩展) 还可以替换编辑器、在其上方/下方添加小部件、状态行、自定义页脚或覆盖层。

### 编辑器

| 功能 | 方法 |
|---------|-----|
| 文件引用 | 输入 `@` 模糊搜索项目文件 |
| 路径补全 | Tab 键补全路径 |
| 多行 | Shift+Enter (Windows Terminal 上为 Ctrl+Enter) |
| 图像 | Ctrl+V 粘贴，或拖拽到终端 |
| Bash 命令 | `!command` 运行并将输出发送给 LLM，`!!command` 运行但不发送 |

标准的编辑快捷键用于删除单词、撤消等。参见 [docs/keybindings.md](docs/keybindings.md)。

### 命令

在编辑器中输入 `/` 触发命令。[扩展](#扩展) 可以注册自定义命令，[技能](#技能) 可作为 `/skill:name` 使用，[提示词模板](#提示词模板) 通过 `/templatename` 展开。

| 命令 | 描述 |
|---------|-------------|
| `/login`, `/logout` | OAuth 身份验证 |
| `/model` | 切换模型 |
| `/scoped-models` | 启用/禁用 Ctrl+P 循环的模型 |
| `/settings` | 思考级别、主题、消息传递 |
| `/resume` | 从以前的会话中选择 |
| `/new` | 开始新会话 |
| `/name <name>` | 设置会话显示名称 |
| `/session` | 显示会话信息（路径、Token、成本） |
| `/tree` | 跳转到会话中的任何点并从那里继续 |
| `/fork` | 从当前分支创建一个新会话 |
| `/compact [prompt]` | 手动压缩上下文，可选自定义指令 |
| `/copy` | 将最后一条助手消息复制到剪贴板 |
| `/export [file]` | 将会话导出为 HTML 文件 |
| `/share` | 上传为带有可共享 HTML 链接的私有 GitHub gist |
| `/reload` | 重新加载扩展、技能、提示词、上下文文件（主题会自动热重载） |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit`, `/exit` | 退出 Pi |

### 键盘快捷键

查看 `/hotkeys` 获取完整列表。通过 `~/.pi/agent/keybindings.json` 自定义。参见 [docs/keybindings.md](docs/keybindings.md)。

**常用：**

| 按键 | 动作 |
|-----|--------|
| Ctrl+C | 清除编辑器 |
| Ctrl+C 两次 | 退出 |
| Escape | 取消/中止 |
| Escape 两次 | 打开 `/tree` |
| Ctrl+L | 打开模型选择器 |
| Ctrl+P / Shift+Ctrl+P | 向前/向后循环范围内的模型 |
| Shift+Tab | 循环思考级别 |
| Ctrl+O | 折叠/展开工具输出 |
| Ctrl+T | 折叠/展开思考块 |

### 消息队列

在智能体工作时提交消息：

- **Enter** 排队一条 *导向* 消息，在当前工具执行后传递（中断剩余工具）
- **Alt+Enter** 排队一条 *后续* 消息，仅在智能体完成所有工作后传递
- **Escape** 中止并将排队的消息恢复到编辑器
- **Alt+Up** 将排队的消息检索回编辑器

在 [设置](docs/settings.md) 中配置传递：`steeringMode` 和 `followUpMode` 可以是 `"one-at-a-time"`（默认，等待响应）或 `"all"`（一次性传递所有排队消息）。

---

## 会话

会话存储为具有树结构的 JSONL 文件。每个条目都有 `id` 和 `parentId`，允许在不创建新文件的情况下进行就地分支。有关文件格式，请参阅 [docs/session.md](docs/session.md)。

### 管理

会话自动保存到 `~/.pi/agent/sessions/`，按工作目录组织。

```bash
pi -c                  # 继续最近的会话
pi -r                  # 浏览并选择过去的会话
pi --no-session        # 临时模式（不保存）
pi --session <path>    # 使用特定会话文件或 ID
```

### 分支

**`/tree`** - 就地导航会话树。选择任何以前的点，从那里继续，并在分支之间切换。所有历史记录保存在单个文件中。

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- 通过输入搜索，用 ←/→ 翻页
- 过滤模式 (Ctrl+O): 默认 → 无工具 → 仅用户 → 仅标记 → 全部
- 按 `l` 将条目标记为书签

**`/fork`** - 从当前分支创建一个新的会话文件。打开选择器，复制到选定点的历史记录，并将该消息放在编辑器中进行修改。

### 压缩

长会话可能会耗尽上下文窗口。压缩总结旧消息，同时保留最近的消息。

**手动：** `/compact` 或 `/compact <custom instructions>`

**自动：** 默认启用。在上下文溢出（恢复并重试）或接近限制（主动）时触发。通过 `/settings` 或 `settings.json` 配置。

压缩是有损的。完整的历史记录保留在 JSONL 文件中；使用 `/tree` 重新访问。通过 [扩展](#扩展) 自定义压缩行为。有关内部结构，请参阅 [docs/compaction.md](docs/compaction.md)。

---

## 设置

使用 `/settings` 修改常用选项，或直接编辑 JSON 文件：

| 位置 | 范围 |
|----------|-------|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `.pi/settings.json` | 项目（覆盖全局） |

有关所有选项，请参阅 [docs/settings.md](docs/settings.md)。

---

## 上下文文件

Pi 在启动时从以下位置加载 `AGENTS.md`（或 `CLAUDE.md`）：
- `~/.pi/agent/AGENTS.md`（全局）
- 父目录（从 cwd 向上查找）
- 当前目录

用于项目说明、约定、常用命令。所有匹配的文件都会被连接起来。

### 系统提示词

使用 `.pi/SYSTEM.md`（项目）或 `~/.pi/agent/SYSTEM.md`（全局）替换默认系统提示词。通过 `APPEND_SYSTEM.md` 追加而不替换。

---

## 自定义

### 提示词模板

作为 Markdown 文件的可重用提示词。输入 `/name` 展开。

```markdown
<!-- ~/.pi/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

放置在 `~/.pi/agent/prompts/`、`.pi/prompts/` 或 [Pi 包](#pi-包) 中以与他人共享。参见 [docs/prompt-templates.md](docs/prompt-templates.md)。

### 技能

遵循 [Agent Skills 标准](https://agentskills.io) 的按需功能包。通过 `/skill:name` 调用或让智能体自动加载它们。

```markdown
<!-- ~/.pi/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

放置在 `~/.pi/agent/skills/`、`.pi/skills/` 或 [Pi 包](#pi-包) 中以与他人共享。参见 [docs/skills.md](docs/skills.md)。

### 扩展

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript 模块，使用自定义工具、命令、键盘快捷键、事件处理程序和 UI 组件扩展 Pi。

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

**可能实现的功能：**
- 自定义工具（或完全替换内置工具）
- 子智能体和计划模式
- 自定义压缩和总结
- 权限门控和路径保护
- 自定义编辑器和 UI 组件
- 状态行、页眉、页脚
- Git 检查点和自动提交
- SSH 和沙箱执行
- MCP 服务器集成
- 让 Pi 看起来像 Claude Code
- 等待时的游戏（是的，可以运行 Doom）
- ...你能想到的任何东西

放置在 `~/.pi/agent/extensions/`、`.pi/extensions/` 或 [Pi 包](#pi-包) 中以与他人共享。参见 [docs/extensions.md](docs/extensions.md) 和 [examples/extensions/](examples/extensions/)。

### 主题

内置：`dark`、`light`。主题热重载：修改活动主题文件，Pi 会立即应用更改。

放置在 `~/.pi/agent/themes/`、`.pi/themes/` 或 [Pi 包](#pi-包) 中以与他人共享。参见 [docs/themes.md](docs/themes.md)。

### Pi 包

通过 npm 或 git 捆绑和共享扩展、技能、提示词和主题。在 [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) 或 [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628) 上查找包。

> **安全：** Pi 包以完整的系统访问权限运行。扩展执行任意代码，技能可以指示模型执行任何操作，包括运行可执行文件。在安装第三方包之前，请检查源代码。

```bash
pi install npm:@foo/pi-tools
pi install npm:@foo/pi-tools@1.2.3      # 固定版本
pi install git:github.com/user/repo
pi install git:github.com/user/repo@v1  # 标签或提交
pi install https://github.com/user/repo
pi remove npm:@foo/pi-tools
pi list
pi update                               # 更新包（跳过固定版本）
pi config                               # 启用/禁用扩展、技能、提示词、主题
```

包安装到 `~/.pi/agent/git/` (git) 或全局 npm。使用 `-l` 进行项目本地安装 (`.pi/git/`、`.pi/npm/`)。

通过在 `package.json` 中添加 `pi` 键来创建包：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

如果没有 `pi` 清单，Pi 会自动从常规目录（`extensions/`、`skills/`、`prompts/`、`themes/`）中发现。

参见 [docs/packages.md](docs/packages.md)。

---

## 编程用法

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: new AuthStorage(),
  modelRegistry: new ModelRegistry(authStorage),
});

await session.prompt("What files are in the current directory?");
```

参见 [docs/sdk.md](docs/sdk.md) 和 [examples/sdk/](examples/sdk/)。

### RPC 模式

对于非 Node.js 集成，请使用 stdin/stdout 上的 RPC 模式：

```bash
pi --mode rpc
```

有关协议，请参阅 [docs/rpc.md](docs/rpc.md)。

---

## 理念

Pi 具有极强的可扩展性，因此它不必强行规定你的工作流。其他工具内置的功能可以通过 [扩展](#扩展)、[技能](#技能) 构建，或从第三方 [Pi 包](#pi-包) 安装。这保持了核心的极简，同时让你能够塑造 Pi 以适应你的工作方式。

**无 MCP。** 使用 README 构建 CLI 工具（参见 [技能](#技能)），或构建添加 MCP 支持的扩展。[为什么？](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**无子智能体。** 这样做有很多方法。通过 tmux 生成 Pi 实例，或使用 [扩展](#扩展) 构建你自己的，或安装以你的方式执行此操作的包。

**无权限弹窗。** 在容器中运行，或根据你的环境和安全要求使用 [扩展](#扩展) 构建你自己的确认流程。

**无计划模式。** 将计划写入文件，或使用 [扩展](#扩展) 构建它，或安装一个包。

**无内置待办事项。** 它们会使模型混淆。使用 TODO.md 文件，或使用 [扩展](#扩展) 构建你自己的。

**无后台 bash。** 使用 tmux。完全的可观测性，直接交互。

阅读 [博客文章](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) 了解完整的理由。

---

## CLI 参考

```bash
pi [options] [@files...] [messages...]
```

### 包命令

```bash
pi install <source> [-l]    # 安装包，-l 表示项目本地
pi remove <source> [-l]     # 移除包
pi update [source]          # 更新包（跳过固定版本）
pi list                     # 列出已安装的包
pi config                   # 启用/禁用包资源
```

### 模式

| 标志 | 描述 |
|------|-------------|
| (默认) | 交互模式 |
| `-p`, `--print` | 打印响应并退出 |
| `--mode json` | 将所有事件输出为 JSON 行（参见 [docs/json.md](docs/json.md)） |
| `--mode rpc` | 用于进程集成的 RPC 模式（参见 [docs/rpc.md](docs/rpc.md)） |
| `--export <in> [out]` | 将会话导出为 HTML |

### 模型选项

| 选项 | 描述 |
|--------|-------------|
| `--provider <name>` | 提供者 (anthropic, openai, google 等) |
| `--model <id>` | 模型 ID |
| `--api-key <key>` | API 密钥（覆盖环境变量） |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | 用于 Ctrl+P 循环的逗号分隔模式 |
| `--list-models [search]` | 列出可用模型 |

### 会话选项

| 选项 | 描述 |
|--------|-------------|
| `-c`, `--continue` | 继续最近的会话 |
| `-r`, `--resume` | 浏览并选择会话 |
| `--session <path>` | 使用特定会话文件或部分 UUID |
| `--session-dir <dir>` | 自定义会话存储目录 |
| `--no-session` | 临时模式（不保存） |

### 工具选项

| 选项 | 描述 |
|--------|-------------|
| `--tools <list>` | 启用特定的内置工具（默认：`read,bash,edit,write`） |
| `--no-tools` | 禁用所有内置工具（扩展工具仍然工作） |

可用的内置工具：`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### 资源选项

| 选项 | 描述 |
|--------|-------------|
| `-e`, `--extension <source>` | 从路径、npm 或 git 加载扩展（可重复） |
| `--no-extensions` | 禁用扩展发现 |
| `--skill <path>` | 加载技能（可重复） |
| `--no-skills` | 禁用技能发现 |
| `--prompt-template <path>` | 加载提示词模板（可重复） |
| `--no-prompt-templates` | 禁用提示词模板发现 |
| `--theme <path>` | 加载主题（可重复） |
| `--no-themes` | 禁用主题发现 |

将 `--no-*` 与显式标志结合使用以仅加载你需要的资源，忽略 settings.json（例如，`--no-extensions -e ./my-ext.ts`）。

### 其他选项

| 选项 | 描述 |
|--------|-------------|
| `--system-prompt <text>` | 替换默认提示词（上下文文件和技能仍然追加） |
| `--append-system-prompt <text>` | 追加到系统提示词 |
| `--verbose` | 强制详细启动 |
| `-h`, `--help` | 显示帮助 |
| `-v`, `--version` | 显示版本 |

### 文件参数

在文件前加上 `@` 以将其包含在消息中：

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

### 示例

```bash
# 带初始提示词的交互模式
pi "List all .ts files in src/"

# 非交互模式
pi -p "Summarize this codebase"

# 不同模型
pi --provider openai --model gpt-4o "Help me refactor"

# 限制模型循环
pi --models "claude-*,gpt-4o"

# 只读模式
pi --tools read,grep,find,ls -p "Review the code"

# 高思考级别
pi --thinking high "Solve this complex problem"
```

### 环境变量

| 变量 | 描述 |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | 覆盖配置目录（默认：`~/.pi/agent`） |
| `PI_PACKAGE_DIR` | 覆盖包目录（对于存储路径分词效果不佳的 Nix/Guix 很有用） |
| `PI_SKIP_VERSION_CHECK` | 启动时跳过版本检查 |
| `PI_CACHE_RETENTION` | 设置为 `long` 以延长提示缓存（Anthropic: 1h, OpenAI: 24h） |
| `VISUAL`, `EDITOR` | Ctrl+G 的外部编辑器 |

---

## 贡献与开发

有关指南，请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)；有关设置、复刻和调试，请参阅 [docs/development.md](docs/development.md)。

---

## 许可证

MIT

## 另请参阅

- [@mariozechner/pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai): 核心 LLM 工具包
- [@mariozechner/pi-agent](https://www.npmjs.com/package/@mariozechner/pi-agent): 智能体框架
- [@mariozechner/pi-tui](https://www.npmjs.com/package/@mariozechner/pi-tui): 终端 UI 组件

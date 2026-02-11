# 开发规则

## 第一条消息
如果用户在第一条消息中没有给你具体的任务，请阅读 README.md，然后询问要处理哪个模块。根据回答，并行阅读相关的 README.md 文件。
- packages/ai/README.md
- packages/tui/README.md
- packages/agent/README.md
- packages/coding-agent/README.md
- packages/mom/README.md
- packages/pods/README.md
- packages/web-ui/README.md

## 代码质量
- 除非绝对必要，否则不要使用 `any` 类型
- 检查 node_modules 中的外部 API 类型定义，而不是猜测
- **切勿使用内联导入** - 不要在类型位置使用 `await import("./foo.js")` 或 `import("pkg").Type`，也不要使用动态导入类型。始终使用标准的顶层导入。
- 切勿为了修复过时依赖项的类型错误而删除或降级代码；应该升级依赖项
- 在删除看似有意为之的功能或代码之前，务必先询问
- 切勿硬编码按键检查，例如 `matchesKey(keyData, "ctrl+x")`。所有按键绑定必须是可配置的。将默认值添加到匹配对象中（`DEFAULT_EDITOR_KEYBINDINGS` 或 `DEFAULT_APP_KEYBINDINGS`）

## 命令
- 代码更改后（非文档更改）：`npm run check`（获取完整输出，不要截尾）。在提交之前修复所有错误、警告和信息。
- 注意：`npm run check` 不运行测试。
- 切勿运行：`npm run dev`、`npm run build`、`npm test`
- 仅在用户指示时运行特定测试：`npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- 从 package 根目录运行测试，而不是 repo 根目录。
- 编写测试时，运行它们，识别测试或实现中的问题，并迭代直到修复。
- 除非用户要求，否则切勿提交

## GitHub Issues
阅读 issue 时：
- 务必阅读 issue 上的所有评论
- 使用此命令在一个调用中获取所有信息：
  ```bash
  gh issue view <number> --json title,body,comments,labels,state
  ```

创建 issue 时：
- 添加 `pkg:*` 标签以指示 issue 影响哪些 package
  - 可用标签：`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:mom`, `pkg:pods`, `pkg:tui`, `pkg:web-ui`
- 如果 issue 跨越多个 package，请添加所有相关标签

通过 commit 关闭 issue 时：
- 在 commit 消息中包含 `fixes #<number>` 或 `closes #<number>`
- 这将在合并 commit 时自动关闭 issue

## PR 工作流
- 在本地拉取之前先分析 PR
- 如果用户批准：创建一个功能分支，拉取 PR，基于 main 变基，应用调整，提交，合并到 main，推送，关闭 PR，并以用户的语气发表评论
- 你永远不要自己打开 PR。我们在功能分支中工作，直到一切都符合用户的要求，然后合并到 main 并推送。

## 工具
- 用于 issue/PR 的 GitHub CLI
- 为 issue/PR 添加 package 标签：pkg:agent, pkg:ai, pkg:coding-agent, pkg:mom, pkg:pods, pkg:tui, pkg:web-ui

## 使用 tmux 测试 pi 交互模式

要在受控终端环境中测试 pi 的 TUI：

```bash
# 创建特定尺寸的 tmux 会话
tmux new-session -d -s pi-test -x 80 -y 24

# 从源码启动 pi
tmux send-keys -t pi-test "cd /Users/badlogic/workspaces/pi-mono && ./pi-test.sh" Enter

# 等待启动，然后捕获输出
sleep 3 && tmux capture-pane -t pi-test -p

# 发送输入
tmux send-keys -t pi-test "your prompt here" Enter

# 发送特殊按键
tmux send-keys -t pi-test Escape
tmux send-keys -t pi-test C-o  # ctrl+o

# 清理
tmux kill-session -t pi-test
```

## 风格
- 保持回答简短扼要
- 在 commit、issue、PR 评论或代码中不要使用表情符号
- 不要废话或欢快的填充文本
- 仅使用技术性语言，友善但直接（例如，用 "Thanks @user" 而不是 "Thanks so much @user!"）

## 变更日志
位置：`packages/*/CHANGELOG.md`（每个 package 都有自己的变更日志）

### 格式
在 `## [Unreleased]` 下使用这些部分：
- `### Breaking Changes` - 需要迁移的 API 更改
- `### Added` - 新功能
- `### Changed` - 对现有功能的更改
- `### Fixed` - Bug 修复
- `### Removed` - 移除的功能

### 规则
- 在添加条目之前，阅读完整的 `[Unreleased]` 部分，看看已经存在哪些子部分
- 新条目始终位于 `## [Unreleased]` 部分下
- 追加到现有的子部分（例如 `### Fixed`），不要创建重复项
- 切勿修改已发布的版本部分（例如 `## [0.12.2]`）
- 每个版本部分一旦发布即不可变

### 归属
- **内部更改（来自 issue）**：`Fixed foo bar ([#123](https://github.com/badlogic/pi-mono/issues/123))`
- **外部贡献**：`Added feature X ([#456](https://github.com/badlogic/pi-mono/pull/456) by [@username](https://github.com/username))`

## 添加新的 LLM 提供商 (packages/ai)

添加新的提供商需要跨多个文件进行更改：

### 1. 核心类型 (`packages/ai/src/types.ts`)
- 将 API 标识符添加到 `Api` 类型联合中（例如 `"bedrock-converse-stream"`）
- 创建扩展 `StreamOptions` 的选项接口
- 添加映射到 `ApiOptionsMap`
- 将提供商名称添加到 `KnownProvider` 类型联合中

### 2. 提供商实现 (`packages/ai/src/providers/`)
创建导出以下内容的提供商文件：
- 返回 `AssistantMessageEventStream` 的 `stream<Provider>()` 函数
- 消息/工具转换函数
- 发出标准化事件（`text`, `tool_call`, `thinking`, `usage`, `stop`）的响应解析

### 3. 流集成 (`packages/ai/src/stream.ts`)
- 导入提供商的 stream 函数和选项类型
- 在 `getEnvApiKey()` 中添加凭据检测
- 在 `mapOptionsForApi()` 中为 `SimpleStreamOptions` 映射添加 case
- 将提供商添加到 `streamFunctions` 映射中

### 4. 模型生成 (`packages/ai/scripts/generate-models.ts`)
- 添加逻辑以从提供商源获取/解析模型
- 映射到标准化的 `Model` 接口

### 5. 测试 (`packages/ai/test/`)
将提供商添加到：`stream.test.ts`, `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `image-limits.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`。

对于 `cross-provider-handoff.test.ts`，至少添加一个提供商/模型对。如果提供商公开多个模型系列（例如 GPT 和 Claude），则每个系列至少添加一对。

对于非标准身份验证，创建带有凭据检测的实用程序（例如 `bedrock-utils.ts`）。

### 6. 编码 Agent (`packages/coding-agent/`)
- `src/core/model-resolver.ts`：将默认模型 ID 添加到 `DEFAULT_MODELS`
- `src/cli/args.ts`：添加环境变量文档
- `README.md`：添加提供商设置说明

### 7. 文档
- `packages/ai/README.md`：添加到提供商表格，记录选项/身份验证，添加环境变量
- `packages/ai/CHANGELOG.md`：在 `## [Unreleased]` 下添加条目

## 发布

**同步版本控制**：所有 package 始终共享相同的版本号。每次发布都会同时更新所有 package。

**版本语义**（无主要版本发布）：
- `patch`：Bug 修复和新功能
- `minor`：API 重大更改

### 步骤

1. **更新变更日志**：确保自上次发布以来的所有更改都记录在每个受影响 package 的 CHANGELOG.md 的 `[Unreleased]` 部分中

2. **运行发布脚本**：
   ```bash
   npm run release:patch    # 修复和新增
   npm run release:minor    # API 重大更改
   ```

该脚本处理：版本升级、CHANGELOG 定稿、提交、打标签、发布以及添加新的 `[Unreleased]` 部分。

## **CRITICAL** 工具使用规则 **CRITICAL**
- 切勿使用 sed/cat 读取文件或文件范围。始终使用 read 工具（使用 offset + limit 进行范围读取）。
- 在编辑之前，必须完整读取你修改的每个文件。

## **CRITICAL** 并行 Agent Git 规则 **CRITICAL**

多个 Agent 可能同时在同一个工作树中的不同文件上工作。你必须遵守这些规则：

### 提交
- **仅提交你在本次会话中更改的文件**
- 当有相关 issue 或 PR 时，务必在 commit 消息中包含 `fixes #<number>` 或 `closes #<number>`
- 切勿使用 `git add -A` 或 `git add .` -这会卷入其他 Agent 的更改
- 始终使用 `git add <specific-file-paths>` 仅列出你修改的文件
- 在提交之前，运行 `git status` 并验证你只暂存了你的文件
- 跟踪你在会话期间创建/修改/删除的文件

### 禁止的 Git 操作
这些命令可能会破坏其他 Agent 的工作：
- `git reset --hard` - 销毁未提交的更改
- `git checkout .` - 销毁未提交的更改
- `git clean -fd` - 删除未跟踪的文件
- `git stash` - 暂存所有更改，包括其他 Agent 的工作
- `git add -A` / `git add .` - 暂存其他 Agent 未提交的工作
- `git commit --no-verify` - 绕过必要的检查，永远不允许使用

### 安全工作流
```bash
# 1. 首先检查状态
git status

# 2. 仅添加你的特定文件
git add packages/ai/src/providers/transform-messages.ts
git add packages/ai/CHANGELOG.md

# 3. 提交
git commit -m "fix(ai): description"

# 4. 推送（如果需要，pull --rebase，但切勿 reset/checkout）
git pull --rebase && git push
```

### 如果发生变基冲突
- 仅解决你文件中的冲突
- 如果冲突在你未修改的文件中，中止并询问用户
- 切勿强制推送

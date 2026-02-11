> pi 可以创建扩展。让它为你构建一个用例。

# 扩展 (Extensions)

扩展是 TypeScript 模块，用于扩展 pi 的行为。它们可以订阅生命周期事件，注册 LLM 可调用的自定义工具，添加命令等等。

> **放置 /reload 的位置:** 将扩展放在 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（项目本地）以进行自动发现。仅使用 `pi -e ./path.ts` 进行快速测试。位于自动发现位置的扩展可以通过 `/reload` 进行热重载。

**关键能力：**
- **自定义工具** - 通过 `pi.registerTool()` 注册 LLM 可调用的工具
- **事件拦截** - 阻止或修改工具调用，注入上下文，自定义压缩
- **用户交互** - 通过 `ctx.ui` 提示用户（选择、确认、输入、通知）
- **自定义 UI 组件** - 通过 `ctx.ui.custom()` 使用具有键盘输入的完整 TUI 组件进行复杂交互
- **自定义命令** - 通过 `pi.registerCommand()` 注册像 `/mycommand` 这样的命令
- **会话持久化** - 通过 `pi.appendEntry()` 存储重启后仍然存在的状态
- **自定义渲染** - 控制工具调用/结果和消息在 TUI 中的显示方式

**示例用例：**
- 权限门控（在 `rm -rf`、`sudo` 等之前确认）
- Git 检查点（每回合暂存，在分支上恢复）
- 路径保护（阻止写入 `.env`、`node_modules/`）
- 自定义压缩（以你的方式总结对话）
- 对话摘要（参见 `summarize.ts` 示例）
- 交互式工具（问题、向导、自定义对话框）
- 有状态工具（待办事项列表、连接池）
- 外部集成（文件观察器、webhooks、CI 触发器）
- 等待时的游戏（参见 `snake.ts` 示例）

请参阅 [examples/extensions/](../examples/extensions/) 获取可运行的实现。

## 目录

- [快速开始](#快速开始)
- [扩展位置](#扩展位置)
- [可用导入](#可用导入)
- [编写扩展](#编写扩展)
  - [扩展风格](#扩展风格)
- [事件](#事件)
  - [生命周期概览](#生命周期概览)
  - [会话事件](#会话事件)
  - [代理事件](#代理事件)
  - [工具事件](#工具事件)
- [ExtensionContext](#extensioncontext)
- [ExtensionCommandContext](#extensioncommandcontext)
- [ExtensionAPI 方法](#extensionapi-方法)
- [状态管理](#状态管理)
- [自定义工具](#自定义工具)
- [自定义 UI](#自定义-ui)
- [错误处理](#错误处理)
- [模式行为](#模式行为)
- [示例参考](#示例参考)

## 快速开始

创建 `~/.pi/agent/extensions/my-extension.ts`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // 响应事件
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // 注册自定义工具
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // 注册命令
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

使用 `--extension` (或 `-e`) 标志进行测试：

```bash
pi -e ./my-extension.ts
```

## 扩展位置

> **安全性:** 扩展以你的完整系统权限运行，并可以执行任意代码。仅从你信任的来源安装。

扩展从以下位置自动发现：

| 位置 | 范围 |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | 全局 (所有项目) |
| `~/.pi/agent/extensions/*/index.ts` | 全局 (子目录) |
| `.pi/extensions/*.ts` | 项目本地 |
| `.pi/extensions/*/index.ts` | 项目本地 (子目录) |

通过 `settings.json` 添加其他路径：

```json
{
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensions": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

要通过 npm 或 git 作为 pi 包共享扩展，请参阅 [packages.md](packages.md)。

## 可用导入

| 包 | 目的 |
|---------|---------|
| `@mariozechner/pi-coding-agent` | 扩展类型 (`ExtensionAPI`, `ExtensionContext`, 事件) |
| `@sinclair/typebox` | 工具参数的模式定义 |
| `@mariozechner/pi-ai` | AI 实用程序 (`StringEnum` 用于 Google 兼容的枚举) |
| `@mariozechner/pi-tui` | 用于自定义渲染的 TUI 组件 |

npm 依赖项也可以工作。在你的扩展旁边（或父目录中）添加一个 `package.json`，运行 `npm install`，`node_modules/` 中的导入将被自动解析。

Node.js 内置模块 (`node:fs`, `node:path` 等) 也可用。

## 编写扩展

扩展导出一个接收 `ExtensionAPI` 的默认函数：

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 订阅事件
  pi.on("event_name", async (event, ctx) => {
    // ctx.ui 用于用户交互
    const ok = await ctx.ui.confirm("Title", "Are you sure?");
    ctx.ui.notify("Done!", "success");
    ctx.ui.setStatus("my-ext", "Processing...");  // 页脚状态
    ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"]);  // 编辑器上方的 Widget (默认)
  });

  // 注册工具、命令、快捷键、标志
  pi.registerTool({ ... });
  pi.registerCommand("name", { ... });
  pi.registerShortcut("ctrl+x", { ... });
  pi.registerFlag("my-flag", { ... });
}
```

扩展通过 [jiti](https://github.com/unjs/jiti) 加载，因此 TypeScript 无需编译即可工作。

### 扩展风格

**单文件** - 最简单，适用于小型扩展：

```
~/.pi/agent/extensions/
└── my-extension.ts
```

**带有 index.ts 的目录** - 适用于多文件扩展：

```
~/.pi/agent/extensions/
└── my-extension/
    ├── index.ts        # 入口点 (导出默认函数)
    ├── tools.ts        # 辅助模块
    └── utils.ts        # 辅助模块
```

**带有依赖项的包** - 适用于需要 npm 包的扩展：

```
~/.pi/agent/extensions/
└── my-extension/
    ├── package.json    # 声明依赖项和入口点

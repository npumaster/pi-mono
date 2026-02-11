# SDK 参考

`pi` 提供了一个 TypeScript SDK，用于以编程方式将 AI 编码代理集成到你的应用程序中。

## 安装

```bash
npm install @pi-mono/coding-agent
```

## 基本用法

```typescript
import { createAgentSession } from "@pi-mono/coding-agent";

async function main() {
  // 创建一个新的会话
  const session = await createAgentSession({
    workspaceRoot: "/path/to/project",
    model: "claude-3-5-sonnet-20241022", // 可选
  });

  // 订阅事件
  session.on("thought", (thought) => {
    console.log("思考中:", thought);
  });

  session.on("text", (text) => {
    process.stdout.write(text);
  });

  session.on("tool_call", (tool) => {
    console.log("调用工具:", tool.name);
  });

  // 发送提示
  await session.prompt("分析此项目中的 package.json 文件");
}
```

## API 参考

### `createAgentSession(options)`

创建一个新的 `AgentSession` 实例。

**选项:**

- `workspaceRoot` (string, 必需): 代理将运行的工作区绝对路径。
- `model` (string, 可选): 要使用的 LLM 模型 ID。默认为配置的模型。
- `systemPrompt` (string, 可选): 覆盖默认的系统提示。
- `env` (object, 可选): 环境变量覆盖。

### `AgentSession`

主要的代理接口。

#### 方法

- `prompt(message: string, images?: string[]): Promise<void>`
  向代理发送消息。如果有图像，应为 base64 编码的字符串或文件路径。
  
- `interrupt(): void`
  停止当前的生成或工具执行。

- `getHistory(): Message[]`
  获取当前的聊天历史记录。

- `save(path: string): Promise<void>`
  将会话保存到文件。

- `load(path: string): Promise<void>`
  从文件加载会话。

#### 事件

- `thought`: 当模型正在进行思维链推理时触发。
- `text`: 当模型生成文本响应时触发（流式）。
- `tool_call`: 当模型决定调用工具时触发。
- `tool_result`: 当工具执行完成并返回结果时触发。
- `error`: 当发生错误时触发。
- `done`: 当回合完成（模型停止生成且没有挂起的工具调用）时触发。

## 示例：自定义工具

你可以通过向会话注册自定义工具来扩展代理的功能。

```typescript
session.registerTool({
  name: "get_weather",
  description: "获取给定位置的当前天气",
  schema: {
    type: "object",
    properties: {
      location: { type: "string" },
    },
    required: ["location"],
  },
  execute: async ({ location }) => {
    // 调用天气 API
    return `The weather in ${location} is sunny.`;
  },
});
```

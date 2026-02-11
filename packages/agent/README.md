# @mariozechner/pi-agent-core

带状态的智能体，支持工具执行和事件流。基于 `@mariozechner/pi-ai` 构建。

## 安装

```bash
npm install @mariozechner/pi-agent-core
```

## 快速开始

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "你是一个乐于助人的助手。",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
  },
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // 仅流式输出新的文本块
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("你好！");
```

## 核心概念

### AgentMessage 与 LLM Message

智能体使用 `AgentMessage` 工作，这是一个灵活的类型，可以包含：
- 标准 LLM 消息 (`user`, `assistant`, `toolResult`)
- 通过声明合并自定义的特定于应用程序的消息类型

LLM 仅理解 `user`, `assistant`, 和 `toolResult`。`convertToLlm` 函数通过在每次 LLM 调用之前过滤和转换消息来弥合这一差距。

### 消息流

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (可选)                               (必需)
```

1. **transformContext**: 删减旧消息，注入外部上下文
2. **convertToLlm**: 过滤掉仅用于 UI 的消息，将自定义类型转换为 LLM 格式

## 事件流

智能体发出用于 UI 更新的事件。理解事件序列有助于构建响应式界面。

### prompt() 事件序列

当你调用 `prompt("Hello")` 时：

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // 你的提示
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM 开始响应
├─ message_update  { message: partial... }       // 流式块
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // 完整响应
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### 带工具调用

如果助手调用工具，循环将继续：

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // 如果工具流式传输
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // 下一轮
├─ message_start      { assistantMessage }           // LLM 响应工具结果
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

### continue() 事件序列

`continue()` 从现有上下文恢复，而不添加新消息。用于错误后的重试。

```typescript
// 错误后，从当前状态重试
await agent.continue();
```

上下文中的最后一条消息必须是 `user` 或 `toolResult`（不能是 `assistant`）。

### 事件类型

| 事件 | 描述 |
|-------|-------------|
| `agent_start` | 智能体开始处理 |
| `agent_end` | 智能体完成所有新消息的处理 |
| `turn_start` | 新的一轮开始（一次 LLM 调用 + 工具执行） |
| `turn_end` | 一轮完成，包含助手消息和工具结果 |
| `message_start` | 任何消息开始（user, assistant, toolResult） |
| `message_update` | **仅限助手。** 包含带有增量的 `assistantMessageEvent` |
| `message_end` | 消息完成 |
| `tool_execution_start` | 工具开始 |
| `tool_execution_update` | 工具流式传输进度 |
| `tool_execution_end` | 工具完成 |

## 智能体选项

```typescript
const agent = new Agent({
  // 初始状态
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // 将 AgentMessage[] 转换为 LLM Message[]（自定义消息类型必需）
  convertToLlm: (messages) => messages.filter(...),

  // 在 convertToLlm 之前转换上下文（用于删减、压缩）
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // 导向模式："one-at-a-time"（默认）或 "all"
  steeringMode: "one-at-a-time",

  // 后续模式："one-at-a-time"（默认）或 "all"
  followUpMode: "one-at-a-time",

  // 自定义流函数（用于代理后端）
  streamFn: streamProxy,

  // 提供者缓存的会话 ID
  sessionId: "session-123",

  // 动态 API 密钥解析（用于过期的 OAuth 令牌）
  getApiKey: async (provider) => refreshToken(),

  // 基于令牌的提供者的自定义思考预算
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

## 智能体状态

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamMessage: AgentMessage | null;  // 流式传输期间的当前部分消息
  pendingToolCalls: Set<string>;
  error?: string;
}
```

通过 `agent.state` 访问。在流式传输期间，`streamMessage` 包含部分助手消息。

## 方法

### 提示 (Prompting)

```typescript
// 文本提示
await agent.prompt("Hello");

// 带图像
await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// 直接使用 AgentMessage
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// 从当前上下文继续（最后一条消息必须是 user 或 toolResult）
await agent.continue();
```

### 状态管理

```typescript
agent.setSystemPrompt("New prompt");
agent.setModel(getModel("openai", "gpt-4o"));
agent.setThinkingLevel("medium");
agent.setTools([myTool]);
agent.replaceMessages(newMessages);
agent.appendMessage(message);
agent.clearMessages();
agent.reset();  // 清除所有内容
```

### 会话和思考预算

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### 控制

```typescript
agent.abort();           // 取消当前操作
await agent.waitForIdle(); // 等待完成
```

### 事件

```typescript
const unsubscribe = agent.subscribe((event) => {
  console.log(event.type);
});
unsubscribe();
```

## 导向和后续

导向消息允许你在工具运行时打断智能体。后续消息允许你在智能体原本会停止后排队工作。

```typescript
agent.setSteeringMode("one-at-a-time");
agent.setFollowUpMode("one-at-a-time");

// 当智能体正在运行工具时
agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

// 在智能体完成当前工作后
agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.getSteeringMode();
const followUpMode = agent.getFollowUpMode();

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

使用 clearSteeringQueue, clearFollowUpQueue, 或 clearAllQueues 来丢弃排队的消息。

当工具完成后检测到导向消息时：
1. 剩余的工具将被跳过并返回错误结果
2. 导向消息被注入
3. LLM 响应中断

后续消息仅在没有更多工具调用且没有导向消息时才会被检查。如果有排队的消息，它们将被注入并运行另一轮。

## 自定义消息类型

通过声明合并扩展 `AgentMessage`：

```typescript
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// 现在有效
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

在 `convertToLlm` 中处理自定义类型：

```typescript
const agent = new Agent({
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // 过滤掉
    return [m];
  }),
});
```

## 工具

使用 `AgentTool` 定义工具：

```typescript
import { Type } from "@sinclair/typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",  // 用于 UI 显示
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // 可选：流式传输进度
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.setTools([readFileTool]);
```

### 错误处理

当工具失败时**抛出错误**。不要将错误消息作为内容返回。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  // 仅在成功时返回内容
  return { content: [{ type: "text", text: "..." }] };
}
```

抛出的错误会被智能体捕获，并作为 `isError: true` 的工具错误报告给 LLM。

## 代理用法

对于通过后端代理的浏览器应用程序：

```typescript
import { Agent, streamProxy } from "@mariozechner/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

## 低级 API

用于在没有 Agent 类的情况下直接控制：

```typescript
import { agentLoop, agentLoopContinue } from "@mariozechner/pi-agent-core";

const context: AgentContext = {
  systemPrompt: "You are helpful.",
  messages: [],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

for await (const event of agentLoop([userMessage], context, config)) {
  console.log(event.type);
}

// 从现有上下文继续
for await (const event of agentLoopContinue(context, config)) {
  console.log(event.type);
}
```

## 许可证

MIT

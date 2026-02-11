# Mom 重设计：多平台聊天支持

## 目标

1. 支持多种聊天平台（Slack, Discord, WhatsApp, Telegram 等）
2. 所有平台的统一存储层
3. 平台无关的代理，不关心消息来源
4. 可独立测试的适配器
5. 可独立测试的代理

## 当前架构问题

当前架构在各处紧密耦合了 Slack 特定的代码：

```
main.ts → SlackBot → handler.handleEvent() → agent.run(SlackContext)
                                                    ↓
                                              SlackContext.respond()
                                              SlackContext.replaceMessage()
                                              SlackContext.respondInThread()
                                              etc.
```

问题：
- `SlackContext` 接口泄露了 Slack 概念（线程、输入指示器）
- 代理代码引用了 Slack 特定的格式（mrkdwn, `<@user>` 提及）
- 存储使用 Slack 时间戳 (`ts`) 作为消息 ID
- 消息日志记录假设 Slack 的事件结构
- PR 的 Discord 实现将大部分逻辑复制到了单独的包中

## 提议架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLI / Entry Point                          │
│  mom ./data                                                             │
│  (reads config.json, starts all configured adapters)                    │
│  (读取 config.json，启动所有配置的适配器)                                   │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Platform Adapter                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ SlackAdapter │  │DiscordAdapter│  │  CLIAdapter  │  (for testing)   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                  │
│         │                 │                 │                           │
│         └────────────────┬┴─────────────────┘                           │
│                          │                                              │
│                          ▼                                              │
│              ┌───────────────────────┐                                  │
│              │  PlatformAdapter      │  (common interface)              │
│              │  - onMessage()        │                                  │
│              │  - onStop()           │                                  │
│              │  - sendMessage()      │                                  │
│              │  - updateMessage()    │                                  │
│              │  - deleteMessage()    │                                  │
│              │  - uploadFile()       │                                  │
│              │  - getChannelInfo()   │                                  │
│              │  - getUserInfo()      │                                  │
│              └───────────┬───────────┘                                  │
61→└──────────────────────────┼──────────────────────────────────────────────┘
62→                           │
63→                           ▼
64→┌─────────────────────────────────────────────────────────────────────────┐
65→│                              MomAgent                                   │
66→│  - Platform agnostic (平台无关)                                         │
67→│  - Receives messages via handleMessage(message, context, onEvent)       │
68→│  - Forwards AgentSessionEvent to adapter via callback                   │
69→│  - Provides: abort(), isRunning()                                       │
70→└───────────────────────────────────┬─────────────────────────────────────┘
71→                                    │
72→                                    ▼
73→┌─────────────────────────────────────────────────────────────────────────┐
74→│                           ChannelStore                                  │
75→│  - Unified storage schema for all platforms (所有平台的统一存储模式)        │
76→│  - log.jsonl: channel history (messages only)                           │
77→│  - context.jsonl: LLM context (messages + tool results)                 │
78→│  - attachments/: downloaded files                                       │
79→└─────────────────────────────────────────────────────────────────────────┘
80→```

## 关键接口

### 1. ChannelMessage (统一消息格式)

```typescript
interface ChannelMessage {
  /** 频道内的唯一 ID（保留特定于平台的格式） */
  id: string;
  
  /** 频道/会话 ID */
  channelId: string;
  
  /** 时间戳 (ISO 8601) */
  timestamp: string;
  
  /** 发送者信息 */
  sender: {
    id: string;
    username: string;
    displayName?: string;
    isBot: boolean;
  };
  
  /** 消息内容（从平台接收的原样） */
  text: string;
  
  /** 可选：原始特定于平台的文本（用于调试） */
  rawText?: string;
  
  /** 附件 */
  attachments: ChannelAttachment[];
  
  /** 这是否是对机器人的直接提及/触发？ */
  isMention: boolean;
  
  /** 可选：回复的消息 ID（用于线程对话） */
  replyTo?: string;
  
  /** 特定于平台的元数据（用于特定于平台的功能） */
  metadata?: Record<string, unknown>;
}

interface ChannelAttachment {
  /** 原始文件名 */
  filename: string;
  
  /** 本地路径（相对于频道目录） */
  localPath: string;
  
  /** MIME 类型（如果已知） */
  mimeType?: string;
  
  /** 文件大小（字节） */
  size?: number;
}
```

### 2. PlatformAdapter

适配器处理平台连接和 UI。它们从 MomAgent 接收事件并以任何想要的方式渲染。

```typescript
interface PlatformAdapter {
  /** 适配器名称（用于频道路径，例如 "slack-acme"） */
  name: string;
  
  /** 启动适配器（连接到平台） */
  start(): Promise<void>;
  
  /** 停止适配器 */
  stop(): Promise<void>;
  
  /** 获取所有已知频道 */
  getChannels(): ChannelInfo[];
  
  /** 获取所有已知用户 */
  getUsers(): UserInfo[];
}

interface ChannelInfo {
  id: string;
  name: string;
  type: 'channel' | 'dm' | 'group';
}

interface UserInfo {
  id: string;
  username: string;
  displayName?: string;
}
```

### 3. MomAgent

MomAgent 包装了来自 coding-agent 的 `AgentSession`。代理是平台无关的；它只是将事件转发给适配器。

```typescript
import { type AgentSessionEvent } from "@mariozechner/pi-coding-agent";

interface MomAgent {
  /**
   * 处理传入消息。
   * 适配器通过回调接收事件并以任何想要的方式渲染。
   */
  handleMessage(
    message: ChannelMessage,
    context: ChannelContext,
    onEvent: (event: AgentSessionEvent) => Promise<void>
  ): Promise<{ stopReason: string; errorMessage?: string }>;
  
  /** 中止频道的当前运行 */
  abort(channelId: string): void;
  
  /** 检查频道是否正在运行 */
  isRunning(channelId: string): boolean;
}

interface ChannelContext {
  /** 适配器名称（用于频道路径：channels/<adapter>/<channelId>/） */
  adapter: string;
  users: UserInfo[];
  channels: ChannelInfo[];
}
```

## 事件处理

适配器接收 `AgentSessionEvent` 并以任何想要的方式渲染：

```typescript
// Slack 适配器示例
async function handleEvent(event: AgentSessionEvent, ctx: SlackContext) {
  switch (event.type) {
    case 'tool_execution_start': {
      const label = (event.args as any).label || event.toolName;
      await ctx.updateMain(`_→ ${label}_`);
      break;
    }
    
    case 'tool_execution_end': {
      // 为线程格式化工具结果
      const result = extractText(event.result);
      const formatted = `**${event.toolName}** (${event.durationMs}ms)\n\`\`\`\n${result}\n\`\`\``;
      await ctx.appendThread(this.toSlackFormat(formatted));
      break;
    }
    
    case 'message_end': {
      if (event.message.role === 'assistant') {
        const text = extractAssistantText(event.message);
        await ctx.replaceMain(this.toSlackFormat(text));
        await ctx.appendThread(this.toSlackFormat(text));
        
        // AssistantMessage 的使用情况
        if (event.message.usage) {
          await ctx.appendThread(formatUsage(event.message.usage));
        }
      }
      break;
    }
    
    case 'auto_compaction_start':
      await ctx.updateMain('_Compacting context..._');
      break;
  }
}
```

每个适配器决定：
- 消息格式化（markdown → mrkdwn, embeds 等）
- 针对平台限制的消息拆分
- 什么进入主消息 vs 线程
- 如何显示工具结果、使用情况、错误

## 存储格式

### log.jsonl (频道历史)

按从平台接收的原样存储消息：

```jsonl
{"id":"1734567890.123456","ts":"2024-12-20T10:00:00.000Z","sender":{"id":"U123","username":"mario","displayName":"Mario Z","isBot":false},"text":"<@U789> what's the weather?","attachments":[],"isMention":true}
{"id":"1734567890.234567","ts":"2024-12-20T10:00:05.000Z","sender":{"id":"bot","username":"mom","isBot":true},"text":"The weather is sunny!","attachments":[]}
```

### context.jsonl (LLM 上下文)

与当前格式相同（coding-agent 兼容）：

```jsonl
{"type":"session","id":"uuid","timestamp":"...","provider":"anthropic","modelId":"claude-sonnet-4-5"}
{"type":"message","timestamp":"...","message":{"role":"user","content":"[mario]: what's the weather?"}}
{"type":"message","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"The weather is sunny!"}]}}
```

## 目录结构

```
data/
├── config.json                    # 仅主机 - 令牌、适配器、访问控制
└── workspace/                     # 在 Docker 中挂载为 /workspace
    ├── MEMORY.md
    ├── skills/
    ├── tools/
    ├── events/
    └── channels/
        ├── slack-acme/
        │   └── C0A34FL8PMH/
        │       ├── MEMORY.md
        │       ├── log.jsonl
        │       ├── context.jsonl
        │       ├── attachments/
        │       ├── skills/
        │       └── scratch/
        └── discord-mybot/
            └── 1234567890123456789/
                └── ...
```

**config.json**（未挂载，保留在主机上）：

```json
{
  "adapters": {
    "slack-acme": {
      "type": "slack",
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "admins": ["U123", "U456"],
      "dm": "everyone"
    },
    "discord-mybot": {
      "type": "discord",
      "botToken": "...",
      "admins": ["123456789"],
      "dm": "none"
    }
  }
}
```

**访问控制：**
- `admins`：具有管理员权限的用户 ID。可以随时 DM。
- `dm`：谁还可以 DM。`"everyone"`, `"none"`, 或 `["U789", "U012"]`

**频道**按适配器名称命名空间：`channels/<adapter>/<channelId>/`

**事件**使用限定的 channelId：`{"channelId": "slack-acme/C123", ...}`

**安全说明：** Mom 拥有对工作区中所有频道日志的 bash 访问权限。如果 Mom 在私有频道中，任何可以与 Mom 交谈的人都有可能访问该频道的历史记录。为了真正的隔离，请运行具有单独数据目录的单独 Mom 实例。

### 通过 Bubblewrap 进行频道隔离 (Linux/Docker)

在基于 Linux 的执行环境（Docker）中，我们可以使用 [bubblewrap](https://github.com/containers/bubblewrap) 在操作系统级别强制执行每个用户的频道访问。

**工作原理：**
1. 适配器知道请求用户有权访问哪些频道
2. 在执行 bash 之前，用 bwrap 包装命令
3. 挂载整个文件系统，然后用空的 tmpfs 覆盖被拒绝的频道
4. 沙箱进程无法看到被拒绝频道中的文件

```typescript
function wrapWithBwrap(command: string, deniedChannels: string[]): string {
  const args = [
    '--bind / /',                              // Mount everything
    ...deniedChannels.map(ch => 
      `--tmpfs /workspace/channels/${ch}`      // Hide denied channels
    ),
    '--dev /dev',
    '--proc /proc',
    '--die-with-parent',
  ];
  return `bwrap ${args.join(' ')} -- ${command}`;
}

// 用法
const userChannels = adapter.getUserChannels(userId);  // ["public", "team-a"]
const allChannels = await fs.readdir('/workspace/channels/');
const denied = allChannels.filter(ch => !userChannels.includes(ch));

const sandboxedCmd = wrapWithBwrap('cat /workspace/channels/private/log.jsonl', denied);
// 结果: "No such file or directory" - 私有频道隐藏
```

**要求：**
- Docker 容器需要 `--cap-add=SYS_ADMIN` 以便 bwrap 创建命名空间
- 在 Dockerfile 中安装：`apk add bubblewrap`

**限制：**
- 仅限 Linux（不是 macOS 主机模式）
- 需要 Docker 中的 SYS_ADMIN 能力
- 每次执行的开销（尽管很小）

## 系统提示变更

系统提示是平台无关的。代理输出标准 markdown，适配器进行转换。

```typescript
function buildSystemPrompt(
  workspacePath: string,
  channelId: string,
  memory: string,
  sandbox: SandboxConfig,
  context: ChannelContext,
  skills: Skill[]
): string {
  return `You are mom, a chat bot assistant. Be concise. No emojis.

## Text Formatting
Use standard markdown: **bold**, *italic*, \`code\`, \`\`\`block\`\`\`, [text](url)
For mentions, use @username format.

## Users
${context.users.map(u => `@${u.username}\t${u.displayName || ''}`).join('\n')}

## Channels
${context.channels.map(c => `#${c.name}`).join('\n')}

... rest of prompt ...
`;
}
```

适配器在内部将 markdown 转换为平台格式：

```typescript
// Inside SlackAdapter
private formatForSlack(markdown: string): string {
  let text = markdown;
  
  // Bold: **text** → *text*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  
  // Links: [text](url) → <url|text>
  text = text.replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>');
  
  // Mentions: @username → <@U123>
  text = text.replace(/@(\w+)/g, (match, username) => {
    const user = this.users.find(u => u.username === username);
    return user ? `<@${user.id}>` : match;
  });
  
  return text;
}
```

## 测试策略

### 1. 代理测试（使用临时 Docker 容器）

```typescript
// test/agent.test.ts
import { MomAgent } from '../src/agent.js';
import { createTestContainer, destroyTestContainer } from './docker-utils.js';

describe('MomAgent', () => {
  let containerName: string;
  
  beforeAll(async () => {
    containerName = await createTestContainer();
  });
  
  afterAll(async () => {
    await destroyTestContainer(containerName);
  });

  it('responds to user message', async () => {
    const agent = new MomAgent({
      workDir: tmpDir,
      sandbox: { type: 'docker', container: containerName }
    });
    
    const events: AgentSessionEvent[] = [];
    
    await agent.handleMessage(
      {
        id: '1',
        channelId: 'test-channel',
        timestamp: new Date().toISOString(),
        sender: { id: 'u1', username: 'testuser', isBot: false },
        text: 'hello',
        attachments: [],
        isMention: true,
      },
      { adapter: 'test', users: [], channels: [] },
      async (event) => { events.push(event); }
    );
    
    const messageEnds = events.filter(e => e.type === 'message_end');
    expect(messageEnds.length).toBeGreaterThan(0);
  });
});
```

### 2. 适配器测试（无代理）

```typescript
// test/adapters/slack.test.ts
describe('SlackAdapter', () => {
  it('converts Slack event to ChannelMessage', () => {
    const slackEvent = {
      type: 'message',
      text: 'Hello <@U123>',
      user: 'U456',
      channel: 'C789',
      ts: '1234567890.123456',
    };
    
    const message = SlackAdapter.parseEvent(slackEvent, userCache);
    
    expect(message.text).toBe('Hello @someuser');
    expect(message.channelId).toBe('C789');
    expect(message.sender.id).toBe('U456');
  });
  
  it('converts markdown to Slack format', () => {
    const slack = SlackAdapter.toSlackFormat('**bold** and [link](http://example.com)');
    expect(slack).toBe('*bold* and <http://example.com|link>');
  });
  
  it('handles message_end event', async () => {
    const mockClient = new MockSlackClient();
    const adapter = new SlackAdapter({ client: mockClient });
    
    await adapter.handleEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '**Hello**' }] }
    }, channelContext);
    
    // Verify Slack formatting applied
    expect(mockClient.postMessage).toHaveBeenCalledWith('C123', '*Hello*');
  });
});
```

### 3. 集成测试

```typescript
// test/integration.test.ts
describe('Mom Integration', () => {
  let containerName: string;
  
  beforeAll(async () => {
    containerName = await createTestContainer();
  });
  
  afterAll(async () => {
    await destroyTestContainer(containerName);
  });

  it('end-to-end with CLI adapter', async () => {
    const agent = new MomAgent({
      workDir: tmpDir,
      sandbox: { type: 'docker', container: containerName }
    });
    const adapter = new CLIAdapter({ agent, input: mockStdin, output: mockStdout });
    
    await adapter.start();
    mockStdin.emit('data', 'Hello mom\n');
    
    await waitFor(() => mockStdout.data.length > 0);
    expect(mockStdout.data).toContain('Hello');
  });
});
```

## 迁移路径

1. **第一阶段：重构存储**（非破坏性）
   - 统一 log.jsonl 模式（ChannelMessage 格式）
   - 为现有的 Slack 格式日志添加迁移

2. **第二阶段：提取适配器接口**（非破坏性）
   - 创建包装当前 SlackBot 的 SlackAdapter
   - 代理发出事件，适配器处理 UI

3. **第三阶段：解耦代理**（非破坏性）
   - 从 agent.ts 中删除 Slack 特定代码
   - 代理变得完全平台无关

4. **第四阶段：添加 Discord**（新功能）
   - 实现 DiscordAdapter
   - 共享所有存储和代理代码

## 决策

1. **频道 ID 冲突**：前缀适配器名称 (`channels/slack-acme/C123/`)。

2. **线程**：适配器决定。Slack 使用线程，Discord 可以使用线程或嵌入。

3. **提及**：按原样存储来自平台的内容。代理输出 `@username`，适配器转换。

4. **速率限制**：每个适配器处理自己的。

5. **配置**：单个 `config.json` 包含所有适配器配置和令牌。

## 文件结构

```
packages/mom/src/
├── main.ts                    # CLI 入口点
├── agent.ts                   # MomAgent
├── store.ts                   # ChannelStore
├── context.ts                 # 会话管理
├── sandbox.ts                 # 沙箱执行
├── events.ts                  # 计划事件
├── log.ts                     # 控制台日志记录
│
├── adapters/
│   ├── types.ts              # PlatformAdapter, ChannelMessage 接口
│   ├── slack.ts              # SlackAdapter
│   ├── discord.ts            # DiscordAdapter
│   └── cli.ts                # CLIAdapter (用于测试)
│
└── tools/
    ├── index.ts
    ├── bash.ts
    ├── read.ts
    ├── write.ts
    ├── edit.ts
    └── attach.ts
```

## 自定义工具（主机端执行）

Mom 在沙箱（Docker 容器）内运行 bash 命令，但有时你需要运行在主机上的工具（例如，访问主机 API、凭据或无法在容器中运行的服务）。

### 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Host Machine                               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                        Mom Process (Node.js)                       │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐│  │
│  │  │ CustomTool  │  │ CustomTool  │  │ invoke_tool (AgentTool)     ││  │
│  │  │ gmail       │  │ calendar    │  │ - receives tool name + args ││  │
│  │  │ (loaded via │  │ (loaded via │  │ - dispatches to custom tool ││  │
│  │  │  jiti)      │  │  jiti)      │  │ - returns result to agent   ││  │
│  │  └─────────────┘  └─────────────┘  └─────────────────────────────┘│  │
│  │                          ▲                      │                   │  │
│  │                          │ execute()            │ invoke_tool()     │  │
│  │                          │                      ▼                   │  │
│  │  ┌───────────────────────────────────────────────────────────────┐│  │
│  │  │                     MomAgent                                   ││  │
│  │  │  - System prompt describes all custom tools                    ││  │
│  │  │  - Has invoke_tool as one of its tools                         ││  │
│  │  │  - Mom calls invoke_tool("gmail", {action: "search", ...})     ││  │
│  │  └───────────────────────────────────────────────────────────────┘│  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                    │                                     │
│                                    │ bash tool (Docker exec)             │
│                                    ▼                                     │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                     Docker Container (Sandbox)                     │  │
│  │  - Mom's bash commands run here                                    │  │
│  │  - Isolated from host (except mounted workspace)                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 自定义工具接口

```typescript
// data/tools/gmail/index.ts
import type { MomCustomTool, ToolAPI } from "@mariozechner/pi-mom";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const tool: MomCustomTool = {
  name: "gmail",
  description: "Search, read, and send emails via Gmail",
  parameters: Type.Object({
    action: StringEnum(["search", "read", "send"]),
    query: Type.Optional(Type.String({ description: "Search query" })),
    messageId: Type.Optional(Type.String({ description: "Message ID to read" })),
    to: Type.Optional(Type.String({ description: "Recipient email" })),
    subject: Type.Optional(Type.String({ description: "Email subject" })),
    body: Type.Optional(Type.String({ description: "Email body" })),
  }),
  
  async execute(toolCallId, params, signal) {
    switch (params.action) {
      case "search":
        const results = await searchEmails(params.query);
        return {
          content: [{ type: "text", text: formatSearchResults(results) }],
          details: { count: results.length },
        };
      case "read":
        const email = await readEmail(params.messageId);
        return {
          content: [{ type: "text", text: email.body }],
          details: { from: email.from, subject: email.subject },
        };
      case "send":
        await sendEmail(params.to, params.subject, params.body);
        return {
          content: [{ type: "text", text: `Email sent to ${params.to}` }],
          details: { sent: true },
        };
    }
  },
};

export default tool;
```

### MomCustomTool 类型

```typescript
import type { TSchema, Static } from "@sinclair/typebox";

export interface MomToolResult<TDetails = any> {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: TDetails;
}

export interface MomCustomTool<TParams extends TSchema = TSchema, TDetails = any> {
  /** 工具名称（必须唯一） */
  name: string;
  
  /** 用于系统提示的人类可读描述 */
  description: string;
  
  /** 参数的 TypeBox 模式 */
  parameters: TParams;
  
  /** 执行工具 */
  execute: (
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
  ) => Promise<MomToolResult<TDetails>>;
  
  /** 可选：当 Mom 启动时调用（用于初始化） */
  onStart?: () => Promise<void>;
  
  /** 可选：当 Mom 停止时调用（用于清理） */
  onStop?: () => Promise<void>;
}

/** 用于需要异步初始化的工具的工厂函数 */
export type MomCustomToolFactory = (api: ToolAPI) => MomCustomTool | Promise<MomCustomTool>;

export interface ToolAPI {
  /** mom 数据目录的路径 */
  dataDir: string;
  
  /** 在主机上执行命令（不在沙箱中） */
  exec: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
  
  /** 从数据目录读取文件 */
  readFile: (path: string) => Promise<string>;
  
  /** 将文件写入数据目录 */
  writeFile: (path: string, content: string) => Promise<void>;
}
```

### 工具发现和加载

工具从以下位置发现：
1. `data/tools/**/index.ts` (工作区本地，递归)
2. `~/.pi/mom/tools/**/index.ts` (全局，递归)

```typescript
// loader.ts
import { createJiti } from "jiti";

interface LoadedTool {
  path: string;
  tool: MomCustomTool;
}

async function loadCustomTools(dataDir: string): Promise<LoadedTool[]> {
  const tools: LoadedTool[] = [];
  const jiti = createJiti(import.meta.url, { alias: getAliases() });
  
  // Discover tool directories
  const toolDirs = [
    path.join(dataDir, "tools"),
    path.join(os.homedir(), ".pi", "mom", "tools"),
  ];
  
  for (const dir of toolDirs) {
    if (!fs.existsSync(dir)) continue;
    
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      
      const indexPath = path.join(dir, entry.name, "index.ts");
      if (!fs.existsSync(indexPath)) continue;
      
      try {
        const module = await jiti.import(indexPath, { default: true });
        const toolOrFactory = module as MomCustomTool | MomCustomToolFactory;
        
        const tool = typeof toolOrFactory === "function"
          ? await toolOrFactory(createToolAPI(dataDir))
          : toolOrFactory;
        
        tools.push({ path: indexPath, tool });
      } catch (err) {
        console.error(`Failed to load tool from ${indexPath}:`, err);
      }
    }
  }
  
  return tools;
}
```

### invoke_tool 代理工具

Mom 有一个单一的 `invoke_tool` 工具，用于分发给自定义工具：

```typescript
import { Type } from "@sinclair/typebox";

function createInvokeToolTool(loadedTools: LoadedTool[]): AgentTool {
  const toolMap = new Map(loadedTools.map(t => [t.tool.name, t.tool]));
  
  return {
    name: "invoke_tool",
    label: "Invoke Tool",
    description: "Invoke a custom tool running on the host machine",
    parameters: Type.Object({
      tool: Type.String({ description: "Name of the tool to invoke" }),
      args: Type.Any({ description: "Arguments to pass to the tool (tool-specific)" }),
    }),
    
    async execute(toolCallId, params, signal) {
      const tool = toolMap.get(params.tool);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${params.tool}` }],
          details: { error: true },
          isError: true,
        };
      }
      
      try {
        // Validate args against tool's schema
        // (TypeBox validation here)
        
        const result = await tool.execute(toolCallId, params.args, signal);
        return {
          content: result.content,
          details: { tool: params.tool, ...result.details },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Tool error: ${err.message}` }],
          details: { error: true, tool: params.tool },
          isError: true,
        };
      }
    },
  };
}
```

### 系统提示集成

自定义工具在系统提示中描述，以便 Mom 知道可用内容：

```typescript
function formatCustomToolsForPrompt(tools: LoadedTool[]): string {
  if (tools.length === 0) return "";
  
  let section = `\n## Custom Tools (Host-Side)

These tools run on the host machine (not in your sandbox). Use the \`invoke_tool\` tool to call them.

`;

  for (const { tool } of tools) {
    section += `### ${tool.name}
${tool.description}

**Parameters:**
\`\`\`json
${JSON.stringify(schemaToSimpleJson(tool.parameters), null, 2)}
\`\`\`

**Example:**
\`\`\`
invoke_tool(tool: "${tool.name}", args: { ... })
\`\`\`

`;
  }
  
  return section;
}

// Convert TypeBox schema to simple JSON for display
function schemaToSimpleJson(schema: TSchema): object {
  // Simplified schema representation for the LLM
  // ...
}
```

### 示例：Gmail 工具

```typescript
// data/tools/gmail/index.ts
import type { MomCustomTool, ToolAPI } from "@mariozechner/pi-mom";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import Imap from "imap";
import nodemailer from "nodemailer";

export default async function(api: ToolAPI): Promise<MomCustomTool> {
  // Load credentials from data directory
  const credsPath = path.join(api.dataDir, "tools", "gmail", "credentials.json");
  const creds = JSON.parse(await api.readFile(credsPath));
  
  return {
    name: "gmail",
    description: "Search, read, and send emails via Gmail. Requires credentials.json in the tool directory.",
    parameters: Type.Object({
      action: StringEnum(["search", "read", "send", "list"]),
      // ... other params
    }),
    
    async execute(toolCallId, params, signal) {
      // Implementation using imap/nodemailer
    },
  };
}
```

### 安全注意事项

1. **工具在主机上运行**：自定义工具拥有完整的主机访问权限。仅安装受信任的工具。
2. **凭据存储**：工具应将凭据存储在数据目录中，而不是代码中。
3. **沙箱分离**：沙箱 (Docker) 无法直接访问主机工具。只有 Mom 的 invoke_tool 可以调用它们。

### 加载

工具通过 jiti 加载。它们可以导入任何第三方依赖项（在工具目录中安装）。`@mariozechner/pi-ai` 和 `@mariozechner/pi-mom` 的导入被别名到运行中的 mom 包。

**实时重载**：在开发模式下，工具会被监视并在更改时重载。无需重启。

## 事件系统

通过 `workspace/events/` 中的 JSON 文件进行计划唤醒。

### 格式

```json
{"type": "one-shot", "channelId": "slack-acme/C123ABC", "text": "Reminder", "at": "2025-12-15T09:00:00+01:00"}
```

频道 ID 带有适配器名称限定，以便事件观察者知道使用哪个适配器。

### 运行

```bash
mom ./data
```

读取 `config.json`，启动其中定义的所有适配器。

共享工作区允许：
- 共享 MEMORY.md（全局知识）
- 共享技能
- 事件可以针对任何平台
- 每个频道的数据仍由频道 ID 隔离

## 总结

关键见解是 **关注点分离**：

1. **存储**：统一模式，按从平台接收的原样存储消息
2. **代理**：不知道 Slack/Discord，只处理消息并发射事件
3. **适配器**：处理特定于平台的连接、格式化和消息拆分
4. **进度渲染**：每个适配器决定如何显示工具进度和结果

这允许：
- 在没有任何平台的情况下测试代理
- 在没有代理的情况下测试适配器
- 通过实现 `PlatformAdapter` 添加新平台
- 共享所有存储、上下文管理和代理逻辑
- 在支持它的平台上提供丰富的 UI（嵌入、按钮）
- 在更简单的平台上优雅降级（纯文本）

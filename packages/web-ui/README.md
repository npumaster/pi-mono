# @mariozechner/pi-web-ui

用于构建由 [@mariozechner/pi-ai](../ai) 和 [@mariozechner/pi-agent-core](../agent) 驱动的 AI 聊天界面的可重用 Web UI 组件。

基于 [mini-lit](https://github.com/badlogic/mini-lit) Web 组件和 Tailwind CSS v4 构建。

## 特性

- **聊天 UI**：包含消息历史、流式传输和工具执行的完整界面
- **工具**：JavaScript REPL、文档提取和 Artifacts（HTML、SVG、Markdown 等）
- **附件**：支持预览和文本提取的 PDF、DOCX、XLSX、PPTX、图像
- **Artifacts**：具有沙盒执行环境的交互式 HTML、SVG、Markdown
- **存储**：基于 IndexedDB 的会话、API 密钥和设置存储
- **CORS 代理**：浏览器环境的自动代理处理
- **自定义提供商**：支持 Ollama、LM Studio、vLLM 和 OpenAI 兼容 API

## 安装

```bash
npm install @mariozechner/pi-web-ui @mariozechner/pi-agent-core @mariozechner/pi-ai
```

## 快速开始

查看 [example](./example) 目录以获取完整的应用程序示例。

```typescript
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import {
  ChatPanel,
  AppStorage,
  IndexedDBStorageBackend,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  setAppStorage,
  defaultConvertToLlm,
  ApiKeyPromptDialog,
} from '@mariozechner/pi-web-ui';
import '@mariozechner/pi-web-ui/app.css';

// 设置存储
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();

const backend = new IndexedDBStorageBackend({
  dbName: 'my-app',
  version: 1,
  stores: [
    settings.getConfig(),
    providerKeys.getConfig(),
    sessions.getConfig(),
    SessionsStore.getMetadataConfig(),
  ],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, undefined, backend);
setAppStorage(storage);

// 创建 Agent
const agent = new Agent({
  initialState: {
    systemPrompt: 'You are a helpful assistant.',
    model: getModel('anthropic', 'claude-sonnet-4-5-20250929'),
    thinkingLevel: 'off',
    messages: [],
    tools: [],
  },
  convertToLlm: defaultConvertToLlm,
});

// 创建聊天面板
const chatPanel = new ChatPanel();
await chatPanel.setAgent(agent, {
  onApiKeyRequired: (provider) => ApiKeyPromptDialog.prompt(provider),
});

document.body.appendChild(chatPanel);
```

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    ChatPanel                         │
│  ┌─────────────────────┐  ┌─────────────────────┐   │
│  │   AgentInterface    │  │   ArtifactsPanel    │   │
│  │  (messages, input)  │  │  (HTML, SVG, MD)    │   │
│  └─────────────────────┘  └─────────────────────┘   │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────┐
│              Agent (from pi-agent-core)              │
│  - State management (messages, model, tools)         │
│  - Event emission (agent_start, message_update, ...) │
│  - Tool execution                                    │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────┐
│                   AppStorage                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ Settings │ │ Provider │ │ Sessions │            │
│  │  Store   │ │Keys Store│ │  Store   │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│                     │                               │
│              IndexedDBStorageBackend                │
└─────────────────────────────────────────────────────┘
```

## 组件

### ChatPanel

带有内置 Artifacts 面板的高级聊天界面。

```typescript
const chatPanel = new ChatPanel();
await chatPanel.setAgent(agent, {
  // 需要时提示输入 API 密钥
  onApiKeyRequired: async (provider) => ApiKeyPromptDialog.prompt(provider),

  // 发送消息前的钩子
  onBeforeSend: async () => { /* save draft, etc. */ },

  // 处理成本显示点击
  onCostClick: () => { /* show cost breakdown */ },

  // 浏览器扩展的自定义沙盒 URL
  sandboxUrlProvider: () => chrome.runtime.getURL('sandbox.html'),

  // 添加自定义工具
  toolsFactory: (agent, agentInterface, artifactsPanel, runtimeProvidersFactory) => {
    const replTool = createJavaScriptReplTool();
    replTool.runtimeProvidersFactory = runtimeProvidersFactory;
    return [replTool];
  },
});
```

### AgentInterface

用于自定义布局的底层聊天界面。

```typescript
const chat = document.createElement('agent-interface') as AgentInterface;
chat.session = agent;
chat.enableAttachments = true;
chat.enableModelSelector = true;
chat.enableThinkingSelector = true;
chat.onApiKeyRequired = async (provider) => { /* ... */ };
chat.onBeforeSend = async () => { /* ... */ };
```

属性：
- `session`: Agent 实例
- `enableAttachments`: 显示附件按钮（默认：true）
- `enableModelSelector`: 显示模型选择器（默认：true）
- `enableThinkingSelector`: 显示思考等级选择器（默认：true）
- `showThemeToggle`: 显示主题切换（默认：false）

### Agent (来自 pi-agent-core)

```typescript
import { Agent } from '@mariozechner/pi-agent-core';

const agent = new Agent({
  initialState: {
    model: getModel('anthropic', 'claude-sonnet-4-5-20250929'),
    systemPrompt: 'You are helpful.',
    thinkingLevel: 'off',
    messages: [],
    tools: [],
  },
  convertToLlm: defaultConvertToLlm,
});

// 事件
agent.subscribe((event) => {
  switch (event.type) {
    case 'agent_start': // Agent 循环开始
    case 'agent_end':   // Agent 循环结束
    case 'turn_start':  // LLM 调用开始
    case 'turn_end':    // LLM 调用结束
    case 'message_start':
    case 'message_update': // 流式更新
    case 'message_end':
      break;
  }
});

// 发送消息
await agent.prompt('Hello!');
await agent.prompt({ role: 'user-with-attachments', content: 'Check this', attachments, timestamp: Date.now() });

// 控制
agent.abort();
agent.setModel(newModel);
agent.setThinkingLevel('medium');
agent.setTools([...]);
agent.queueMessage(customMessage);
```

## 消息类型

### UserMessageWithAttachments

带有文件附件的用户消息：

```typescript
const message: UserMessageWithAttachments = {
  role: 'user-with-attachments',
  content: 'Analyze this document',
  attachments: [pdfAttachment],
  timestamp: Date.now(),
};

// 类型守卫
if (isUserMessageWithAttachments(msg)) {
  console.log(msg.attachments);
}
```

### ArtifactMessage

用于 Artifacts 的会话持久化：

```typescript
const artifact: ArtifactMessage = {
  role: 'artifact',
  action: 'create', // or 'update', 'delete'
  filename: 'chart.html',
  content: '<div>...</div>',
  timestamp: new Date().toISOString(),
};

// 类型守卫
if (isArtifactMessage(msg)) {
  console.log(msg.filename);
}
```

### 自定义消息类型

通过声明合并进行扩展：

```typescript
interface SystemNotification {
  role: 'system-notification';
  message: string;
  level: 'info' | 'warning' | 'error';
  timestamp: string;
}

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    'system-notification': SystemNotification;
  }
}

// 注册渲染器
registerMessageRenderer('system-notification', {
  render: (msg) => html`<div class="alert">${msg.message}</div>`,
});

// 扩展 convertToLlm
function myConvertToLlm(messages: AgentMessage[]): Message[] {
  const processed = messages.map((m) => {
    if (m.role === 'system-notification') {
      return { role: 'user', content: `<system>${m.message}</system>`, timestamp: Date.now() };
    }
    return m;
  });
  return defaultConvertToLlm(processed);
}
```

## 消息转换器

`convertToLlm` 将应用消息转换为 LLM 兼容格式：

```typescript
import { defaultConvertToLlm, convertAttachments } from '@mariozechner/pi-web-ui';

// defaultConvertToLlm 处理：
// - UserMessageWithAttachments → 带有图像/文本内容块的用户消息
// - ArtifactMessage → 过滤掉（仅 UI）
// - 标准消息（user, assistant, toolResult） → 透传
```

## 工具

### JavaScript REPL

在沙盒浏览器环境中执行 JavaScript：

```typescript
import { createJavaScriptReplTool } from '@mariozechner/pi-web-ui';

const replTool = createJavaScriptReplTool();

// 配置用于 artifact/attachment 访问的运行时提供商
replTool.runtimeProvidersFactory = () => [
  new AttachmentsRuntimeProvider(attachments),
  new ArtifactsRuntimeProvider(artifactsPanel, agent, true), // 读写
];

agent.setTools([replTool]);
```

### 文档提取

从 URL 提取文档文本：

```typescript
import { createExtractDocumentTool } from '@mariozechner/pi-web-ui';

const extractTool = createExtractDocumentTool();
extractTool.corsProxyUrl = 'https://corsproxy.io/?';

agent.setTools([extractTool]);
```

### Artifacts 工具

内置于 ArtifactsPanel，支持：HTML、SVG、Markdown、文本、JSON、图像、PDF、DOCX、XLSX。

```typescript
const artifactsPanel = new ArtifactsPanel();
artifactsPanel.agent = agent;

// 该工具通过 artifactsPanel.tool 获取
agent.setTools([artifactsPanel.tool]);
```

### 自定义工具渲染器

```typescript
import { registerToolRenderer, type ToolRenderer } from '@mariozechner/pi-web-ui';

const myRenderer: ToolRenderer = {
  render(params, result, isStreaming) {
    return {
      content: html`<div>...</div>`,
      isCustom: false, // true = 无卡片包装器
    };
  },
};

registerToolRenderer('my_tool', myRenderer);
```

## 存储

### 设置

```typescript
import {
  AppStorage,
  IndexedDBStorageBackend,
  SettingsStore,
  ProviderKeysStore,
  SessionsStore,
  CustomProvidersStore,
  setAppStorage,
  getAppStorage,
} from '@mariozechner/pi-web-ui';

// 创建存储
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

// 创建带有所有存储配置的后端
const backend = new IndexedDBStorageBackend({
  dbName: 'my-app',
  version: 1,
  stores: [
    settings.getConfig(),
    providerKeys.getConfig(),
    sessions.getConfig(),
    SessionsStore.getMetadataConfig(),
    customProviders.getConfig(),
  ],
});

// 将存储连接到后端
settings.setBackend(backend);
providerKeys.setBackend(backend);
sessions.setBackend(backend);
customProviders.setBackend(backend);

// 创建并设置全局存储
const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);
```

### SettingsStore

键值对设置：

```typescript
await storage.settings.set('proxy.enabled', true);
await storage.settings.set('proxy.url', 'https://proxy.example.com');
const enabled = await storage.settings.get<boolean>('proxy.enabled');
```

### ProviderKeysStore

按提供商分类的 API 密钥：

```typescript
await storage.providerKeys.set('anthropic', 'sk-ant-...');
const key = await storage.providerKeys.get('anthropic');
const providers = await storage.providerKeys.list();
```

### SessionsStore

带有元数据的聊天会话：

```typescript
// 保存会话
await storage.sessions.save(sessionData, metadata);

// 加载会话
const data = await storage.sessions.get(sessionId);
const metadata = await storage.sessions.getMetadata(sessionId);

// 列出会话（按 lastModified 排序）
const allMetadata = await storage.sessions.getAllMetadata();

// 更新标题
await storage.sessions.updateTitle(sessionId, 'New Title');

// 删除
await storage.sessions.delete(sessionId);
```

### CustomProvidersStore

自定义 LLM 提供商：

```typescript
const provider: CustomProvider = {
  id: crypto.randomUUID(),
  name: 'My Ollama',
  type: 'ollama',
  baseUrl: 'http://localhost:11434',
};

await storage.customProviders.set(provider);
const all = await storage.customProviders.getAll();
```

## 附件

加载和处理文件：

```typescript
import { loadAttachment, type Attachment } from '@mariozechner/pi-web-ui';

// 来自文件输入
const file = inputElement.files[0];
const attachment = await loadAttachment(file);

// 来自 URL
const attachment = await loadAttachment('https://example.com/doc.pdf');

// 来自 ArrayBuffer
const attachment = await loadAttachment(arrayBuffer, 'document.pdf');

// 附件结构
interface Attachment {
  id: string;
  type: 'image' | 'document';
  fileName: string;
  mimeType: string;
  size: number;
  content: string;        // base64 编码
  extractedText?: string; // 用于文档
  preview?: string;       // base64 预览图像
}
```

支持的格式：PDF、DOCX、XLSX、PPTX、图像、文本文件。

## CORS 代理

用于具有 CORS 限制的浏览器环境：

```typescript
import { createStreamFn, shouldUseProxyForProvider, isCorsError } from '@mariozechner/pi-web-ui';

// AgentInterface 从设置中自动配置代理
// 用于手动设置：
agent.streamFn = createStreamFn(async () => {
  const enabled = await storage.settings.get<boolean>('proxy.enabled');
  return enabled ? await storage.settings.get<string>('proxy.url') : undefined;
});

// 需要代理的提供商：
// - zai: 总是
// - anthropic: 仅 OAuth 令牌 (sk-ant-oat-*)
```

## 对话框

### SettingsDialog

```typescript
import { SettingsDialog, ProvidersModelsTab, ProxyTab, ApiKeysTab } from '@mariozechner/pi-web-ui';

SettingsDialog.open([
  new ProvidersModelsTab(), // 自定义提供商 + 模型列表
  new ProxyTab(),           // CORS 代理设置
  new ApiKeysTab(),         // 每个提供商的 API 密钥
]);
```

### SessionListDialog

```typescript
import { SessionListDialog } from '@mariozechner/pi-web-ui';

SessionListDialog.open(
  async (sessionId) => { /* 加载会话 */ },
  (deletedId) => { /* 处理删除 */ },
);
```

### ApiKeyPromptDialog

```typescript
import { ApiKeyPromptDialog } from '@mariozechner/pi-web-ui';

const success = await ApiKeyPromptDialog.prompt('anthropic');
```

### ModelSelector

```typescript
import { ModelSelector } from '@mariozechner/pi-web-ui';

ModelSelector.open(currentModel, (selectedModel) => {
  agent.setModel(selectedModel);
});
```

## 样式

导入预构建的 CSS：

```typescript
import '@mariozechner/pi-web-ui/app.css';
```

或使用带有自定义配置的 Tailwind：

```css
@import '@mariozechner/mini-lit/themes/claude.css';
@tailwind base;
@tailwind components;
@tailwind utilities;
```

## 国际化

```typescript
import { i18n, setLanguage, translations } from '@mariozechner/pi-web-ui';

// 添加翻译
translations.de = {
  'Loading...': 'Laden...',
  'No sessions yet': 'Noch keine Sitzungen',
};

setLanguage('de');
console.log(i18n('Loading...')); // "Laden..."
```

## 示例

- [example/](./example) - 具有会话、Artifacts、自定义消息的完整 Web 应用
- [sitegeist](https://sitegeist.ai) - 使用 pi-web-ui 的浏览器扩展

## 已知问题

- **PersistentStorageDialog**：目前已损坏

## 许可证

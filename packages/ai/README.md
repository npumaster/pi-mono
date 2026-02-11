# @mariozechner/pi-ai

统一的 LLM API，支持自动模型发现、提供者配置、Token 和成本跟踪，以及简单的上下文持久化和会话中途交接到其他模型。

**注意**：此库仅包含支持工具调用（函数调用）的模型，因为这对于智能体工作流至关重要。

## 目录

- [支持的提供者](#支持的提供者)
- [安装](#安装)
- [快速开始](#快速开始)
- [工具](#工具)
  - [定义工具](#定义工具)
  - [处理工具调用](#处理工具调用)
  - [使用部分 JSON 流式传输工具调用](#使用部分-json-流式传输工具调用)
  - [验证工具参数](#验证工具参数)
  - [完整事件参考](#完整事件参考)
- [图像输入](#图像输入)
- [思考/推理](#思考推理)
  - [统一接口](#统一接口-streamsimplecompletesimple)
  - [提供者特定选项](#提供者特定选项-streamcomplete)
  - [流式传输思考内容](#流式传输思考内容)
- [停止原因](#停止原因)
- [错误处理](#错误处理)
  - [中止请求](#中止请求)
  - [中止后继续](#中止后继续)
- [API、模型和提供者](#api模型和提供者)
  - [提供者和模型](#提供者和模型)
  - [查询提供者和模型](#查询提供者和模型)
  - [自定义模型](#自定义模型)
  - [OpenAI 兼容性设置](#openai-兼容性设置)
  - [类型安全](#类型安全)
- [跨提供者交接](#跨提供者交接)
- [上下文序列化](#上下文序列化)
- [浏览器用法](#浏览器用法)
  - [环境变量](#环境变量-仅限-nodejs)
  - [检查环境变量](#检查环境变量)
- [OAuth 提供者](#oauth-提供者)
  - [Vertex AI (ADC)](#vertex-ai-adc)
  - [CLI 登录](#cli-登录)
  - [编程 OAuth](#编程-oauth)
  - [登录流程示例](#登录流程示例)
  - [使用 OAuth 令牌](#使用-oauth-令牌)
  - [提供者说明](#提供者说明)
- [许可证](#许可证)

## 支持的提供者

- **OpenAI**
- **Azure OpenAI (Responses)**
- **OpenAI Codex** (ChatGPT Plus/Pro 订阅，需要 OAuth，见下文)
- **Anthropic**
- **Google**
- **Vertex AI** (通过 Vertex AI 使用 Gemini)
- **Mistral**
- **Groq**
- **Cerebras**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **MiniMax**
- **GitHub Copilot** (需要 OAuth，见下文)
- **Google Gemini CLI** (需要 OAuth，见下文)
- **Antigravity** (需要 OAuth，见下文)
- **Amazon Bedrock**
- **Kimi For Coding** (Moonshot AI，使用 Anthropic 兼容 API)
- **任何 OpenAI 兼容的 API**: Ollama, vLLM, LM Studio 等

## 安装

```bash
npm install @mariozechner/pi-ai
```

TypeBox 导出已从 `@mariozechner/pi-ai` 重新导出：`Type`, `Static`, 和 `TSchema`。

## 快速开始

```typescript
import { Type, getModel, stream, complete, Context, Tool, StringEnum } from '@mariozechner/pi-ai';

// 完全类型化，支持提供者和模型的自动补全
const model = getModel('openai', 'gpt-4o-mini');

// 使用 TypeBox 模式定义工具，以实现类型安全和验证
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// 构建对话上下文（易于序列化并在模型之间传输）
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?' }],
  tools
};

// 选项 1：使用所有事件类型进行流式传输
const s = stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // 部分工具参数正在流式传输
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error}`);
      break;
  }
}

// 获取流式传输后的最终消息，将其添加到上下文中
const finalMessage = await s.result();
context.messages.push(finalMessage);

// 处理工具调用（如果有）
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  // 执行工具
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // 将工具结果添加到上下文（支持文本和图像）
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// 如果有工具调用，继续
if (toolCalls.length > 0) {
  const continuation = await complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// 选项 2：无需流式传输即可获得完整响应
const response = await complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

## 工具

工具使 LLM 能够与外部系统交互。该库使用 TypeBox 模式进行类型安全的工具定义，并使用 AJV 进行自动验证。TypeBox 模式可以序列化和反序列化为纯 JSON，非常适合分布式系统。

### 定义工具

```typescript
import { Type, Tool, StringEnum } from '@mariozechner/pi-ai';

// 使用 TypeBox 定义工具参数
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: Type.Object({
    location: Type.String({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// 注意：为了兼容 Google API，请使用 StringEnum 助手而不是 Type.Enum
// Type.Enum 生成 Google 不支持的 anyOf/const 模式

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

### 处理工具调用

工具结果使用内容块，并且可以包含文本和图像：

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?' }],
  tools: [weatherTool]
};

const response = await complete(model, context);

// 检查响应中的工具调用
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // 使用参数执行你的工具
    // 参见 "验证工具参数" 部分进行验证
    const result = await executeWeatherApi(block.arguments);

    // 添加带有文本内容的工具结果
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// 工具结果也可以包含图像（对于具有视觉能力的模型）
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### 使用部分 JSON 流式传输工具调用

在流式传输期间，工具调用参数在到达时会被逐步解析。这允许在完整参数可用之前进行实时 UI 更新：

```typescript
const s = stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments 包含流式传输期间部分解析的 JSON
    // 这允许进行渐进式 UI 更新
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // 防御性编程：参数可能不完整
      // 示例：甚至在内容完成之前显示正在写入的文件路径
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // 内容可能是部分的或缺失的
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // 此处 toolCall.arguments 是完整的（但尚未验证）
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**关于部分工具参数的重要说明：**
- 在 `toolcall_delta` 事件期间，`arguments` 包含部分 JSON 的尽力解析结果
- 字段可能缺失或不完整 - 使用前请务必检查是否存在
- 字符串值可能在单词中间被截断
- 数组可能不完整
- 嵌套对象可能部分填充
- 至少，`arguments` 将是一个空对象 `{}`，绝不会是 `undefined`
- Google 提供者不支持函数调用流式传输。相反，你将收到一个包含完整参数的 `toolcall_delta` 事件。

### 验证工具参数

当使用 `agentLoop` 时，工具参数在执行前会自动针对你的 TypeBox 模式进行验证。如果验证失败，错误将作为工具结果返回给模型，允许其重试。

当使用 `stream()` 或 `complete()` 实现你自己的工具执行循环时，请使用 `validateToolCall` 在将参数传递给工具之前对其进行验证：

```typescript
import { stream, validateToolCall, Tool } from '@mariozechner/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // 针对工具的模式验证参数（参数无效时抛出异常）
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... 添加工具结果到上下文
    } catch (error) {
      // 验证失败 - 将错误作为工具结果返回，以便模型可以重试
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### 完整事件参考

助手消息生成期间发出的所有流式传输事件：

| 事件类型 | 描述 | 关键属性 |
|------------|-------------|----------------|
| `start` | 流开始 | `partial`: 初始助手消息结构 |
| `text_start` | 文本块开始 | `contentIndex`: 内容数组中的位置 |
| `text_delta` | 收到文本块 | `delta`: 新文本, `contentIndex`: 位置 |
| `text_end` | 文本块完成 | `content`: 完整文本, `contentIndex`: 位置 |
| `thinking_start` | 思考块开始 | `contentIndex`: 内容数组中的位置 |
| `thinking_delta` | 收到思考块 | `delta`: 新文本, `contentIndex`: 位置 |
| `thinking_end` | 思考块完成 | `content`: 完整思考, `contentIndex`: 位置 |
| `toolcall_start` | 工具调用开始 | `contentIndex`: 内容数组中的位置 |
| `toolcall_delta` | 工具参数流式传输 | `delta`: JSON 块, `partial.content[contentIndex].arguments`: 部分解析的参数 |
| `toolcall_end` | 工具调用完成 | `toolCall`: 包含 `id`, `name`, `arguments` 的完整已验证工具调用 |
| `done` | 流完成 | `reason`: 停止原因 ("stop", "length", "toolUse"), `message`: 最终助手消息 |
| `error` | 发生错误 | `reason`: 错误类型 ("error" 或 "aborted"), `error`: 包含部分内容的 AssistantMessage |

## 图像输入

具有视觉能力的模型可以处理图像。你可以通过 `input` 属性检查模型是否支持图像。如果你将图像传递给不支持视觉的模型，它们将被静默忽略。

```typescript
import { readFileSync } from 'fs';
import { getModel, complete } from '@mariozechner/pi-ai';

const model = getModel('openai', 'gpt-4o-mini');

// 检查模型是否支持图像
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ]
  }]
});

// 访问响应
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## 思考/推理

许多模型支持思考/推理能力，它们可以展示其内部思维过程。你可以通过 `reasoning` 属性检查模型是否支持推理。如果你将推理选项传递给不支持推理的模型，它们将被静默忽略。

### 统一接口 (streamSimple/completeSimple)

```typescript
import { getModel, streamSimple, completeSimple } from '@mariozechner/pi-ai';

// 许多提供者都支持推理/思考
const model = getModel('anthropic', 'claude-sonnet-4-20250514');
// or getModel('openai', 'gpt-5-mini');
// or getModel('google', 'gemini-2.5-flash');
// or getModel('xai', 'grok-code-fast-1');
// or getModel('groq', 'openai/gpt-oss-20b');
// or getModel('cerebras', 'gpt-oss-120b');
// or getModel('openrouter', 'z-ai/glm-4.5v');

// 检查模型是否支持推理
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// 使用简化的推理选项
const response = await completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13' }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' (在非 OpenAI 提供者上 xhigh 映射为 high)
});

// 访问思考和文本块
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

### 提供者特定选项 (stream/complete)

为了进行细粒度控制，请使用提供者特定的选项：

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';

// OpenAI Reasoning (o1, o3, gpt-5)
const openaiModel = getModel('openai', 'gpt-5-mini');
await complete(openaiModel, context, {
  reasoningEffort: 'medium',
  reasoningSummary: 'detailed'  // 仅限 OpenAI Responses API
});

// Anthropic Thinking (Claude Sonnet 4)
const anthropicModel = getModel('anthropic', 'claude-sonnet-4-20250514');
await complete(anthropicModel, context, {
  thinkingEnabled: true,
  thinkingBudgetTokens: 8192  // 可选 Token 限制
});

// Google Gemini Thinking
const googleModel = getModel('google', 'gemini-2.5-flash');
await complete(googleModel, context, {
  thinking: {
    enabled: true,
    budgetTokens: 8192  // -1 为动态，0 为禁用
  }
});
```

### 流式传输思考内容

在流式传输时，思考内容通过特定事件传递：

```typescript
const s = streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // 流式传输思考内容
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## 停止原因

每个 `AssistantMessage` 都包含一个 `stopReason` 字段，指示生成是如何结束的：

- `"stop"` - 正常完成，模型完成了其响应
- `"length"` - 输出达到最大 Token 限制
- `"toolUse"` - 模型正在调用工具并等待工具结果
- `"error"` - 生成过程中发生错误
- `"aborted"` - 请求通过中止信号被取消

## 错误处理

当请求因错误（包括中止和工具调用验证错误）结束时，流式 API 会发出错误事件：

```typescript
// 在流式传输中
for await (const event of stream) {
  if (event.type === 'error') {
    // event.reason 是 "error" 或 "aborted"
    // event.error 是包含部分内容的 AssistantMessage
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// 最终消息将包含错误详情
const message = await stream.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content 包含错误前收到的任何部分内容
  // message.usage 包含部分 Token 计数和成本
}
```

### 中止请求

中止信号允许你取消进行中的请求。被中止的请求具有 `stopReason === 'aborted'`：

```typescript
import { getModel, stream } from '@mariozechner/pi-ai';

const model = getModel('openai', 'gpt-4o-mini');
const controller = new AbortController();

// 2秒后中止
setTimeout(() => controller.abort(), 2000);

const s = stream(model, {
  messages: [{ role: 'user', content: 'Write a long story' }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason 告诉你它是 "error" 还是 "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// 获取结果（如果中止可能是部分的）
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

### 中止后继续

被中止的消息可以添加到对话上下文中，并在后续请求中继续：

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail' }
  ]
};

// 第一个请求在 2 秒后被中止
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await complete(model, context, { signal: controller1.signal });

// 将部分响应添加到上下文
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue' });

// 继续对话
const continuation = await complete(model, context);
```

### 调试提供者载荷

使用 `onPayload` 回调检查发送给提供者的请求载荷。这对于调试请求格式问题或提供者验证错误非常有用。

```typescript
const response = await complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

`stream`, `complete`, `streamSimple`, 和 `completeSimple` 都支持该回调。

## API、模型和提供者

该库使用 API 实现的注册表。内置 API 包括：

- **`anthropic-messages`**: Anthropic Messages API (`streamAnthropic`, `AnthropicOptions`)
- **`google-generative-ai`**: Google Generative AI API (`streamGoogle`, `GoogleOptions`)
- **`google-gemini-cli`**: Google Cloud Code Assist API (`streamGoogleGeminiCli`, `GoogleGeminiCliOptions`)
- **`google-vertex`**: Google Vertex AI API (`streamGoogleVertex`, `GoogleVertexOptions`)
- **`openai-completions`**: OpenAI Chat Completions API (`streamOpenAICompletions`, `OpenAICompletionsOptions`)
- **`openai-responses`**: OpenAI Responses API (`streamOpenAIResponses`, `OpenAIResponsesOptions`)
- **`openai-codex-responses`**: OpenAI Codex Responses API (`streamOpenAICodexResponses`, `OpenAICodexResponsesOptions`)
- **`azure-openai-responses`**: Azure OpenAI Responses API (`streamAzureOpenAIResponses`, `AzureOpenAIResponsesOptions`)
- **`bedrock-converse-stream`**: Amazon Bedrock Converse API (`streamBedrock`, `BedrockOptions`)

### 提供者和模型

**提供者**通过特定 API 提供模型。例如：
- **Anthropic** 模型使用 `anthropic-messages` API
- **Google** 模型使用 `google-generative-ai` API
- **OpenAI** 模型使用 `openai-responses` API
- **Mistral, xAI, Cerebras, Groq 等** 模型使用 `openai-completions` API (OpenAI 兼容)

### 查询提供者和模型

```typescript
import { getProviders, getModels, getModel } from '@mariozechner/pi-ai';

// 获取所有可用提供者
const providers = getProviders();
console.log(providers); // ['openai', 'anthropic', 'google', 'xai', 'groq', ...]

// 获取提供者的所有模型（完全类型化）
const anthropicModels = getModels('anthropic');
for (const model of anthropicModels) {
  console.log(`${model.id}: ${model.name}`);
  console.log(`  API: ${model.api}`); // 'anthropic-messages'
  console.log(`  Context: ${model.contextWindow} tokens`);
  console.log(`  Vision: ${model.input.includes('image')}`);
  console.log(`  Reasoning: ${model.reasoning}`);
}

// 获取特定模型（IDE 中提供者和模型 ID 都会自动补全）
const model = getModel('openai', 'gpt-4o-mini');
console.log(`Using ${model.name} via ${model.api} API`);
```

### 自定义模型

你可以为本地推理服务器或自定义端点创建自定义模型：

```typescript
import { Model, stream } from '@mariozechner/pi-ai';

// 示例：使用 OpenAI 兼容 API 的 Ollama
const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

// 示例：具有显式兼容设置的 LiteLLM 代理
const litellmModel: Model<'openai-completions'> = {
  id: 'gpt-4o',
  name: 'GPT-4o (via LiteLLM)',
  api: 'openai-completions',
  provider: 'litellm',
  baseUrl: 'http://localhost:4000/v1',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
  compat: {
    supportsStore: false,  // LiteLLM 不支持 store 字段
  }
};

// 示例：带头部的自定义端点（绕过 Cloudflare 机器人检测）
const proxyModel: Model<'anthropic-messages'> = {
  id: 'claude-sonnet-4',
  name: 'Claude Sonnet 4 (Proxied)',
  api: 'anthropic-messages',
  provider: 'custom-proxy',
  baseUrl: 'https://proxy.example.com/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'X-Custom-Auth': 'bearer-token-here'
  }
};

// 使用自定义模型
const response = await stream(ollamaModel, context, {
  apiKey: 'dummy' // Ollama 不需要真正的密钥
});
```

### OpenAI 兼容性设置

`openai-completions` API 由许多提供者实现，但有细微差别。默认情况下，该库根据已知提供者（Cerebras, xAI, Mistral, Chutes 等）的 `baseUrl` 自动检测兼容性设置。对于自定义代理或未知端点，你可以通过 `compat` 字段覆盖这些设置。对于 `openai-responses` 模型，compat 字段仅支持 Responses 特定的标志。

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // 提供者是否支持 `store` 字段 (默认: true)
  supportsDeveloperRole?: boolean;   // 提供者是否支持 `developer` 角色 vs `system` (默认: true)
  supportsReasoningEffort?: boolean; // 提供者是否支持 `reasoning_effort` (默认: true)
  supportsUsageInStreaming?: boolean; // 提供者是否支持 `stream_options: { include_usage: true }` (默认: true)
  supportsStrictMode?: boolean;      // 提供者是否在工具定义中支持 `strict` (默认: true)
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // 使用哪个字段名称 (默认: max_completion_tokens)
  requiresToolResultName?: boolean;  // 工具结果是否需要 `name` 字段 (默认: false)
  requiresAssistantAfterToolResult?: boolean; // 工具结果后是否必须跟随助手消息 (默认: false)
  requiresThinkingAsText?: boolean;  // 思考块是否必须转换为文本 (默认: false)
  requiresMistralToolIds?: boolean;  // 工具调用 ID 是否必须规范化为 Mistral 格式 (默认: false)
  thinkingFormat?: 'openai' | 'zai' | 'qwen'; // 推理参数格式: 'openai' 使用 reasoning_effort, 'zai' 使用 thinking: { type: "enabled" }, 'qwen' 使用 enable_thinking: boolean (默认: openai)
  openRouterRouting?: OpenRouterRouting; // OpenRouter 路由偏好 (默认: {})
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway 路由偏好 (默认: {})
}

interface OpenAIResponsesCompat {
  // 保留供将来使用
}
```

如果未设置 `compat`，库将回退到基于 URL 的检测。如果部分设置了 `compat`，未指定的字段将使用检测到的默认值。这适用于：

- **LiteLLM 代理**：可能不支持 `store` 字段
- **自定义推理服务器**：可能使用非标准字段名称
- **自托管端点**：可能具有不同的功能支持

### 类型安全

模型由其 API 类型化，这保持了模型元数据的准确性。当你直接调用提供者函数时，会强制执行提供者特定的选项类型。通用的 `stream` 和 `complete` 函数接受带有额外提供者字段的 `StreamOptions`。

```typescript
import { streamAnthropic, type AnthropicOptions } from '@mariozechner/pi-ai';

// TypeScript 知道这是一个 Anthropic 模型
const claude = getModel('anthropic', 'claude-sonnet-4-20250514');

const options: AnthropicOptions = {
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048
};

await streamAnthropic(claude, context, options);
```

## 跨提供者交接

该库支持在同一对话中不同 LLM 提供者之间的无缝交接。这允许你在保留上下文（包括思考块、工具调用和工具结果）的同时，在会话中途切换模型。

### 工作原理

当来自一个提供者的消息发送到不同的提供者时，库会自动转换它们以实现兼容性：

- **用户和工具结果消息** 保持不变
- **来自相同提供者/API 的助手消息** 保持原样
- **来自不同提供者的助手消息** 将其思考块转换为带有 `<thinking>` 标签的文本
- **工具调用和常规文本** 保持不变

### 示例：多提供者对话

```typescript
import { getModel, complete, Context } from '@mariozechner/pi-ai';

// 从 Claude 开始
const claude = getModel('anthropic', 'claude-sonnet-4-20250514');
const context: Context = {
  messages: []
};

context.messages.push({ role: 'user', content: 'What is 25 * 18?' });
const claudeResponse = await complete(claude, context, {
  thinkingEnabled: true
});
context.messages.push(claudeResponse);

// 切换到 GPT-5 - 它将看到 Claude 的思考作为 <thinking> 标记的文本
const gpt5 = getModel('openai', 'gpt-5-mini');
context.messages.push({ role: 'user', content: 'Is that calculation correct?' });
const gptResponse = await complete(gpt5, context);
context.messages.push(gptResponse);

// 切换到 Gemini
const gemini = getModel('google', 'gemini-2.5-flash');
context.messages.push({ role: 'user', content: 'What was the original question?' });
const geminiResponse = await complete(gemini, context);
```

### 提供者兼容性

所有提供者都可以处理来自其他提供者的消息，包括：
- 文本内容
- 工具调用和工具结果（包括工具结果中的图像）
- 思考/推理块（转换为标记文本以实现跨提供者兼容性）
- 具有部分内容的中止消息

这使得灵活的工作流成为可能，你可以：
- 使用快速模型进行初始响应
- 切换到功能更强大的模型进行复杂推理
- 使用专用模型执行特定任务
- 跨提供者中断保持对话连续性

## 上下文序列化

`Context` 对象可以使用标准 JSON 方法轻松序列化和反序列化，这使得持久化对话、实现聊天历史记录或在服务之间传输上下文变得简单：

```typescript
import { Context, getModel, complete } from '@mariozechner/pi-ai';

// 创建并使用上下文
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?' }
  ]
};

const model = getModel('openai', 'gpt-4o-mini');
const response = await complete(model, context);
context.messages.push(response);

// 序列化整个上下文
const serialized = JSON.stringify(context);
console.log('Serialized context size:', serialized.length, 'bytes');

// 保存到数据库、localStorage、文件等
localStorage.setItem('conversation', serialized);

// 稍后：反序列化并继续对话
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system' });

// 使用任何模型继续
const newModel = getModel('anthropic', 'claude-3-5-haiku-20241022');
const continuation = await complete(newModel, restored);
```

> **注意**：如果上下文包含图像（如图像输入部分所示编码为 base64），这些图像也将被序列化。

## 浏览器用法

该库支持浏览器环境。你必须显式传递 API 密钥，因为环境变量在浏览器中不可用：

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';

// 在浏览器中必须显式传递 API 密钥
const model = getModel('anthropic', 'claude-3-5-haiku-20241022');

const response = await complete(model, {
  messages: [{ role: 'user', content: 'Hello!' }]
}, {
  apiKey: 'your-api-key'
});
```

> **安全警告**：在前端代码中暴露 API 密钥是危险的。任何人都可以提取并滥用你的密钥。仅将此方法用于内部工具或演示。对于生产应用程序，请使用后端代理来确保存储 API 密钥的安全。

### 环境变量 (仅限 Node.js)

在 Node.js 环境中，你可以设置环境变量以避免传递 API 密钥：

| 提供者 | 环境变量 |
|----------|------------------------|
| OpenAI | `OPENAI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME` (可选 `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 如 `model=deployment,model2=deployment2`) |
| Anthropic | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_OAUTH_TOKEN` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_PROJECT` (或 `GCLOUD_PROJECT`) + `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| zAI | `ZAI_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` 或 `GH_TOKEN` 或 `GITHUB_TOKEN` |

设置后，库会自动使用这些密钥：

```typescript
// 使用环境中的 OPENAI_API_KEY
const model = getModel('openai', 'gpt-4o-mini');
const response = await complete(model, context);

// 或者使用显式密钥覆盖
const response = await complete(model, context, {
  apiKey: 'sk-different-key'
});
```

#### Antigravity 版本覆盖

设置 `PI_AI_ANTIGRAVITY_VERSION` 以在 Google 更新其要求时覆盖 Antigravity User-Agent 版本：

```bash
export PI_AI_ANTIGRAVITY_VERSION="1.23.0"
```

#### 缓存保留

设置 `PI_CACHE_RETENTION=long` 以延长提示缓存保留时间：

| 提供者 | 默认 | 使用 `PI_CACHE_RETENTION=long` |
|----------|---------|-------------------------------|
| Anthropic | 5 分钟 | 1 小时 |
| OpenAI | 内存中 | 24 小时 |

这仅影响对 `api.anthropic.com` 和 `api.openai.com` 的直接 API 调用。代理和其他提供者不受影响。

> **注意**：延长缓存保留时间可能会增加 Anthropic 的成本（缓存写入按更高的费率收费）。OpenAI 的 24 小时保留没有额外费用。

### 检查环境变量

```typescript
import { getEnvApiKey } from '@mariozechner/pi-ai';

// 检查环境变量中是否设置了 API 密钥
const key = getEnvApiKey('openai');  // 检查 OPENAI_API_KEY
```

## OAuth 提供者

一些提供者需要 OAuth 身份验证而不是静态 API 密钥：

- **Anthropic** (Claude Pro/Max 订阅)
- **OpenAI Codex** (ChatGPT Plus/Pro 订阅，访问 GPT-5.x Codex 模型)
- **GitHub Copilot** (Copilot 订阅)
- **Google Gemini CLI** (Gemini 2.0/2.5 via Google Cloud Code Assist; 免费层或付费订阅)
- **Antigravity** (免费 Gemini 3, Claude, GPT-OSS via Google Cloud)

对于付费 Cloud Code Assist 订阅，请将 `GOOGLE_CLOUD_PROJECT` 或 `GOOGLE_CLOUD_PROJECT_ID` 设置为你的项目 ID。

### Vertex AI (ADC)

Vertex AI 模型使用应用程序默认凭据 (ADC)：

- **本地开发**: 运行 `gcloud auth application-default login`
- **CI/生产**: 设置 `GOOGLE_APPLICATION_CREDENTIALS` 指向服务帐户 JSON 密钥文件

还要设置 `GOOGLE_CLOUD_PROJECT` (或 `GCLOUD_PROJECT`) 和 `GOOGLE_CLOUD_LOCATION`。你也可以在调用选项中传递 `project`/`location`。

示例：

```bash
# 本地 (使用你的用户凭据)
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI/生产 (服务帐户密钥文件)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';

(async () => {
  const model = getModel('google-vertex', 'gemini-2.5-flash');
  const response = await complete(model, {
    messages: [{ role: 'user', content: 'Hello from Vertex AI' }]
  });

  for (const block of response.content) {
    if (block.type === 'text') console.log(block.text);
  }
})().catch(console.error);
```

官方文档：[应用程序默认凭据](https://cloud.google.com/docs/authentication/application-default-credentials)

### CLI 登录

最快的身份验证方式：

```bash
npx @mariozechner/pi-ai login              # 交互式提供者选择
npx @mariozechner/pi-ai login anthropic    # 登录到特定提供者
npx @mariozechner/pi-ai list               # 列出可用提供者
```

凭据保存到当前目录中的 `auth.json`。

### 编程 OAuth

该库提供登录和令牌刷新函数。凭据存储是调用者的责任。

```typescript
import {
  // 登录函数（返回凭据，不存储）
  loginAnthropic,
  loginOpenAICodex,
  loginGitHubCopilot,
  loginGeminiCli,
  loginAntigravity,

  // 令牌管理
  refreshOAuthToken,   // (provider, credentials) => new credentials
  getOAuthApiKey,      // (provider, credentialsMap) => { newCredentials, apiKey } | null

  // 类型
  type OAuthProvider,  // 'anthropic' | 'openai-codex' | 'github-copilot' | 'google-gemini-cli' | 'google-antigravity'
  type OAuthCredentials,
} from '@mariozechner/pi-ai';
```

### 登录流程示例

```typescript
import { loginGitHubCopilot } from '@mariozechner/pi-ai';
import { writeFileSync } from 'fs';

const credentials = await loginGitHubCopilot({
  onAuth: (url, instructions) => {
    console.log(`Open: ${url}`);
    if (instructions) console.log(instructions);
  },
  onPrompt: async (prompt) => {
    return await getUserInput(prompt.message);
  },
  onProgress: (message) => console.log(message)
});

// 自己存储凭据
const auth = { 'github-copilot': { type: 'oauth', ...credentials } };
writeFileSync('auth.json', JSON.stringify(auth, null, 2));
```

### 使用 OAuth 令牌

使用 `getOAuthApiKey()` 获取 API 密钥，如果过期则自动刷新：

```typescript
import { getModel, complete, getOAuthApiKey } from '@mariozechner/pi-ai';
import { readFileSync, writeFileSync } from 'fs';

// 加载你存储的凭据
const auth = JSON.parse(readFileSync('auth.json', 'utf-8'));

// 获取 API 密钥（如果过期则刷新）
const result = await getOAuthApiKey('github-copilot', auth);
if (!result) throw new Error('Not logged in');

// 保存刷新的凭据
auth['github-copilot'] = { type: 'oauth', ...result.newCredentials };
writeFileSync('auth.json', JSON.stringify(auth, null, 2));

// 使用 API 密钥
const model = getModel('github-copilot', 'gpt-4o');
const response = await complete(model, {
  messages: [{ role: 'user', content: 'Hello!' }]
}, { apiKey: result.apiKey });
```

### 提供者说明

**OpenAI Codex**: 需要 ChatGPT Plus 或 Pro 订阅。提供对具有扩展上下文窗口和推理能力的 GPT-5.x Codex 模型的访问。当在流选项中提供 `sessionId` 时，库会自动处理基于会话的提示缓存。

**Azure OpenAI (Responses)**: 仅使用 Responses API。设置 `AZURE_OPENAI_API_KEY` 和 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME`。如果需要，使用 `AZURE_OPENAI_API_VERSION`（默认为 `v1`）覆盖 API 版本。部署名称默认被视为模型 ID，使用 `azureDeploymentName` 或 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 使用逗号分隔的 `model-id=deployment` 对（例如 `gpt-4o-mini=my-deployment,gpt-4o=prod`）进行覆盖。有意不支持传统的基于部署的 URL。

**GitHub Copilot**: 如果收到 "The requested model is not supported" 错误，请在 VS Code 中手动启用该模型：打开 Copilot Chat，点击模型选择器，选择该模型（警告图标），然后点击 "Enable"。

**Google Gemini CLI / Antigravity**: 这些使用 Google Cloud OAuth。`getOAuthApiKey()` 返回的 `apiKey` 是一个包含令牌和项目 ID 的 JSON 字符串，库会自动处理。

## 开发

### 添加新的提供者

添加新的 LLM 提供者需要跨多个文件进行更改。此清单涵盖了所有必要的步骤：

#### 1. 核心类型 (`src/types.ts`)

- 将 API 标识符添加到 `KnownApi`（例如 `"bedrock-converse-stream"`）
- 创建扩展 `StreamOptions` 的选项接口（例如 `BedrockOptions`）
- 将提供者名称添加到 `KnownProvider`（例如 `"amazon-bedrock"`）

#### 2. 提供者实现 (`src/providers/`)

创建一个新的提供者文件（例如 `amazon-bedrock.ts`），导出：

- `stream<Provider>()` 函数返回 `AssistantMessageEventStream`
- `streamSimple<Provider>()` 用于 `SimpleStreamOptions` 映射
- 提供者特定的选项接口
- 消息转换函数，将 `Context` 转换为提供者格式
- 工具转换（如果提供者支持工具）
- 响应解析，以发出标准化事件 (`text`, `tool_call`, `thinking`, `usage`, `stop`)

#### 3. API 注册表集成 (`src/providers/register-builtins.ts`)

- 使用 `registerApiProvider()` 注册 API
- 在 `env-api-keys.ts` 中为新提供者添加凭据检测
- 确保 `streamSimple` 通过 `getEnvApiKey()` 或提供者特定的身份验证处理身份验证查找

#### 4. 模型生成 (`scripts/generate-models.ts`)

- 添加逻辑以从提供者的源（例如 models.dev API）获取并解析模型
- 将提供者模型数据映射到标准化的 `Model` 接口
- 处理提供者特定的怪癖（定价格式、能力标志、模型 ID 转换）

#### 5. 测试 (`test/`)

创建或更新测试文件以覆盖新提供者：

- `stream.test.ts` - 基本流式传输和工具使用
- `tokens.test.ts` - Token 使用情况报告
- `abort.test.ts` - 请求取消
- `empty.test.ts` - 空消息处理
- `context-overflow.test.ts` - 上下文限制错误
- `image-limits.test.ts` - 图像支持（如果适用）
- `unicode-surrogate.test.ts` - Unicode 处理
- `tool-call-without-result.test.ts` - 孤立的工具调用
- `image-tool-result.test.ts` - 工具结果中的图像
- `total-tokens.test.ts` - Token 计数准确性
- `cross-provider-handoff.test.ts` - 跨提供者上下文重放

对于 `cross-provider-handoff.test.ts`，至少添加一对提供者/模型。如果提供者公开多个模型系列（例如 GPT 和 Claude），则每个系列至少添加一对。

对于具有非标准身份验证的提供者（AWS, Google Vertex），创建一个像 `bedrock-utils.ts` 这样的实用程序，其中包含凭据检测助手。

#### 6. 编码智能体集成 (`../coding-agent/`)

更新 `src/core/model-resolver.ts`：

- 在 `DEFAULT_MODELS` 中为提供者添加默认模型 ID

更新 `src/cli/args.ts`：

- 在帮助文本中添加环境变量文档

更新 `README.md`：

- 将提供者添加到提供者部分，并附带设置说明

#### 7. 文档

更新 `packages/ai/README.md`：

- 添加到支持的提供者表
- 记录任何提供者特定的选项或身份验证要求
- 将环境变量添加到环境变量部分

#### 8. 变更日志

在 `packages/ai/CHANGELOG.md` 的 `## [Unreleased]` 下添加一个条目：

```markdown
### Added
- Added support for [Provider Name] provider ([#PR](link) by [@author](link))
```

## 许可证

MIT

# 自定义提供商

扩展可以通过 `pi.registerProvider()` 注册自定义模型提供商。这使得以下功能成为可能：

- **代理 (Proxies)** - 通过企业代理或 API 网关路由请求
- **自定义端点 (Custom endpoints)** - 使用自托管或私有模型部署
- **OAuth/SSO** - 为企业提供商添加身份验证流程
- **自定义 API (Custom APIs)** - 为非标准 LLM API 实现流式传输

## 扩展示例

请参阅这些完整的提供商示例：

- [`examples/extensions/custom-provider-anthropic/`](../examples/extensions/custom-provider-anthropic/)
- [`examples/extensions/custom-provider-gitlab-duo/`](../examples/extensions/custom-provider-gitlab-duo/)
- [`examples/extensions/custom-provider-qwen-cli/`](../examples/extensions/custom-provider-qwen-cli/)

## 目录

- [扩展示例](#扩展示例)
- [快速参考](#快速参考)
- [覆盖现有提供商](#覆盖现有提供商)
- [注册新提供商](#注册新提供商)
- [OAuth 支持](#oauth-支持)
- [自定义流式 API](#自定义流式-api)
- [测试你的实现](#测试你的实现)
- [配置参考](#配置参考)
- [模型定义参考](#模型定义参考)

## 快速参考

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 覆盖现有提供商的 baseUrl
  pi.registerProvider("anthropic", {
    baseUrl: "https://proxy.example.com"
  });

  // 注册带有模型的新提供商
  pi.registerProvider("my-provider", {
    baseUrl: "https://api.example.com",
    apiKey: "MY_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "my-model",
        name: "My Model",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      }
    ]
  });
}
```

## 覆盖现有提供商

最简单的用例：通过代理重定向现有提供商。

```typescript
// 所有 Anthropic 请求现在都通过你的代理
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// 向 OpenAI 请求添加自定义标头
pi.registerProvider("openai", {
  headers: {
    "X-Custom-Header": "value"
  }
});

// 同时使用 baseUrl 和 headers
pi.registerProvider("google", {
  baseUrl: "https://ai-gateway.corp.com/google",
  headers: {
    "X-Corp-Auth": "CORP_AUTH_TOKEN"  // 环境变量或字面量
  }
});
```

当仅提供 `baseUrl` 和/或 `headers`（没有 `models`）时，该提供商的所有现有模型都将保留并使用新端点。

## 注册新提供商

要添加全新的提供商，请指定 `models` 以及所需的配置。

```typescript
pi.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "MY_LLM_API_KEY",  // 环境变量名或字面量值
  api: "openai-completions",  // 使用哪种流式 API
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,        // 支持扩展思维
      input: ["text", "image"],
      cost: {
        input: 3.0,           // $/百万 tokens
        output: 15.0,
        cacheRead: 0.3,
        cacheWrite: 3.75
      },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});
```

当提供 `models` 时，它会**替换**该提供商的所有现有模型。

### API 类型

`api` 字段决定使用哪种流式实现：

| API | 适用于 |
|-----|---------|
| `anthropic-messages` | Anthropic Claude API 及其兼容者 |
| `openai-completions` | OpenAI Chat Completions API 及其兼容者 |
| `openai-responses` | OpenAI Responses API |
| `azure-openai-responses` | Azure OpenAI Responses API |
| `openai-codex-responses` | OpenAI Codex Responses API |
| `google-generative-ai` | Google Generative AI API |
| `google-gemini-cli` | Google Cloud Code Assist API |
| `google-vertex` | Google Vertex AI API |
| `bedrock-converse-stream` | Amazon Bedrock Converse API |

大多数兼容 OpenAI 的提供商都使用 `openai-completions`。使用 `compat` 来处理特殊情况：

```typescript
models: [{
  id: "custom-model",
  // ...
  compat: {
    supportsDeveloperRole: false,      // 使用 "system" 而不是 "developer"
    supportsReasoningEffort: false,    // 禁用 reasoning_effort 参数
    maxTokensField: "max_tokens",      // 而不是 "max_completion_tokens"
    requiresToolResultName: true,      // 工具结果需要 name 字段
    requiresMistralToolIds: true       // 工具 ID 必须是 9 个字母数字字符
    thinkingFormat: "qwen"             // 使用 enable_thinking: true
  }
}]
```

### 认证标头

如果你的提供商期望 `Authorization: Bearer <key>` 但不使用标准 API，请设置 `authHeader: true`：

```typescript
pi.registerProvider("custom-api", {
  baseUrl: "https://api.example.com",
  apiKey: "MY_API_KEY",
  authHeader: true,  // 添加 Authorization: Bearer 标头
  api: "openai-completions",
  models: [...]
});
```

## OAuth 支持

添加与 `/login` 集成的 OAuth/SSO 身份验证：

```typescript
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";

pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com/v1",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",

    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      // 选项 1: 基于浏览器的 OAuth
      callbacks.onAuth({ url: "https://sso.corp.com/authorize?..." });

      // 选项 2: 设备代码流
      callbacks.onDeviceCode({
        userCode: "ABCD-1234",
        verificationUri: "https://sso.corp.com/device"
      });

      // 选项 3: 提示输入令牌/代码
      const code = await callbacks.onPrompt({ message: "Enter SSO code:" });

      // 交换令牌（你的实现）
      const tokens = await exchangeCodeForTokens(code);

      return {
        refresh: tokens.refreshToken,
        access: tokens.accessToken,
        expires: Date.now() + tokens.expiresIn * 1000
      };

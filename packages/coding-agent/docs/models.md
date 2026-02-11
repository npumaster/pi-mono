# 模型配置

`pi` 支持多种 LLM 提供商，并允许通过配置文件进行广泛的自定义。

## 配置文件

你可以在以下位置定义自定义模型配置：

1. **全局**: `~/.pi/models.json`
2. **项目级**: `.pi/models.json`（在你的工作区中）

项目级配置会与全局配置合并。

## 格式

`models.json` 文件将模型 ID 映射到其配置。

```json
{
  "my-local-model": {
    "provider": "openai",
    "baseUrl": "http://localhost:11434/v1",
    "apiKey": "ollama",
    "modelId": "llama3:latest",
    "contextWindow": 8192,
    "maxOutput": 4096
  },
  "gpt-4-custom": {
    "provider": "openai",
    "modelId": "gpt-4-turbo",
    "temperature": 0.7
  }
}
```

## 字段

- **provider**: 提供商类型。支持: `openai`, `anthropic`, `google`, `bedrock`, `mistral`, `groq`。
- **modelId**: 提供商 API 所知的实际模型名称。
- **baseUrl**: API 端点的基本 URL（用于与 OpenAI 兼容的 API，如 Ollama, vLLM, LM Studio）。
- **apiKey**: 用于此模型的 API 密钥（如果不使用环境变量）。
- **contextWindow**: 模型的上下文窗口大小（以 token 为单位）。
- **maxOutput**: 最大输出 token 数。
- **temperature**: 采样温度 (0.0 - 1.0)。

## 本地模型示例

### Ollama

要使用 Ollama 运行的模型：

1. 启动 Ollama: `ollama serve`
2. 拉取模型: `ollama pull llama3`
3. 配置 `models.json`:

```json
{
  "ollama-llama3": {
    "provider": "openai",
    "baseUrl": "http://localhost:11434/v1",
    "apiKey": "ollama",
    "modelId": "llama3",
    "contextWindow": 8192
  }
}
```

4. 运行 pi: `pi --model ollama-llama3`

### vLLM

对于托管在 vLLM 上的模型：

```json
{
  "vllm-model": {
    "provider": "openai",
    "baseUrl": "http://localhost:8000/v1",
    "apiKey": "EMPTY",
    "modelId": "meta-llama/Meta-Llama-3-70B-Instruct"
  }
}
```

## 使用 Azure OpenAI

```json
{
  "azure-gpt4": {
    "provider": "openai",
    "baseUrl": "https://your-resource.openai.azure.com/openai/deployments/your-deployment",
    "apiKey": "your-azure-key",
    "modelId": "gpt-4",
    "apiVersion": "2024-02-15-preview"
  }
}
```

## 默认模型

你可以通过在 `settings.json` 中设置 `defaultModel` 来更改默认使用的模型：

```json
{
  "defaultModel": "ollama-llama3"
}
```

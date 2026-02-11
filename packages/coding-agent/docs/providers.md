# LLM 提供商

`pi` 支持多种 LLM 后端。以下是支持的提供商及其设置说明。

## Anthropic (推荐)

Anthropic 的 Claude 3.5 Sonnet 目前是编码任务表现最好的模型。

- **环境变量**: `ANTHROPIC_API_KEY`
- **默认模型**: `claude-3-5-sonnet-20241022`

## OpenAI

支持 GPT-4o, GPT-4 Turbo 等。

- **环境变量**: `OPENAI_API_KEY`
- **默认模型**: `gpt-4o`

## Google Gemini

- **环境变量**: `GOOGLE_GENERATIVE_AI_API_KEY`
- **默认模型**: `gemini-1.5-pro-latest`

## AWS Bedrock

使用 AWS Bedrock 上的模型（Claude, Llama 等）。

- **认证**: 使用标准的 AWS 凭证（`AWS_PROFILE`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` 等）。
- **区域**: `AWS_REGION` (例如 `us-east-1`, `us-west-2`)。
- **模型 ID**: 使用完整的 Bedrock 模型 ARN 或 ID (例如 `anthropic.claude-3-sonnet-20240229-v1:0`)。

## Mistral AI

- **环境变量**: `MISTRAL_API_KEY`
- **默认模型**: `mistral-large-latest`

## Groq

用于极快的推理速度。

- **环境变量**: `GROQ_API_KEY`
- **默认模型**: `llama3-70b-8192`

## OpenAI 兼容 API (Ollama, vLLM, LM Studio)

`pi` 可以连接到任何兼容 OpenAI 聊天补全 API 的服务器。

在 `models.json` 中配置：

```json
{
  "local-llama": {
    "provider": "openai",
    "baseUrl": "http://localhost:11434/v1",
    "apiKey": "ollama",
    "modelId": "llama3"
  }
}
```

## 切换模型

你可以使用 `--model` (或 `-m`) 标志在启动时选择模型：

```bash
pi -m gpt-4o
pi -m local-llama
```

或者在会话中使用 `/model` 命令：

```
> /model claude-3-5-sonnet-20241022
```

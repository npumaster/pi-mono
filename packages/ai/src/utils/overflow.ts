import type { AssistantMessage } from "../types.js";

/**
 * 检测来自不同提供商的上下文溢出错误的正则表达式模式。
 *
 * 这些模式匹配当输入超过模型上下文窗口时返回的错误消息。
 *
 * 特定于提供商的模式（带有错误消息示例）：
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - Cerebras: 返回 "400/413 status code (no body)" - 下面单独处理
 * - Mistral: 返回 "400/413 status code (no body)" - 下面单独处理
 * - z.ai: 不会报错，静默接受溢出 - 通过 usage.input > contextWindow 处理
 * - Ollama: 静默截断输入 - 无法通过错误消息检测
 */
const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (all backends)
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/context[_ ]length[_ ]exceeded/i, // 通用回退
	/too many tokens/i, // 通用回退
	/token limit exceeded/i, // 通用回退
];

/**
 * 检查助手消息是否表示上下文溢出错误。
 *
 * 这处理两种情况：
 * 1. 基于错误的溢出：大多数提供商返回 stopReason "error" 并带有
 *    特定的错误消息模式。
 * 2. 静默溢出：一些提供商接受溢出请求并成功返回。
 *    对于这些，我们检查 usage.input 是否超过上下文窗口。
 *
 * ## 按提供商的可靠性
 *
 * **可靠检测（返回带有可检测消息的错误）：**
 * - Anthropic: "prompt is too long: X tokens > Y maximum"
 * - OpenAI (Completions & Responses): "exceeds the context window"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - Cerebras: 400/413 status code (no body)
 * - Mistral: 400/413 status code (no body)
 * - OpenRouter (所有后端): "maximum context length is X tokens"
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 *
 * **不可靠检测：**
 * - z.ai: 有时静默接受溢出（可通过 usage.input > contextWindow 检测），
 *   有时返回速率限制错误。传递 contextWindow 参数以检测静默溢出。
 * - Ollama: 静默截断输入而不报错。无法通过此函数检测。
 *   响应将具有 usage.input < expected，但我们不知道预期值。
 *
 * ## 自定义提供商
 *
 * 如果您通过 settings.json 添加了自定义模型，此函数可能无法检测
 * 来自这些提供商的溢出错误。要添加支持：
 *
 * 1. 发送超过模型上下文窗口的请求
 * 2. 检查响应中的 errorMessage
 * 3. 创建匹配错误的正则表达式模式
 * 4. 该模式应添加到此文件中的 OVERFLOW_PATTERNS，或者
 *    在调用此函数之前自行检查 errorMessage
 *
 * @param message - 要检查的助手消息
 * @param contextWindow - 用于检测静默溢出 (z.ai) 的可选上下文窗口大小
 * @returns 如果消息指示上下文溢出，则为 true
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// 情况 1：检查错误消息模式
	if (message.stopReason === "error" && message.errorMessage) {
		// 检查已知模式
		if (OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}

		// Cerebras and Mistral return 400/413 with no body for context overflow
		// Note: 429 is rate limiting (requests/tokens per time), NOT context overflow
		if (/^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message.errorMessage)) {
			return true;
		}
	}

	// 情况 2：静默溢出 (z.ai 风格) - 成功但使用量超过上下文
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	return false;
}

/**
 * 获取用于测试目的的溢出模式。
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}

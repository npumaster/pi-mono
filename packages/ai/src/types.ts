import type { AssistantMessageEventStream } from "./utils/event-stream.js";

export type { AssistantMessageEventStream } from "./utils/event-stream.js";

export type KnownApi =
	| "openai-completions"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex";

export type Api = KnownApi | (string & {});

export type KnownProvider =
	| "amazon-bedrock"
	| "anthropic"
	| "google"
	| "google-gemini-cli"
	| "google-antigravity"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "huggingface"
	| "opencode"
	| "kimi-coding";
export type Provider = KnownProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** 每个思考层级的 Token 预算（仅限基于 token 的提供商） */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// 所有提供商共享的基础选项
export type CacheRetention = "none" | "short" | "long";

export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * 提示缓存保留偏好。提供商将其映射到其支持的值。
	 * 默认值: "short"。
	 */
	cacheRetention?: CacheRetention;
	/**
	 * 支持基于会话缓存的提供商的可选会话标识符。
	 * 提供商可以使用它来启用提示缓存、请求路由或其他
	 * 感知会话的功能。不支持它的提供商将忽略此项。
	 */
	sessionId?: string;
	/**
	 * 发送前检查提供商负载的可选回调。
	 */
	onPayload?: (payload: unknown) => void;
	/**
	 * 包含在 API 请求中的可选自定义 HTTP 标头。
	 * 与提供商默认值合并；可以覆盖默认标头。
	 * 并非所有提供商都支持（例如，AWS Bedrock 使用 SDK 身份验证）。
	 */
	headers?: Record<string, string>;
	/**
	 * 当服务器请求长时间等待时，等待重试的最大延迟（以毫秒为单位）。
	 * 如果服务器请求的延迟超过此值，请求将立即失败
	 * 并带有包含请求延迟的错误，允许更高级别的重试逻辑
	 * 以用户可见的方式处理它。
	 * 默认值: 60000 (60 秒)。设置为 0 以禁用上限。
	 */
	maxRetryDelayMs?: number;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

// 传递给 streamSimple() 和 completeSimple() 的带有推理的统一选项
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	/** 思考层级的自定义 Token 预算（仅限基于 token 的提供商） */
	thinkingBudgets?: ThinkingBudgets;
}

// 带有类型选项的通用 StreamFunction
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // 例如，对于 OpenAI 响应，为消息 ID
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // 例如，对于 OpenAI 响应，为推理项 ID
}

export interface ImageContent {
	type: "image";
	data: string; // base64 编码的图像数据
	mimeType: string; // 例如，"image/jpeg", "image/png"
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google 特有：用于重用思维上下文的不透明签名
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix 时间戳（以毫秒为单位）
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number; // Unix 时间戳（以毫秒为单位）
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // 支持文本和图像
	details?: TDetails;
	isError: boolean;
	timestamp: number; // Unix 时间戳（以毫秒为单位）
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

import type { TSchema } from "@sinclair/typebox";

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/**
 * OpenAI 兼容的 completions API 的兼容性设置。
 * 用于覆盖自定义提供商的基于 URL 的自动检测。
 */
export interface OpenAICompletionsCompat {
	/** 提供商是否支持 `store` 字段。默认值：从 URL 自动检测。 */
	supportsStore?: boolean;
	/** 提供商是否支持 `developer` 角色（相对于 `system`）。默认值：从 URL 自动检测。 */
	supportsDeveloperRole?: boolean;
	/** 提供商是否支持 `reasoning_effort`。默认值：从 URL 自动检测。 */
	supportsReasoningEffort?: boolean;
	/** 提供商是否支持流式响应中的 token 使用情况的 `stream_options: { include_usage: true }`。默认值：true。 */
	supportsUsageInStreaming?: boolean;
	/** 用于最大 token 数的字段。默认值：从 URL 自动检测。 */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** 工具结果是否需要 `name` 字段。默认值：从 URL 自动检测。 */
	requiresToolResultName?: boolean;
	/** 工具结果之后的用户消息是否需要在中间插入助手消息。默认值：从 URL 自动检测。 */
	requiresAssistantAfterToolResult?: boolean;
	/** 思考块是否必须转换为带有 <thinking> 分隔符的文本块。默认值：从 URL 自动检测。 */
	requiresThinkingAsText?: boolean;
	/** 工具调用 ID 是否必须标准化为 Mistral 格式（正好 9 个字母数字字符）。默认值：从 URL 自动检测。 */
	requiresMistralToolIds?: boolean;
	/** 推理/思考参数的格式。"openai" 使用 reasoning_effort，"zai" 使用 thinking: { type: "enabled" }，"qwen" 使用 enable_thinking: boolean。默认值："openai"。 */
	thinkingFormat?: "openai" | "zai" | "qwen";
	/** OpenRouter 特有的路由偏好。仅当 baseUrl 指向 OpenRouter 时使用。 */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway 路由偏好。仅当 baseUrl 指向 Vercel AI Gateway 时使用。 */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** 提供商是否支持工具定义中的 `strict` 字段。默认值：true。 */
	supportsStrictMode?: boolean;
}

/** OpenAI Responses API 的兼容性设置。 */
export interface OpenAIResponsesCompat {
	// 预留给未来使用
}

/**
 * OpenRouter 提供商路由偏好。
 * 控制 OpenRouter 将请求路由到哪些上游提供商。
 * @see https://openrouter.ai/docs/provider-routing
 */
export interface OpenRouterRouting {
	/** 仅用于此请求的提供商 slug 列表（例如 ["amazon-bedrock", "anthropic"]）。 */
	only?: string[];
	/** 按顺序尝试的提供商 slug 列表（例如 ["anthropic", "openai"]）。 */
	order?: string[];
}

/**
 * Vercel AI Gateway 路由偏好。
 * 控制网关将请求路由到哪些上游提供商。
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** 仅用于此请求的提供商 slug 列表（例如 ["bedrock", "anthropic"]）。 */
	only?: string[];
	/** 按顺序尝试的提供商 slug 列表（例如 ["anthropic", "openai"]）。 */
	order?: string[];
}

// 统一模型系统的模型接口
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number; // $/百万 token
		output: number; // $/百万 token
		cacheRead: number; // $/百万 token
		cacheWrite: number; // $/百万 token
	};
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	/** OpenAI 兼容 API 的兼容性覆盖。如果未设置，则从 baseUrl 自动检测。 */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses"
			? OpenAIResponsesCompat
			: never;
}

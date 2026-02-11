import type {
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";

/** 流函数 - 可以返回同步结果或 Promise 用于异步配置查找 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * Agent 循环的配置。
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * 在每次 LLM 调用之前将 AgentMessage[] 转换为 LLM 兼容的 Message[]。
	 *
	 * 每个 AgentMessage 必须转换为 LLM 可以理解的 UserMessage、AssistantMessage 或 ToolResultMessage。
	 * 无法转换的 AgentMessage（例如，仅 UI 通知、状态消息）应被过滤掉。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 在 `convertToLlm` 之前应用于上下文的可选转换。
	 *
	 * 将此用于在 AgentMessage 级别工作的操作：
	 * - 上下文窗口管理（修剪旧消息）
	 * - 从外部来源注入上下文
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 为每次 LLM 调用动态解析 API 密钥。
	 *
	 * 对于可能在长时间运行的工具执行阶段过期的短期 OAuth 令牌（例如 GitHub Copilot）非常有用。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 返回要在运行中注入对话的引导消息。
	 *
	 * 在每次工具执行后调用以检查用户中断。
	 * 如果返回消息，则跳过剩余的工具调用，并在下一次 LLM 调用之前将这些消息添加到上下文中。
	 *
	 * 使用它在 agent 工作时对其进行“引导”。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 返回在 agent 否则将停止后要处理的后续消息。
	 *
	 * 当 agent 没有更多工具调用且没有引导消息时调用。
	 * 如果返回消息，它们将被添加到上下文中，并且 agent 继续进行下一轮。
	 *
	 * 使用它处理应等待 agent 完成后的后续消息。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

/**
 * 支持它的模型的思考/推理级别。
 * 注意："xhigh" 仅由 OpenAI gpt-5.1-codex-max, gpt-5.2, gpt-5.2-codex, gpt-5.3, 和 gpt-5.3-codex 模型支持。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * 自定义应用程序消息的可扩展接口。
 * 应用程序可以通过声明合并进行扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: LLM 消息 + 自定义消息的联合类型。
 * 这种抽象允许应用程序添加自定义消息类型，同时保持类型安全和与基本 LLM 消息的兼容性。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * 包含所有配置和对话数据的 Agent 状态。
 */
export interface AgentState {
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
	messages: AgentMessage[]; // Can include attachments + custom message types
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentToolResult<T> {
	// 支持文本和图像的内容块
	content: (TextContent | ImageContent)[];
	// 要在 UI 中显示或记录的详细信息
	details: T;
}

// 用于流式传输工具执行更新的回调
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

// AgentTool 扩展了 Tool 但添加了 execute 函数
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	// 要在 UI 中显示的工具的人类可读标签
	label: string;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

// AgentContext 类似于 Context 但使用 AgentTool
export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/**
 * Agent 发出的用于 UI 更新的事件。
 * 这些事件为消息、轮次和工具执行提供细粒度的生命周期信息。
 */
export type AgentEvent =
	// Agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// 轮次生命周期 - 一个轮次是一次助手响应 + 任何工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期 - 为用户、助手和 toolResult 消息发出
	| { type: "message_start"; message: AgentMessage }
	// 仅在流式传输期间为助手消息发出
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

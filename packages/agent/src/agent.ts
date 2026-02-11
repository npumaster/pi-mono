/**
 * 直接使用 agent-loop 的 Agent 类。
 * 没有传输抽象 - 通过循环调用 streamSimple。
 */

import {
	getModel,
	type ImageContent,
	type Message,
	type Model,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
} from "@mariozechner/pi-ai";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	StreamFn,
	ThinkingLevel,
} from "./types.js";

/**
 * 默认 convertToLlm: 仅保留 LLM 兼容的消息，转换附件。
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

export interface AgentOptions {
	initialState?: Partial<AgentState>;

	/**
	 * 在每次 LLM 调用之前将 AgentMessage[] 转换为 LLM 兼容的 Message[]。
	 * 默认过滤为 user/assistant/toolResult 并转换附件。
	 */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 在 convertToLlm 之前应用于上下文的可选转换。
	 * 用于上下文修剪、注入外部上下文等。
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 引导模式："all" = 一次发送所有引导消息，"one-at-a-time" = 每轮发送一条
	 */
	steeringMode?: "all" | "one-at-a-time";

	/**
	 * 后续模式："all" = 一次发送所有后续消息，"one-at-a-time" = 每轮发送一条
	 */
	followUpMode?: "all" | "one-at-a-time";

	/**
	 * 自定义流函数（用于代理后端等）。默认使用 streamSimple。
	 */
	streamFn?: StreamFn;

	/**
	 * 转发给 LLM 提供商的可选会话标识符。
	 * 由支持基于会话的缓存的提供商（例如 OpenAI Codex）使用。
	 */
	sessionId?: string;

	/**
	 * 为每次 LLM 调用动态解析 API 密钥。
	 * 对于过期令牌（例如 GitHub Copilot OAuth）很有用。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 思考级别的自定义令牌预算（仅限基于令牌的提供商）。
	 */
	thinkingBudgets?: ThinkingBudgets;

	/**
	 * 当服务器请求长时间等待时，等待重试的最大延迟（毫秒）。
	 * 如果服务器请求的延迟超过此值，请求将立即失败，
	 * 允许更高级别的重试逻辑以用户可见的方式处理它。
	 * 默认值：60000（60 秒）。设置为 0 以禁用上限。
	 */
	maxRetryDelayMs?: number;
}

export class Agent {
	private _state: AgentState = {
		systemPrompt: "",
		model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};

	private listeners = new Set<(e: AgentEvent) => void>();
	private abortController?: AbortController;
	private convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	private transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	private steeringQueue: AgentMessage[] = [];
	private followUpQueue: AgentMessage[] = [];
	private steeringMode: "all" | "one-at-a-time";
	private followUpMode: "all" | "one-at-a-time";
	public streamFn: StreamFn;
	private _sessionId?: string;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	private runningPrompt?: Promise<void>;
	private resolveRunningPrompt?: () => void;
	private _thinkingBudgets?: ThinkingBudgets;
	private _maxRetryDelayMs?: number;

	constructor(opts: AgentOptions = {}) {
		this._state = { ...this._state, ...opts.initialState };
		this.convertToLlm = opts.convertToLlm || defaultConvertToLlm;
		this.transformContext = opts.transformContext;
		this.steeringMode = opts.steeringMode || "one-at-a-time";
		this.followUpMode = opts.followUpMode || "one-at-a-time";
		this.streamFn = opts.streamFn || streamSimple;
		this._sessionId = opts.sessionId;
		this.getApiKey = opts.getApiKey;
		this._thinkingBudgets = opts.thinkingBudgets;
		this._maxRetryDelayMs = opts.maxRetryDelayMs;
	}

	/**
	 * 获取用于提供商缓存的当前会话 ID。
	 */
	get sessionId(): string | undefined {
		return this._sessionId;
	}

	/**
	 * 设置用于提供商缓存的会话 ID。
	 * 在切换会话（新会话、分支、恢复）时调用此项。
	 */
	set sessionId(value: string | undefined) {
		this._sessionId = value;
	}

	/**
	 * 获取当前的思考预算。
	 */
	get thinkingBudgets(): ThinkingBudgets | undefined {
		return this._thinkingBudgets;
	}

	/**
	 * 设置基于令牌的提供商的自定义思考预算。
	 */
	set thinkingBudgets(value: ThinkingBudgets | undefined) {
		this._thinkingBudgets = value;
	}

	/**
	 * 获取当前最大重试延迟（毫秒）。
	 */
	get maxRetryDelayMs(): number | undefined {
		return this._maxRetryDelayMs;
	}

	/**
	 * 设置等待服务器请求的重试的最大延迟。
	 * 设置为 0 以禁用上限。
	 */
	set maxRetryDelayMs(value: number | undefined) {
		this._maxRetryDelayMs = value;
	}

	get state(): AgentState {
		return this._state;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	// State mutators
	setSystemPrompt(v: string) {
		this._state.systemPrompt = v;
	}

	setModel(m: Model<any>) {
		this._state.model = m;
	}

	setThinkingLevel(l: ThinkingLevel) {
		this._state.thinkingLevel = l;
	}

	setSteeringMode(mode: "all" | "one-at-a-time") {
		this.steeringMode = mode;
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.steeringMode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time") {
		this.followUpMode = mode;
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.followUpMode;
	}

	setTools(t: AgentTool<any>[]) {
		this._state.tools = t;
	}

	replaceMessages(ms: AgentMessage[]) {
		this._state.messages = ms.slice();
	}

	appendMessage(m: AgentMessage) {
		this._state.messages = [...this._state.messages, m];
	}

	/**
	 * 排队引导消息以在运行中打断 agent。
	 * 在当前工具执行后传递，跳过剩余工具。
	 */
	steer(m: AgentMessage) {
		this.steeringQueue.push(m);
	}

	/**
	 * 排队后续消息以在 agent 完成后处理。
	 * 仅当 agent 没有更多工具调用或引导消息时传递。
	 */
	followUp(m: AgentMessage) {
		this.followUpQueue.push(m);
	}

	clearSteeringQueue() {
		this.steeringQueue = [];
	}

	clearFollowUpQueue() {
		this.followUpQueue = [];
	}

	clearAllQueues() {
		this.steeringQueue = [];
		this.followUpQueue = [];
	}

	hasQueuedMessages(): boolean {
		return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
	}

	private dequeueSteeringMessages(): AgentMessage[] {
		if (this.steeringMode === "one-at-a-time") {
			if (this.steeringQueue.length > 0) {
				const first = this.steeringQueue[0];
				this.steeringQueue = this.steeringQueue.slice(1);
				return [first];
			}
			return [];
		}

		const steering = this.steeringQueue.slice();
		this.steeringQueue = [];
		return steering;
	}

	private dequeueFollowUpMessages(): AgentMessage[] {
		if (this.followUpMode === "one-at-a-time") {
			if (this.followUpQueue.length > 0) {
				const first = this.followUpQueue[0];
				this.followUpQueue = this.followUpQueue.slice(1);
				return [first];
			}
			return [];
		}

		const followUp = this.followUpQueue.slice();
		this.followUpQueue = [];
		return followUp;
	}

	clearMessages() {
		this._state.messages = [];
	}

	abort() {
		this.abortController?.abort();
	}

	waitForIdle(): Promise<void> {
		return this.runningPrompt ?? Promise.resolve();
	}

	reset() {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set<string>();
		this._state.error = undefined;
		this.steeringQueue = [];
		this.followUpQueue = [];
	}

	/** 发送带有 AgentMessage 的提示 */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) {
		if (this._state.isStreaming) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}

		const model = this._state.model;
		if (!model) throw new Error("No model configured");

		let msgs: AgentMessage[];

		if (Array.isArray(input)) {
			msgs = input;
		} else if (typeof input === "string") {
			const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
			if (images && images.length > 0) {
				content.push(...images);
			}
			msgs = [
				{
					role: "user",
					content,
					timestamp: Date.now(),
				},
			];
		} else {
			msgs = [input];
		}

		await this._runLoop(msgs);
	}

	/**
	 * 从当前上下文继续（用于重试和恢复排队的消息）。
	 */
	async continue() {
		if (this._state.isStreaming) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const messages = this._state.messages;
		if (messages.length === 0) {
			throw new Error("No messages to continue from");
		}
		if (messages[messages.length - 1].role === "assistant") {
			const queuedSteering = this.dequeueSteeringMessages();
			if (queuedSteering.length > 0) {
				await this._runLoop(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUp = this.dequeueFollowUpMessages();
			if (queuedFollowUp.length > 0) {
				await this._runLoop(queuedFollowUp);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this._runLoop(undefined);
	}

	/**
	 * 运行 agent 循环。
	 * 如果提供了消息，则使用这些消息开始新的对话轮次。
	 * 否则，从现有上下文继续。
	 */
	private async _runLoop(messages?: AgentMessage[], options?: { skipInitialSteeringPoll?: boolean }) {
		const model = this._state.model;
		if (!model) throw new Error("No model configured");

		this.runningPrompt = new Promise<void>((resolve) => {
			this.resolveRunningPrompt = resolve;
		});

		this.abortController = new AbortController();
		this._state.isStreaming = true;
		this._state.streamMessage = null;
		this._state.error = undefined;

		const reasoning = this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel;

		const context: AgentContext = {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools,
		};

		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;

		const config: AgentLoopConfig = {
			model,
			reasoning,
			sessionId: this._sessionId,
			thinkingBudgets: this._thinkingBudgets,
			maxRetryDelayMs: this._maxRetryDelayMs,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.dequeueSteeringMessages();
			},
			getFollowUpMessages: async () => this.dequeueFollowUpMessages(),
		};

		let partial: AgentMessage | null = null;

		try {
			const stream = messages
				? agentLoop(messages, context, config, this.abortController.signal, this.streamFn)
				: agentLoopContinue(context, config, this.abortController.signal, this.streamFn);

			for await (const event of stream) {
				// 根据事件更新内部状态
				switch (event.type) {
					case "message_start":
						partial = event.message;
						this._state.streamMessage = event.message;
						break;

					case "message_update":
						partial = event.message;
						this._state.streamMessage = event.message;
						break;

					case "message_end":
						partial = null;
						this._state.streamMessage = null;
						this.appendMessage(event.message);
						break;

					case "tool_execution_start": {
						const s = new Set(this._state.pendingToolCalls);
						s.add(event.toolCallId);
						this._state.pendingToolCalls = s;
						break;
					}

					case "tool_execution_end": {
						const s = new Set(this._state.pendingToolCalls);
						s.delete(event.toolCallId);
						this._state.pendingToolCalls = s;
						break;
					}

					case "turn_end":
						if (event.message.role === "assistant" && (event.message as any).errorMessage) {
							this._state.error = (event.message as any).errorMessage;
						}
						break;

					case "agent_end":
						this._state.isStreaming = false;
						this._state.streamMessage = null;
						break;
				}

				// 向监听器发出
				this.emit(event);
			}

			// 处理任何剩余的部分消息
			if (partial && partial.role === "assistant" && partial.content.length > 0) {
				const onlyEmpty = !partial.content.some(
					(c) =>
						(c.type === "thinking" && c.thinking.trim().length > 0) ||
						(c.type === "text" && c.text.trim().length > 0) ||
						(c.type === "toolCall" && c.name.trim().length > 0),
				);
				if (!onlyEmpty) {
					this.appendMessage(partial);
				} else {
					if (this.abortController?.signal.aborted) {
						throw new Error("Request was aborted");
					}
				}
			}
		} catch (err: any) {
			const errorMsg: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: this.abortController?.signal.aborted ? "aborted" : "error",
				errorMessage: err?.message || String(err),
				timestamp: Date.now(),
			} as AgentMessage;

			this.appendMessage(errorMsg);
			this._state.error = err?.message || String(err);
			this.emit({ type: "agent_end", messages: [errorMsg] });
		} finally {
			this._state.isStreaming = false;
			this._state.streamMessage = null;
			this._state.pendingToolCalls = new Set<string>();
			this.abortController = undefined;
			this.resolveRunningPrompt?.();
			this.runningPrompt = undefined;
			this.resolveRunningPrompt = undefined;
		}
	}

	private emit(e: AgentEvent) {
		for (const listener of this.listeners) {
			listener(e);
		}
	}
}

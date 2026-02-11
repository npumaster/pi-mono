/**
 * AgentSession - 代理生命周期和会话管理的核心抽象。
 *
 * 此类在所有运行模式（交互式、打印、rpc）之间共享。
 * 它封装了：
 * - 代理状态访问
 * - 具有自动会话持久性的事件订阅
 * - 模型和思考级别管理
 * - 压缩（手动和自动）
 * - Bash 执行
 * - 会话切换和分支
 *
 * 模式使用此类并在其之上添加自己的 I/O 层。
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, TextContent } from "@mariozechner/pi-ai";
import { isContextOverflow, modelsAreEqual, resetApiProviders, supportsXhigh } from "@mariozechner/pi-ai";
import { getDocsPath } from "../config.js";
import { theme } from "../modes/interactive/theme/theme.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { sleep } from "../utils/sleep.js";
import { type BashResult, executeBash as executeBashCommand, executeBashWithOperations } from "./bash-executor.js";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.js";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.js";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type SessionBeforeCompactResult,
	type SessionBeforeForkResult,
	type SessionBeforeSwitchResult,
	type SessionBeforeTreeResult,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
	wrapToolsWithExtensions,
} from "./extensions/index.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.js";
import type { BranchSummaryEntry, CompactionEntry, SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import { BUILTIN_SLASH_COMMANDS, type SlashCommandInfo, type SlashCommandLocation } from "./slash-commands.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { BashOperations } from "./tools/bash.js";
import { createAllTools } from "./tools/index.js";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** 来自用户消息的已解析技能块 */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * 从消息文本中解析技能块。
 * 如果文本不包含技能块，则返回 null。
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** 扩展核心 AgentEvent 的会话特定事件 */
export type AgentSessionEvent =
	| AgentEvent
	| { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
	| {
			type: "auto_compaction_end";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

/** 代理会话事件的监听器函数 */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** 使用 Ctrl+P 循环的模型（来自 --models 标志） */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>;
	/** 技能、提示词、主题、上下文文件、系统提示词的资源加载器 */
	resourceLoader: ResourceLoader;
	/** 在扩展之外注册的 SDK 自定义工具 */
	customTools?: ToolDefinition[];
	/** 用于 API 密钥解析和模型发现的模型注册表 */
	modelRegistry: ModelRegistry;
	/** 初始激活的内置工具名称。默认值：[read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** 覆盖基础工具（对于自定义运行时很有用）。 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Agent 用于访问当前 ExtensionRunner 的可变引用 */
	extensionRunnerRef?: { current?: ExtensionRunner };
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** AgentSession.prompt() 的选项 */
export interface PromptOptions {
	/** 是否扩展基于文件的提示模板（默认值：true） */
	expandPromptTemplates?: boolean;
	/** 图像附件 */
	images?: ImageContent[];
	/** 传输流时，如何排队消息："steer"（中断）或 "followUp"（等待）。如果正在传输流，则为必填项。 */
	streamingBehavior?: "steer" | "followUp";
	/** 扩展输入事件处理程序的输入源。默认为 "interactive"。 */
	source?: InputSource;
}

/** cycleModel() 的结果 */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** 是在作用域模型中循环（--models 标志）还是在所有可用模型中循环 */
	isScoped: boolean;
}

/** /session 命令的会话统计信息 */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
}

// ============================================================================
// Constants
// ============================================================================

/** 标准思考级别 */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/** 包含 xhigh 的思考级别（针对支持的模型） */
const THINKING_LEVELS_WITH_XHIGH: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>;

	// 事件订阅状态
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];

	/** 跟踪待处理的 steering 消息以供 UI 显示。传递后移除。 */
	private _steeringMessages: string[] = [];
	/** 跟踪待处理的 follow-up 消息以供 UI 显示。传递后移除。 */
	private _followUpMessages: string[] = [];
	/** 排队等待包含在下一个用户提示词中作为上下文的消息（"旁白"）。 */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// 压缩状态
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;

	// 分支摘要状态
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// 重试状态
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;

	// Bash 执行状态
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// 扩展系统
	private _extensionRunner: ExtensionRunner | undefined = undefined;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolRegistry: Map<string, AgentTool> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	// 用于 API 密钥解析的模型注册表
	private _modelRegistry: ModelRegistry;

	// 用于扩展 getTools/setTools 的工具注册表
	private _toolRegistry: Map<string, AgentTool> = new Map();

	// 基础系统提示词（不包含扩展追加的内容）- 用于每回合应用新的追加内容
	private _baseSystemPrompt = "";

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._baseToolsOverride = config.baseToolsOverride;

		// 始终订阅代理事件以进行内部处理
		// （会话持久性、扩展、自动压缩、重试逻辑）
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	/** 用于 API 密钥解析和模型发现的模型注册表 */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** 向所有监听器发出事件 */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	// 跟踪最后一条助手消息以进行自动压缩检查
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** 代理事件的内部处理程序 - 由 subscribe 和 reconnect 共享 */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// 当用户消息开始时，检查它是否来自任一队列，并在发出之前将其删除
		// 这确保 UI 看到更新后的队列状态
		if (event.type === "message_start" && event.message.role === "user") {
			const messageText = this._getUserMessageText(event.message);
			if (messageText) {
				// 先检查 steering 队列
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
				} else {
					// 检查 follow-up 队列
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
					}
				}
			}
		}

		// 首先向扩展发出
		await this._emitExtensionEvent(event);

		// 通知所有监听器
		this._emit(event);

		// 处理会话持久性
		if (event.type === "message_end") {
			// 检查这是否是来自扩展的自定义消息
			if (event.message.role === "custom") {
				// 持久化为 CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// 常规 LLM 消息 - 持久化为 SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// 其他消息类型（bashExecution, compactionSummary, branchSummary）持久化在别处

			// 跟踪助手消息以进行自动压缩（在 agent_end 上检查）
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				// 成功助手响应后立即重置重试计数器
				// 这可以防止在一个回合内的多个 LLM 调用中累积
				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
					this._resolveRetry();
				}
			}
		}

		// 代理完成后检查自动重试和自动压缩
		if (event.type === "agent_end" && this._lastAssistantMessage) {
			const msg = this._lastAssistantMessage;
			this._lastAssistantMessage = undefined;

			// 首先检查可重试的错误（过载、速率限制、服务器错误）
			if (this._isRetryableError(msg)) {
				const didRetry = await this._handleRetryableError(msg);
				if (didRetry) return; // 已启动重试，不要继续压缩
			}

			await this._checkCompaction(msg);
		}
	};

	/** 解析待处理的重试 promise */
	private _resolveRetry(): void {
		if (this._retryResolve) {
			this._retryResolve();
			this._retryResolve = undefined;
			this._retryPromise = undefined;
		}
	}

	/** 从消息中提取文本内容 */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/** 在代理状态中查找最后一条助手消息（包括已中止的消息） */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/** 基于代理事件发出扩展事件 */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (!this._extensionRunner) return;

		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		}
	}

	/**
	 * 订阅代理事件。
	 * 会话持久性在内部处理（在 message_end 上保存消息）。
	 * 可以添加多个监听器。返回此监听器的取消订阅函数。
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// 返回此特定监听器的取消订阅函数
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * 暂时断开与代理事件的连接。
	 * 用户监听器将被保留，并在 resubscribe() 后再次接收事件。
	 * 在需要暂停事件处理的操作期间内部使用。
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * 在 _disconnectFromAgent() 后重新连接到代理事件。
	 * 保留所有现有监听器。
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // 已连接
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * 移除所有监听器并断开与代理的连接。
	 * 在完全完成会话时调用此方法。
	 */
	dispose(): void {
		this._disconnectFromAgent();
		this._eventListeners = [];
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** 完整代理状态 */
	get state(): AgentState {
		return this.agent.state;
	}

	/** 当前模型（如果尚未选择，可能为 undefined） */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** 当前思考级别 */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** 代理当前是否正在流式传输响应 */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	/** 当前有效的系统提示词（包括任何每回合扩展修改） */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** 当前重试尝试次数（如果不重试则为 0） */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * 获取当前活动工具的名称。
	 * 返回代理上当前设置的工具名称。
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * 获取所有配置的工具，包括名称、描述和参数模式。
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolRegistry.values()).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
	}

	/**
	 * 按名称设置活动工具。
	 * 只有注册表中的工具才能启用。未知的工具名称将被忽略。
	 * 还会重建系统提示词以反映新的工具集。
	 * 更改将在下一个代理回合生效。
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.setTools(tools);

		// 使用新工具集重建基础系统提示词
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.setSystemPrompt(this._baseSystemPrompt);
	}

	/** 自动压缩是否正在运行 */
	get isCompacting(): boolean {
		return this._autoCompactionAbortController !== undefined || this._compactionAbortController !== undefined;
	}

	/** 所有消息，包括自定义类型（如 BashExecutionMessage） */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** 当前 steering 模式 */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** 当前 follow-up 模式 */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** 当前会话文件路径，如果禁用了会话则为 undefined */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** 当前会话 ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** 当前会话显示名称（如果已设置） */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** 用于循环的作用域模型（来自 --models 标志） */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** 更新用于循环的作用域模型 */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** 基于文件的提示模板 */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._baseToolRegistry.has(name));
		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		return buildSystemPrompt({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
		});
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * 向代理发送提示词。
	 * - 立即处理扩展命令（通过 pi.registerCommand 注册），即使在流式传输期间也是如此
	 * - 默认情况下扩展基于文件的提示模板
	 * - 在流式传输期间，根据 streamingBehavior 选项通过 steer() 或 followUp() 排队
	 * - 在发送之前验证模型和 API 密钥（非流式传输时）
	 * @throws Error 如果正在流式传输且未指定 streamingBehavior
	 * @throws Error 如果未选择模型或没有可用的 API 密钥（非流式传输时）
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		// 首先处理扩展命令（立即执行，即使在流式传输期间也是如此）
		// 扩展命令通过 pi.sendMessage() 管理它们自己的 LLM 交互
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this._tryExecuteExtensionCommand(text);
			if (handled) {
				// 扩展命令已执行，没有要发送的提示词
				return;
			}
		}

		// 发出输入事件以进行扩展拦截（在技能/模板扩展之前）
		let currentText = text;
		let currentImages = options?.images;
		if (this._extensionRunner?.hasHandlers("input")) {
			const inputResult = await this._extensionRunner.emitInput(
				currentText,
				currentImages,
				options?.source ?? "interactive",
			);
			if (inputResult.action === "handled") {
				return;
			}
			if (inputResult.action === "transform") {
				currentText = inputResult.text;
				currentImages = inputResult.images ?? currentImages;
			}
		}

		// 扩展技能命令 (/skill:name args) 和提示模板 (/template args)
		let expandedText = currentText;
		if (expandPromptTemplates) {
			expandedText = this._expandSkillCommand(expandedText);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}

		// 如果正在流式传输，根据选项通过 steer() 或 followUp() 排队
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			if (options.streamingBehavior === "followUp") {
				await this._queueFollowUp(expandedText, currentImages);
			} else {
				await this._queueSteer(expandedText, currentImages);
			}
			return;
		}

		// 在新提示词之前刷新任何待处理的 bash 消息
		this._flushPendingBashMessages();

		// 验证模型
		if (!this.model) {
			throw new Error(
				"No model selected.\n\n" +
					`Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}\n\n` +
					"Then use /model to select a model.",
			);
		}

		// 验证 API 密钥
		const apiKey = await this._modelRegistry.getApiKey(this.model);
		if (!apiKey) {
			const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
			if (isOAuth) {
				throw new Error(
					`Authentication failed for "${this.model.provider}". ` +
						`Credentials may have expired or network is unavailable. ` +
						`Run '/login ${this.model.provider}' to re-authenticate.`,
				);
			}
			throw new Error(
				`No API key found for ${this.model.provider}.\n\n` +
					`Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}`,
			);
		}

		// 检查在发送之前是否需要压缩（捕获已中止的响应）
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) {
			await this._checkCompaction(lastAssistant, false);
		}

		// 构建消息数组（如果有自定义消息，然后是用户消息）
		const messages: AgentMessage[] = [];

		// 添加用户消息
		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (currentImages) {
			userContent.push(...currentImages);
		}
		messages.push({
			role: "user",
			content: userContent,
			timestamp: Date.now(),
		});

		// 将任何待处理的 "nextTurn" 消息作为上下文与用户消息一起注入
		for (const msg of this._pendingNextTurnMessages) {
			messages.push(msg);
		}
		this._pendingNextTurnMessages = [];

		// 发出 before_agent_start 扩展事件
		if (this._extensionRunner) {
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
			);
			// 添加来自扩展的所有自定义消息
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						content: msg.content,
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// 应用扩展修改后的系统提示词，或重置为基础提示词
			if (result?.systemPrompt) {
				this.agent.setSystemPrompt(result.systemPrompt);
			} else {
				// 确保我们使用的是基础提示词（以防上一回合有修改）
				this.agent.setSystemPrompt(this._baseSystemPrompt);
			}
		}

		await this.agent.prompt(messages);
		await this.waitForRetry();
	}

	/**
	 * 尝试执行扩展命令。如果找到并执行了命令，则返回 true。
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this._extensionRunner) return false;

		// 解析命令名称和参数
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// 从扩展运行器获取命令上下文（包括会话控制方法）
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// 通过扩展运行器发出错误
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * 将技能命令 (/skill:name args) 扩展为其完整内容。
	 * 返回扩展后的文本，如果不是技能命令或未找到技能，则返回原始文本。
	 * 如果文件读取失败，则通过扩展运行器发出错误。
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // 未知技能，直接通过

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// 像扩展命令一样发出错误
			this._extensionRunner?.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // 出错时返回原始内容
		}
	}

	/**
	 * 排队 steering 消息以中途打断代理。
	 * 在当前工具执行后传递，跳过剩余工具。
	 * 扩展技能命令和提示模板。扩展命令出错。
	 * @param images 要随消息一起包含的可选图像附件
	 * @throws Error 如果文本是扩展命令
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// 检查扩展命令（无法排队）
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// 扩展技能命令和提示模板
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * 排队 follow-up 消息以便在代理完成后处理。
	 * 仅当代理没有更多工具调用或 steering 消息时才传递。
	 * 扩展技能命令和提示模板。扩展命令出错。
	 * @param images 要随消息一起包含的可选图像附件
	 * @throws Error 如果文本是扩展命令
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// 检查扩展命令（无法排队）
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// 扩展技能命令和提示模板
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * 内部：排队 steering 消息（已扩展，无扩展命令检查）。
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * 内部：排队 follow-up 消息（已扩展，无扩展命令检查）。
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * 如果文本是扩展命令，则抛出错误。
	 */
	private _throwIfExtensionCommand(text: string): void {
		if (!this._extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * 向会话发送自定义消息。创建 CustomMessageEntry。
	 *
	 * 处理三种情况：
	 * - 流式传输：排队消息，循环从队列中拉取时处理
	 * - 非流式传输 + triggerTurn：追加到状态/会话，开始新回合
	 * - 非流式传输 + 无 trigger：追加到状态/会话，无回合
	 *
	 * @param message 带有 customType, content, display, details 的自定义消息
	 * @param options.triggerTurn 如果为 true 且未流式传输，则触发新的 LLM 回合
	 * @param options.deliverAs 传递模式："steer", "followUp", 或 "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this.agent.prompt(appMessage);
		} else {
			this.agent.appendMessage(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * 向代理发送用户消息。始终触发回合。
	 * 当代理正在流式传输时，使用 deliverAs 指定如何排队消息。
	 *
	 * @param content 用户消息内容（字符串或内容数组）
	 * @param options.deliverAs 流式传输时的传递模式："steer" 或 "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// 将内容标准化为文本字符串 + 可选图像
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// 使用 expandPromptTemplates: false 调用 prompt() 以跳过命令处理和模板扩展
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * 清除所有排队的消息并返回它们。
	 * 在用户中止时恢复到编辑器很有用。
	 * @returns 包含 steering 和 followUp 数组的对象
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		return { steering, followUp };
	}

	/** 待处理消息的数量（包括 steering 和 follow-up） */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** 获取待处理的 steering 消息（只读） */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** 获取待处理的 follow-up 消息（只读） */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * 中止当前操作并等待代理空闲。
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.agent.waitForIdle();
	}

	/**
	 * 启动新会话，可选择包含初始消息和父级跟踪。
	 * 清除所有消息并启动新会话。
	 * 监听器被保留并将继续接收事件。
	 * @param options.parentSession - 用于跟踪的可选父会话路径
	 * @param options.setup - 初始化会话的可选回调（例如，追加消息）
	 * @returns 如果完成则为 true，如果被扩展取消则为 false
	 */
	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// 发出 session_before_switch 事件，原因为 "new"（可取消）
		if (this._extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this._disconnectFromAgent();
		await this.abort();
		this.agent.reset();
		this.sessionManager.newSession({ parentSession: options?.parentSession });
		this.agent.sessionId = this.sessionManager.getSessionId();
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._pendingNextTurnMessages = [];

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);

		// 如果提供了设置回调，则运行它（例如，追加初始消息）
		if (options?.setup) {
			await options.setup(this.sessionManager);
			// 设置后将代理状态与会话管理器同步
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.replaceMessages(sessionContext.messages);
		}

		this._reconnectToAgent();

		// 向扩展发出原因为 "new" 的 session_switch 事件
		if (this._extensionRunner) {
			await this._extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		// 向自定义工具发出会话事件
		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (!this._extensionRunner) return;
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * 直接设置模型。
	 * 验证 API 密钥，保存到会话和设置。
	 * @throws Error 如果模型没有可用的 API 密钥
	 */
	async setModel(model: Model<any>): Promise<void> {
		const apiKey = await this._modelRegistry.getApiKey(model);
		if (!apiKey) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		this.agent.setModel(model);
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// 针对新模型的能力重新限制思考级别
		this.setThinkingLevel(this.thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * 循环到下一个/上一个模型。
	 * 如果可用，使用作用域模型（来自 --models 标志），否则使用所有可用模型。
	 * @param direction - "forward" (默认) 或 "backward"
	 * @returns 新模型信息，如果只有一个可用模型则返回 undefined
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _getScopedModelsWithApiKey(): Promise<Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }> = [];

		for (const scoped of this._scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this._modelRegistry.getApiKeyForProvider(provider);
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = await this._getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// 应用模型
		this.agent.setModel(next.model);
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// 应用思考级别（setThinkingLevel 限制为模型能力）
		this.setThinkingLevel(next.thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this._modelRegistry.getApiKey(nextModel);
		if (!apiKey) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.agent.setModel(nextModel);
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// 针对新模型的能力重新限制思考级别
		this.setThinkingLevel(this.thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * 设置思考级别。
	 * 根据可用的思考级别限制为模型能力。
	 * 仅当级别实际更改时才保存到会话和设置。
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// 仅当实际更改时才持久化
		const isChanging = effectiveLevel !== this.agent.state.thinkingLevel;

		this.agent.setThinkingLevel(effectiveLevel);

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
		}
	}

	/**
	 * 循环到下一个思考级别。
	 * @returns 新级别，如果模型不支持思考则为 undefined
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * 获取当前模型的可用思考级别。
	 * 提供商将在内部限制为特定模型支持的级别。
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.supportsThinking()) return ["off"];
		return this.supportsXhighThinking() ? THINKING_LEVELS_WITH_XHIGH : THINKING_LEVELS;
	}

	/**
	 * 检查当前模型是否支持 xhigh 思考级别。
	 */
	supportsXhighThinking(): boolean {
		return this.model ? supportsXhigh(this.model) : false;
	}

	/**
	 * 检查当前模型是否支持思考/推理。
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _clampThinkingLevel(level: ThinkingLevel, availableLevels: ThinkingLevel[]): ThinkingLevel {
		const ordered = THINKING_LEVELS_WITH_XHIGH;
		const available = new Set(availableLevels);
		const requestedIndex = ordered.indexOf(level);
		if (requestedIndex === -1) {
			return availableLevels[0] ?? "off";
		}
		for (let i = requestedIndex; i < ordered.length; i++) {
			const candidate = ordered[i];
			if (available.has(candidate)) return candidate;
		}
		for (let i = requestedIndex - 1; i >= 0; i--) {
			const candidate = ordered[i];
			if (available.has(candidate)) return candidate;
		}
		return availableLevels[0] ?? "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/**
	 * 设置 steering 消息模式。
	 * 保存到设置。
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * 设置 follow-up 消息模式。
	 * 保存到设置。
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * 手动压缩会话上下文。
	 * 首先中止当前的代理操作。
	 * @param customInstructions 压缩摘要的可选说明
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this._disconnectFromAgent();
		await this.abort();
		this._compactionAbortController = new AbortController();

		try {
			if (!this.model) {
				throw new Error("No model selected");
			}

			const apiKey = await this._modelRegistry.getApiKey(this.model);
			if (!apiKey) {
				throw new Error(`No API key for ${this.model.provider}`);
			}

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// 检查为什么无法压缩
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner?.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// 扩展提供的压缩内容
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// 生成压缩结果
				const result = await compact(
					preparation,
					this.model,
					apiKey,
					customInstructions,
					this._compactionAbortController.signal,
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.replaceMessages(sessionContext.messages);

			// 获取保存的压缩条目以用于扩展事件
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			return {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			};
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
		}
	}

	/**
	 * 取消进行中的压缩（手动或自动）。
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * 取消进行中的分支摘要。
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * 检查是否需要压缩并运行它。
	 * 在 agent_end 之后和提交提示词之前调用。
	 *
	 * 两种情况：
	 * 1. 溢出：LLM 返回上下文溢出错误，从代理状态中移除错误消息，压缩，自动重试
	 * 2. 阈值：上下文超过阈值，压缩，不自动重试（用户手动继续）
	 *
	 * @param assistantMessage 要检查的助手消息
	 * @param skipAbortedCheck 如果为 false，则包括中止的消息（用于预提示检查）。默认值：true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return;

		// 如果消息被中止（用户取消）则跳过 - 除非 skipAbortedCheck 为 false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;

		const contextWindow = this.model?.contextWindow ?? 0;

		// 如果消息来自不同的模型，则跳过溢出检查。
		// 这处理了用户从较小上下文模型（例如 opus）切换的情况
		// 到较大上下文模型（例如 codex）- 旧模型的溢出错误
		// 不应触发新模型的压缩。
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// 如果错误来自当前路径中的压缩之前，则跳过溢出检查。
		// 这处理了压缩后保留错误的情况（在“保留”区域中）。
		// 错误不应再次触发压缩，因为我们已经压缩过了。
		// 示例：opus 失败 → 切换到 codex → 压缩 → 切换回 opus → opus 错误
		// 仍在上下文中，但不应再次触发压缩。
		const compactionEntry = this.sessionManager.getBranch().find((e) => e.type === "compaction");
		const errorIsFromBeforeCompaction =
			compactionEntry && assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime();

		// 情况 1：溢出 - LLM 返回上下文溢出错误
		if (sameModel && !errorIsFromBeforeCompaction && isContextOverflow(assistantMessage, contextWindow)) {
			// 从代理状态中移除错误消息（它被保存到会话以用于历史记录，
			// 但我们不希望它在重试的上下文中）
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.replaceMessages(messages.slice(0, -1));
			}
			await this._runAutoCompaction("overflow", true);
			return;
		}

		// 情况 2：阈值 - 回合成功但上下文变得很大
		// 如果这是错误则跳过（非溢出错误没有使用数据）
		if (assistantMessage.stopReason === "error") return;

		const contextTokens = calculateContextTokens(assistantMessage.usage);
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			await this._runAutoCompaction("threshold", false);
		}
	}

	/**
	 * 内部：运行带有事件的自动压缩。
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<void> {
		const settings = this.settingsManager.getCompactionSettings();

		this._emit({ type: "auto_compaction_start", reason });
		this._autoCompactionAbortController = new AbortController();

		try {
			if (!this.model) {
				this._emit({ type: "auto_compaction_end", result: undefined, aborted: false, willRetry: false });
				return;
			}

			const apiKey = await this._modelRegistry.getApiKey(this.model);
			if (!apiKey) {
				this._emit({ type: "auto_compaction_end", result: undefined, aborted: false, willRetry: false });
				return;
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				this._emit({ type: "auto_compaction_end", result: undefined, aborted: false, willRetry: false });
				return;
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner?.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({ type: "auto_compaction_end", result: undefined, aborted: true, willRetry: false });
					return;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// 扩展提供的压缩内容
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// 生成压缩结果
				const compactResult = await compact(
					preparation,
					this.model,
					apiKey,
					undefined,
					this._autoCompactionAbortController.signal,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({ type: "auto_compaction_end", result: undefined, aborted: true, willRetry: false });
				return;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.replaceMessages(sessionContext.messages);

			// 获取保存的压缩条目以用于扩展事件
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			};
			this._emit({ type: "auto_compaction_end", result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.replaceMessages(messages.slice(0, -1));
				}

				setTimeout(() => {
					this.agent.continue().catch(() => {});
				}, 100);
			} else if (this.agent.hasQueuedMessages()) {
				// 自动压缩可以在 follow-up/steering/custom 消息等待时完成。
				// 启动循环以便实际传递排队的消息。
				setTimeout(() => {
					this.agent.continue().catch(() => {});
				}, 100);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this._emit({
				type: "auto_compaction_end",
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * 切换自动压缩设置。
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** 自动压缩是否启用 */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		if (this._extensionRunner) {
			this._applyExtensionBindings(this._extensionRunner);
			await this._extensionRunner.emit({ type: "session_start" });
			await this.extendResourcesFromExtensions("startup");
		}
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner?.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.setSystemPrompt(this._baseSystemPrompt);
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const normalizeLocation = (source: string): SlashCommandLocation | undefined => {
			if (source === "user" || source === "project" || source === "path") {
				return source;
			}
			return undefined;
		};

		const reservedBuiltins = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner
				.getRegisteredCommandsWithPaths()
				.filter(({ command }) => !reservedBuiltins.has(command.name))
				.map(({ command, extensionPath }) => ({
					name: command.name,
					description: command.description,
					source: "extension",
					path: extensionPath,
				}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				location: normalizeLocation(template.source),
				path: template.filePath,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				location: normalizeLocation(skill.source),
				path: skill.filePath,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: (name) => {
					this.sessionManager.appendSessionInfo(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				getCommands,
				setModel: async (model) => {
					const key = await this.modelRegistry.getApiKey(model);
					if (!key) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => !this.isStreaming,
				abort: () => this.abort(),
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
			},
		);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const baseTools = this._baseToolsOverride
			? this._baseToolsOverride
			: createAllTools(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix },
				});

		this._baseToolRegistry = new Map(Object.entries(baseTools).map(([name, tool]) => [name, tool as AgentTool]));

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		const hasExtensions = extensionsResult.extensions.length > 0;
		const hasCustomTools = this._customTools.length > 0;
		this._extensionRunner =
			hasExtensions || hasCustomTools
				? new ExtensionRunner(
						extensionsResult.extensions,
						extensionsResult.runtime,
						this._cwd,
						this.sessionManager,
						this._modelRegistry,
					)
				: undefined;
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		if (this._extensionRunner) {
			this._bindExtensionCore(this._extensionRunner);
			this._applyExtensionBindings(this._extensionRunner);
		}

		const registeredTools = this._extensionRunner?.getAllRegisteredTools() ?? [];
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((def) => ({ definition: def, extensionPath: "<sdk>" })),
		];
		const wrappedExtensionTools = this._extensionRunner
			? wrapRegisteredTools(allCustomTools, this._extensionRunner)
			: [];

		const toolRegistry = new Map(this._baseToolRegistry);
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		const activeToolNameSet = new Set<string>(baseActiveToolNames);
		if (options.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools as AgentTool[]) {
				activeToolNameSet.add(tool.name);
			}
		}

		const extensionToolNames = new Set(wrappedExtensionTools.map((tool) => tool.name));
		const activeBaseTools = Array.from(activeToolNameSet)
			.filter((name) => this._baseToolRegistry.has(name) && !extensionToolNames.has(name))
			.map((name) => this._baseToolRegistry.get(name) as AgentTool);
		const activeExtensionTools = wrappedExtensionTools.filter((tool) => activeToolNameSet.has(tool.name));
		const activeToolsArray: AgentTool[] = [...activeBaseTools, ...activeExtensionTools];

		if (this._extensionRunner) {
			const wrappedActiveTools = wrapToolsWithExtensions(activeToolsArray, this._extensionRunner);
			this.agent.setTools(wrappedActiveTools as AgentTool[]);

			const wrappedAllTools = wrapToolsWithExtensions(Array.from(toolRegistry.values()), this._extensionRunner);
			this._toolRegistry = new Map(wrappedAllTools.map((tool) => [tool.name, tool]));
		} else {
			this.agent.setTools(activeToolsArray);
			this._toolRegistry = toolRegistry;
		}

		const systemPromptToolNames = Array.from(activeToolNameSet).filter((name) => this._baseToolRegistry.has(name));
		this._baseSystemPrompt = this._rebuildSystemPrompt(systemPromptToolNames);
		this.agent.setSystemPrompt(this._baseSystemPrompt);
	}

	async reload(): Promise<void> {
		const previousFlagValues = this._extensionRunner?.getFlagValues();
		await this._extensionRunner?.emit({ type: "session_shutdown" });
		this.settingsManager.reload();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (this._extensionRunner && hasBindings) {
			await this._extensionRunner.emit({ type: "session_start" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * 检查错误是否可重试（过载、速率限制、服务器错误）。
	 * 上下文溢出错误不可重试（由压缩处理）。
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// 上下文溢出由压缩处理，而不是重试
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		// 匹配：overloaded_error, rate limit, 429, 500, 502, 503, 504, service unavailable, connection errors, fetch failed, terminated, retry delay exceeded
		return /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server error|internal error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay/i.test(
			err,
		);
	}

	/**
	 * 使用指数退避处理可重试的错误。
	 * @returns 如果启动了重试则为 true，如果超过最大重试次数或已禁用则为 false
	 */
	private async _handleRetryableError(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) return false;

		this._retryAttempt++;

		// 在第一次尝试时创建重试 promise，以便 waitForRetry() 可以等待它
		if (this._retryAttempt === 1 && !this._retryPromise) {
			this._retryPromise = new Promise((resolve) => {
				this._retryResolve = resolve;
			});
		}

		if (this._retryAttempt > settings.maxRetries) {
			// 超过最大重试次数，发出最终失败并重置
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
			this._resolveRetry(); // 解析以便 waitForRetry() 完成
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// 从代理状态中移除错误消息（保留在会话中以用于历史记录）
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.replaceMessages(messages.slice(0, -1));
		}

		// 等待指数退避（可中止）
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// 休眠期间中止 - 发出结束事件以便 UI 可以清理
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._retryAbortController = undefined;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this._resolveRetry();
			return false;
		}
		this._retryAbortController = undefined;
		// 通过 continue() 重试 - 使用 setTimeout 跳出事件处理程序链
		setTimeout(() => {
			this.agent.continue().catch(() => {
				// 重试失败 - 将被下一个 agent_end 捕获
			});
		}, 0);

		return true;
	}

	/**
	 * 取消进行中的重试。
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
		// 注意：_retryAttempt 在 _autoRetry 的 catch 块中重置
		this._resolveRetry();
	}

	/**
	 * 等待任何进行中的重试完成。
	 * 如果没有进行中的重试，则立即返回。
	 */
	private async waitForRetry(): Promise<void> {
		if (this._retryPromise) {
			await this._retryPromise;
		}
	}

	/** 自动重试是否正在进行中 */
	get isRetrying(): boolean {
		return this._retryPromise !== undefined;
	}

	/** 自动重试是否启用 */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * 切换自动重试设置。
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * 执行 bash 命令。
	 * 将结果添加到代理上下文和会话。
	 * @param command 要执行的 bash 命令
	 * @param onChunk 输出的可选流式回调
	 * @param options.excludeFromContext 如果为 true，命令输出将不会发送到 LLM（!! 前缀）
	 * @param options.operations 用于远程执行的自定义 BashOperations
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		// 如果配置了命令前缀，则应用它（例如，用于别名支持的 "shopt -s expand_aliases"）
		const prefix = this.settingsManager.getShellCommandPrefix();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = options?.operations
				? await executeBashWithOperations(resolvedCommand, process.cwd(), options.operations, {
						onChunk,
						signal: this._bashAbortController.signal,
					})
				: await executeBashCommand(resolvedCommand, {
						onChunk,
						signal: this._bashAbortController.signal,
					});

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * 在会话历史记录中记录 bash 执行结果。
	 * 由 executeBash 和自己处理 bash 执行的扩展使用。
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// 如果代理正在流式传输，推迟添加以避免破坏 tool_use/tool_result 顺序
		if (this.isStreaming) {
			// 排队等待稍后处理 - 将在 agent_end 上刷新
			this._pendingBashMessages.push(bashMessage);
		} else {
			// 立即添加到代理状态
			this.agent.appendMessage(bashMessage);

			// 保存到会话
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * 取消正在运行的 bash 命令。
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** bash 命令当前是否正在运行 */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** 是否有待处理的 bash 消息等待刷新 */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * 将待处理的 bash 消息刷新到代理状态和会话。
	 * 在代理回合完成后调用，以保持正确的消息顺序。
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// 添加到代理状态
			this.agent.appendMessage(bashMessage);

			// 保存到会话
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * 切换到不同的会话文件。
	 * 中止当前操作，加载消息，恢复模型/思考级别。
	 * 监听器被保留并将继续接收事件。
	 * @returns 如果切换完成则为 true，如果被扩展取消则为 false
	 */
	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();

		// 发出 session_before_switch 事件（可取消）
		if (this._extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this._disconnectFromAgent();
		await this.abort();
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._pendingNextTurnMessages = [];

		// 设置新会话
		this.sessionManager.setSessionFile(sessionPath);
		this.agent.sessionId = this.sessionManager.getSessionId();

		// 重新加载消息
		const sessionContext = this.sessionManager.buildSessionContext();

		// 向扩展发出 session_switch 事件
		if (this._extensionRunner) {
			await this._extensionRunner.emit({
				type: "session_switch",
				reason: "resume",
				previousSessionFile,
			});
		}

		// 向自定义工具发出会话事件

		this.agent.replaceMessages(sessionContext.messages);

		// 如果已保存，恢复模型
		if (sessionContext.model) {
			const previousModel = this.model;
			const availableModels = await this._modelRegistry.getAvailable();
			const match = availableModels.find(
				(m) => m.provider === sessionContext.model!.provider && m.id === sessionContext.model!.modelId,
			);
			if (match) {
				this.agent.setModel(match);
				await this._emitModelSelect(match, previousModel, "restore");
			}
		}

		const hasThinkingEntry = this.sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");
		const defaultThinkingLevel = this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;

		if (hasThinkingEntry) {
			// 如果已保存，恢复思考级别（setThinkingLevel 限制为模型能力）
			this.setThinkingLevel(sessionContext.thinkingLevel as ThinkingLevel);
		} else {
			const availableLevels = this.getAvailableThinkingLevels();
			const effectiveLevel = availableLevels.includes(defaultThinkingLevel)
				? defaultThinkingLevel
				: this._clampThinkingLevel(defaultThinkingLevel, availableLevels);
			this.agent.setThinkingLevel(effectiveLevel);
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
		}

		this._reconnectToAgent();
		return true;
	}

	/**
	 * 为当前会话设置显示名称。
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
	}

	/**
	 * 从特定条目创建分支。
	 * 向扩展发出 before_fork/fork 会话事件。
	 *
	 * @param entryId 要分叉的条目 ID
	 * @returns 包含以下内容的对象：
	 *   - selectedText: 所选用户消息的文本（用于编辑器预填充）
	 *   - cancelled: 如果扩展取消了分叉，则为 true
	 */
	async fork(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for forking");
		}

		const selectedText = this._extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		// 发出 session_before_fork 事件（可取消）
		if (this._extensionRunner?.hasHandlers("session_before_fork")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_fork",
				entryId,
			})) as SessionBeforeForkResult | undefined;

			if (result?.cancel) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		// 清除待处理消息（绑定到旧会话状态）
		this._pendingNextTurnMessages = [];

		if (!selectedEntry.parentId) {
			this.sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			this.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.agent.sessionId = this.sessionManager.getSessionId();

		// 从条目重新加载消息（适用于文件和内存模式）
		const sessionContext = this.sessionManager.buildSessionContext();

		// 向扩展发出 session_fork 事件（分叉完成后）
		if (this._extensionRunner) {
			await this._extensionRunner.emit({
				type: "session_fork",
				previousSessionFile,
			});
		}

		// 向自定义工具发出会话事件（原因为 "fork"）

		if (!skipConversationRestore) {
			this.agent.replaceMessages(sessionContext.messages);
		}

		return { selectedText, cancelled: false };
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * 导航到会话树中的不同节点。
	 * 与创建新会话文件的 fork() 不同，这会保留在同一个文件中。
	 *
	 * @param targetId 要导航到的条目 ID
	 * @param options.summarize 用户是否想要总结被放弃的分支
	 * @param options.customInstructions 总结器的自定义说明
	 * @param options.replaceInstructions 如果为 true，则 customInstructions 替换默认提示词
	 * @param options.label 要附加到分支摘要条目的标签
	 * @returns 包含 editorText（如果是用户消息）和 cancelled 状态的结果
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// 如果已经在目标位置，则不执行任何操作
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// 总结需要模型
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// 收集要总结的条目（从旧叶子到共同祖先）
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// 准备事件数据 - 可变，以便扩展可以覆盖
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// 设置用于总结的中止控制器
		this._branchSummaryAbortController = new AbortController();
		let extensionSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// 发出 session_before_tree 事件
		if (this._extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this._branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				extensionSummary = result.summary;
				fromExtension = true;
			}

			// 允许扩展覆盖说明和标签
			if (result?.customInstructions !== undefined) {
				customInstructions = result.customInstructions;
			}
			if (result?.replaceInstructions !== undefined) {
				replaceInstructions = result.replaceInstructions;
			}
			if (result?.label !== undefined) {
				label = result.label;
			}
		}

		// 如果需要，运行默认总结器
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
			const model = this.model!;
			const apiKey = await this._modelRegistry.getApiKey(model);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}
			const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey,
				signal: this._branchSummaryAbortController.signal,
				customInstructions,
				replaceInstructions,
				reserveTokens: branchSummarySettings.reserveTokens,
			});
			this._branchSummaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (extensionSummary) {
			summaryText = extensionSummary.summary;
			summaryDetails = extensionSummary.details;
		}

		// 根据目标类型确定新的叶子位置
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// 用户消息：leaf = parent（如果是根则为 null），文本进入编辑器
			newLeafId = targetEntry.parentId;
			editorText = this._extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// 自定义消息：leaf = parent（如果是根则为 null），文本进入编辑器
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
		} else {
			// 非用户消息：leaf = 选定节点
			newLeafId = targetId;
		}

		// 切换叶子（有或无摘要）
		// 摘要附加在导航目标位置（newLeafId），而不是旧分支
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			// 在目标位置创建摘要（对于根可以为 null）
			const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
			summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

			// 将标签附加到摘要条目
			if (label) {
				this.sessionManager.appendLabelChange(summaryId, label);
			}
		} else if (newLeafId === null) {
			// 无摘要，导航到根 - 重置叶子
			this.sessionManager.resetLeaf();
		} else {
			// 无摘要，导航到非根
			this.sessionManager.branch(newLeafId);
		}

		// 当不总结时将标签附加到目标条目（没有摘要条目可标记）
		if (label && !summaryText) {
			this.sessionManager.appendLabelChange(targetId, label);
		}

		// 更新代理状态
		const sessionContext = this.sessionManager.buildSessionContext();
		this.agent.replaceMessages(sessionContext.messages);

		// 发出 session_tree 事件
		if (this._extensionRunner) {
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
		}

		// 发送到自定义工具


		this._branchSummaryAbortController = undefined;
		return { editorText, cancelled: false, summaryEntry };
	}

	/**
	 * 获取会话中的所有用户消息以供 fork 选择器使用。
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * 获取会话统计信息。
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
			usageTokens: estimate.usageTokens,
			trailingTokens: estimate.trailingTokens,
			lastUsageIndex: estimate.lastUsageIndex,
		};
	}

	/**
	 * 将会话导出为 HTML。
	 * @param outputPath 可选输出路径（默认为会话目录）
	 * @returns 导出文件的路径
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.settingsManager.getTheme();

		// 如果我们有扩展运行器（用于自定义工具 HTML 渲染），则创建工具渲染器
		let toolRenderer: ToolHtmlRenderer | undefined;
		if (this._extensionRunner) {
			toolRenderer = createToolHtmlRenderer({
				getToolDefinition: (name) => this._extensionRunner!.getToolDefinition(name),
				theme,
			});
		}

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * 获取最后一条助手消息的文本内容。
	 * 对于 /copy 命令很有用。
	 * @returns 文本内容，如果不存在助手消息则为 undefined
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// 跳过没有内容的已中止消息
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * 检查扩展是否有特定事件类型的处理程序。
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * 获取扩展运行器（用于设置 UI 上下文和错误处理程序）。
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this._extensionRunner;
	}
}

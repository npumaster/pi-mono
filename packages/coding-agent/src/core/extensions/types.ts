/**
 * 扩展系统类型。
 *
 * 扩展是可以执行以下操作的 TypeScript 模块：
 * - 订阅 agent 生命周期事件
 * - 注册 LLM 可调用的工具
 * - 注册命令、键盘快捷键和 CLI 标志
 * - 通过 UI 原语与用户交互
 */

import type {
	AgentMessage,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import type {
	AutocompleteItem,
	Component,
	EditorComponent,
	EditorTheme,
	KeyId,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@mariozechner/pi-tui";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type { BashResult } from "../bash-executor.js";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.js";
import type { EventBus } from "../event-bus.js";
import type { ExecOptions, ExecResult } from "../exec.js";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.js";
import type { KeybindingsManager } from "../keybindings.js";
import type { CustomMessage } from "../messages.js";
import type { ModelRegistry } from "../model-registry.js";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionManager,
} from "../session-manager.js";
import type { SlashCommandInfo } from "../slash-commands.js";
import type { BashOperations } from "../tools/bash.js";
import type { EditToolDetails } from "../tools/edit.js";
import type {
	BashToolDetails,
	BashToolInput,
	EditToolInput,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	GrepToolInput,
	LsToolDetails,
	LsToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "../tools/index.js";

export type { ExecOptions, ExecResult } from "../exec.js";
export type { AgentToolResult, AgentToolUpdateCallback };
export type { AppAction, KeybindingsManager } from "../keybindings.js";

// ============================================================================
// UI Context
// ============================================================================

/** 扩展 UI 对话框的选项。 */
export interface ExtensionUIDialogOptions {
	/** 以编程方式关闭对话框的 AbortSignal。 */
	signal?: AbortSignal;
	/** 以毫秒为单位的超时。对话框会自动关闭并显示倒计时。 */
	timeout?: number;
}

/** 扩展小部件的放置位置。 */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** 扩展小部件的选项。 */
export interface ExtensionWidgetOptions {
	/** 小部件呈现的位置。默认为 "aboveEditor"。 */
	placement?: WidgetPlacement;
}

/**
 * 用于扩展请求交互式 UI 的 UI 上下文。
 * 每个模式（interactive, RPC, print）都提供自己的实现。
 */
export interface ExtensionUIContext {
	/** 显示选择器并返回用户的选择。 */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** 显示确认对话框。 */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** 显示文本输入对话框。 */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** 向用户显示通知。 */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** 设置页脚/状态栏中的状态文本。传递 undefined 以清除。 */
	setStatus(key: string, text: string | undefined): void;

	/** 设置流式传输期间显示的工作/加载消息。调用时不带参数以恢复默认值。 */
	setWorkingMessage(message?: string): void;

	/** 设置显示在编辑器上方或下方的小部件。接受字符串数组或组件工厂。 */
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;

	/** 设置自定义页脚组件，或传递 undefined 以恢复内置页脚。
	 *
	 * 工厂接收 FooterDataProvider 以获取无法通过其他方式访问的数据：
	 * git 分支和来自 setStatus() 的扩展状态。令牌统计信息、模型信息等
	 * 可通过 ctx.sessionManager 和 ctx.model 获取。
	 */
	setFooter(
		factory:
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;

	/** 设置自定义页眉组件（在启动时显示在聊天上方），或传递 undefined 以恢复内置页眉。 */
	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	/** 设置终端窗口/标签标题。 */
	setTitle(title: string): void;

	/** 显示具有键盘焦点的自定义组件。 */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			/** 叠加层定位/尺寸选项。可以是静态的，也可以是用于动态更新的函数。 */
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			/** 在显示叠加层后，使用叠加层句柄调用。用于控制可见性。 */
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T>;

	/** 将文本粘贴到编辑器中，触发粘贴处理（大内容折叠）。 */
	pasteToEditor(text: string): void;

	/** 设置核心输入编辑器中的文本。 */
	setEditorText(text: string): void;

	/** 获取核心输入编辑器中的当前文本。 */
	getEditorText(): string;

	/** 显示用于文本编辑的多行编辑器。 */
	editor(title: string, prefill?: string): Promise<string | undefined>;

	/**
	 * 通过工厂函数设置自定义编辑器组件。
	 * 传递 undefined 以恢复默认编辑器。
	 *
	 * 工厂接收：
	 * - `theme`: 用于样式化边框和自动完成的 EditorTheme
	 * - `keybindings`: 用于应用级按键绑定的 KeybindingsManager
	 *
	 * 为了获得完整的应用程序按键绑定支持（退出、ctrl+d、模型切换等），
	 * 请从 `@mariozechner/pi-coding-agent` 扩展 `CustomEditor` 并为你不处理的按键调用
	 * `super.handleInput(data)`。
	 *
	 * @example
	 * ```ts
	 * import { CustomEditor } from "@mariozechner/pi-coding-agent";
	 *
	 * class VimEditor extends CustomEditor {
	 *   private mode: "normal" | "insert" = "insert";
	 *
	 *   handleInput(data: string): void {
	 *     if (this.mode === "normal") {
	 *       // 处理 vim 普通模式按键...
	 *       if (data === "i") { this.mode = "insert"; return; }
	 *     }
	 *     super.handleInput(data);  // 应用按键绑定 + 文本编辑
	 *   }
	 * }
	 *
	 * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
	 *   new VimEditor(tui, theme, keybindings)
	 * );
	 * ```
	 */
	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
	): void;

	/** 获取当前的样式主题。 */
	readonly theme: Theme;

	/** 获取所有可用主题及其名称和文件路径。 */
	getAllThemes(): { name: string; path: string | undefined }[];

	/** 按名称加载主题而不切换到它。如果未找到则返回 undefined。 */
	getTheme(name: string): Theme | undefined;

	/** 通过名称或 Theme 对象设置当前主题。 */
	setTheme(theme: string | Theme): { success: boolean; error?: string };

	/** 获取当前工具输出展开状态。 */
	getToolsExpanded(): boolean;

	/** 设置工具输出展开状态。 */
	setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// Extension Context
// ============================================================================

export interface ContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

export interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/**
 * 传递给扩展事件处理程序的上下文。
 */
export interface ExtensionContext {
	/** 用于用户交互的 UI 方法 */
	ui: ExtensionUIContext;
	/** UI 是否可用（在 print/RPC 模式下为 false） */
	hasUI: boolean;
	/** 当前工作目录 */
	cwd: string;
	/** 会话管理器（只读） */
	sessionManager: ReadonlySessionManager;
	/** 用于 API 密钥解析的模型注册表 */
	modelRegistry: ModelRegistry;
	/** 当前模型（可能未定义） */
	model: Model<any> | undefined;
	/** agent 是否空闲（未流式传输） */
	isIdle(): boolean;
	/** 中止当前 agent 操作 */
	abort(): void;
	/** 是否有排队的消息在等待 */
	hasPendingMessages(): boolean;
	/** 正常关闭 pi 并退出。在所有上下文中可用。 */
	shutdown(): void;
	/** 获取当前活动模型的上下文使用情况。 */
	getContextUsage(): ContextUsage | undefined;
	/** 触发压缩而不等待完成。 */
	compact(options?: CompactOptions): void;
	/** 获取当前有效的系统提示。 */
	getSystemPrompt(): string;
}

/**
 * 命令处理程序的扩展上下文。
 * 仅包含在用户发起的命令中安全的会话控制方法。
 */
export interface ExtensionCommandContext extends ExtensionContext {
	/** 等待 agent 完成流式传输 */
	waitForIdle(): Promise<void>;

	/** 启动新会话，可选择初始化。 */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** 从特定条目分叉，创建新的会话文件。 */
	fork(entryId: string): Promise<{ cancelled: boolean }>;

	/** 导航到会话树中的不同点。 */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;

	/** 切换到不同的会话文件。 */
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;

	/** 重新加载扩展、技能、提示和主题。 */
	reload(): Promise<void>;
}

// ============================================================================
// Tool Types
// ============================================================================

/** 工具结果的渲染选项 */
export interface ToolRenderResultOptions {
	/** 结果视图是否已扩展 */
	expanded: boolean;
	/** 这是否是部分/流式结果 */
	isPartial: boolean;
}

/**
 * registerTool() 的工具定义。
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	/** 工具名称（用于 LLM 工具调用） */
	name: string;
	/** UI 的人类可读标签 */
	label: string;
	/** LLM 的描述 */
	description: string;
	/** 参数模式 (TypeBox) */
	parameters: TParams;

	/** 执行工具。 */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	/** 工具调用显示的自定义渲染 */
	renderCall?: (args: Static<TParams>, theme: Theme) => Component;

	/** 工具结果显示的自定义渲染 */
	renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme) => Component;
}

// ============================================================================
// Resource Events
// ============================================================================

/** 在 session_start 之后触发，允许扩展提供额外的资源路径。 */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** 来自 resources_discover 事件处理程序的结果 */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

// ============================================================================
// Session Events
// ============================================================================

/** 在初始会话加载时触发 */
export interface SessionStartEvent {
	type: "session_start";
}

/** 在切换到另一个会话之前触发（可以取消） */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

/** 在切换到另一个会话之后触发 */
export interface SessionSwitchEvent {
	type: "session_switch";
	reason: "new" | "resume";
	previousSessionFile: string | undefined;
}

/** 在分叉会话之前触发（可以取消） */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
}

/** 在分叉会话之后触发 */
export interface SessionForkEvent {
	type: "session_fork";
	previousSessionFile: string | undefined;
}

/** 在上下文压缩之前触发（可以取消或自定义） */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	signal: AbortSignal;
}

/** 在上下文压缩之后触发 */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
}

/** 在进程退出时触发 */
export interface SessionShutdownEvent {
	type: "session_shutdown";
}

/** 树导航的准备数据 */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	/** 总结的自定义说明 */
	customInstructions?: string;
	/** 如果为 true，则 customInstructions 将替换默认提示而不是追加 */
	replaceInstructions?: boolean;
	/** 要附加到分支摘要条目的标签 */
	label?: string;
}

/** 在会话树中导航之前触发（可以取消） */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** 在会话树中导航之后触发 */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionBeforeSwitchEvent
	| SessionSwitchEvent
	| SessionBeforeForkEvent
	| SessionForkEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;

// ============================================================================
// Agent Events
// ============================================================================

/** 在每次 LLM 调用之前触发。可以修改消息。 */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/** 在用户提交提示后但在 agent 循环之前触发。 */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string;
}

/** 当 agent 循环开始时触发 */
export interface AgentStartEvent {
	type: "agent_start";
}

/** 当 agent 循环结束时触发 */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

/** 在每轮开始时触发 */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** 在每轮结束时触发 */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

// ============================================================================
// Model Events
// ============================================================================

export type ModelSelectSource = "set" | "cycle" | "restore";

/** 当选择新模型时触发 */
export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
}

// ============================================================================
// User Bash Events
// ============================================================================

/** 当用户通过 ! 或 !! 前缀执行 bash 命令时触发 */
export interface UserBashEvent {
	type: "user_bash";
	/** 要执行的命令 */
	command: string;
	/** 如果使用了 !! 前缀则为 true（从 LLM 上下文中排除） */
	excludeFromContext: boolean;
	/** 当前工作目录 */
	cwd: string;
}

// ============================================================================
// Input Events
// ============================================================================

/** 用户输入的来源 */
export type InputSource = "interactive" | "rpc" | "extension";

/** 收到用户输入时触发，在 agent 处理之前 */
export interface InputEvent {
	type: "input";
	/** 输入文本 */
	text: string;
	/** 附加图像（如果有） */
	images?: ImageContent[];
	/** 输入来自哪里 */
	source: InputSource;
}

/** 输入事件处理程序的结果 */
export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

// ============================================================================
// Tool Events
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: EditToolInput;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface LsToolCallEvent extends ToolCallEventBase {
	toolName: "ls";
	input: LsToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/** 在工具执行之前触发。可以阻塞。 */
export type ToolCallEvent =
	| BashToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| GrepToolCallEvent
	| FindToolCallEvent
	| LsToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

export interface LsToolResultEvent extends ToolResultEventBase {
	toolName: "ls";
	details: LsToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** 在工具执行后触发。可以修改结果。 */
export type ToolResultEvent =
	| BashToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| FindToolResultEvent
	| LsToolResultEvent
	| CustomToolResultEvent;

// ToolResultEvent 的类型保护
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	return e.toolName === "read";
}
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	return e.toolName === "edit";
}
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	return e.toolName === "write";
}
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
	return e.toolName === "grep";
}
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
	return e.toolName === "find";
}
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
	return e.toolName === "ls";
}

/**
 * 用于按工具名称缩小 ToolCallEvent 的类型保护。
 *
 * 内置工具自动缩小（无需类型参数）：
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * 自定义工具需要显式类型参数：
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * 注意：直接通过 `event.toolName === "bash"` 缩小不起作用，因为
 * CustomToolCallEvent.toolName 是 `string`，它与所有文字重叠。
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

/** 所有事件类型的联合 */
export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| ModelSelectEvent
	| UserBashEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

// ============================================================================
// Event Results
// ============================================================================

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
}

/** user_bash 事件处理程序的结果 */
export interface UserBashEventResult {
	/** 用于执行的自定义操作 */
	operations?: BashOperations;
	/** 完全替换：扩展处理执行，使用此结果 */
	result?: BashResult;
}

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** 替换此轮的系统提示。如果多个扩展返回此内容，则它们会被链接。 */
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
	};
	/** 覆盖总结的自定义说明 */
	customInstructions?: string;
	/** 覆盖 customInstructions 是否替换默认提示 */
	replaceInstructions?: boolean;
	/** 覆盖附加到分支摘要条目的标签 */
	label?: string;
}

// ============================================================================
// Message Rendering
// ============================================================================

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

// ============================================================================
// Command Registration
// ============================================================================

export interface RegisteredCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// ============================================================================
// Extension API
// ============================================================================

/** 事件的处理程序函数类型 */
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * 传递给扩展工厂函数的 ExtensionAPI。
 */
export interface ExtensionAPI {
	// =========================================================================
	// Event Subscription
	// =========================================================================

	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_switch", handler: ExtensionHandler<SessionSwitchEvent>): void;
	on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): void;
	on(event: "session_fork", handler: ExtensionHandler<SessionForkEvent>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;

	// =========================================================================
	// 工具注册
	// =========================================================================

	/** 注册一个 LLM 可以调用的工具。 */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;

	// =========================================================================
	// 命令、快捷键、标志注册
	// =========================================================================

	/** 注册自定义命令。 */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void;

	/** 注册键盘快捷键。 */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	/** 注册 CLI 标志。 */
	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;

	/** 获取已注册 CLI 标志的值。 */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// 消息渲染
	// =========================================================================

	/** 为 CustomMessageEntry 注册自定义渲染器。 */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	// =========================================================================
	// 操作
	// =========================================================================

	/** 向会话发送自定义消息。 */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	/**
	 * 向 agent 发送用户消息。始终触发一轮对话。
	 * 当 agent 正在流式传输时，使用 deliverAs 指定如何排队消息。
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;

	/** 将自定义条目附加到会话以保持状态（不发送给 LLM）。 */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	// =========================================================================
	// 会话元数据
	// =========================================================================

	/** 设置会话显示名称（显示在会话选择器中）。 */
	setSessionName(name: string): void;

	/** 获取当前会话名称（如果已设置）。 */
	getSessionName(): string | undefined;

	/** 在条目上设置或清除标签。标签是用于书签/导航的用户定义标记。 */
	setLabel(entryId: string, label: string | undefined): void;

	/** 执行 shell 命令。 */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** 获取当前活动工具名称的列表。 */
	getActiveTools(): string[];

	/** 获取所有已配置工具的名称和描述。 */
	getAllTools(): ToolInfo[];

	/** 按名称设置活动工具。 */
	setActiveTools(toolNames: string[]): void;

	/** 获取当前会话中可用的斜杠命令。 */
	getCommands(): SlashCommandInfo[];

	// =========================================================================
	// 模型和思考层级
	// =========================================================================

	/** 设置当前模型。如果没有可用的 API 密钥，则返回 false。 */
	setModel(model: Model<any>): Promise<boolean>;

	/** 获取当前思考层级。 */
	getThinkingLevel(): ThinkingLevel;

	/** 设置思考层级（受限于模型能力）。 */
	setThinkingLevel(level: ThinkingLevel): void;

	// =========================================================================
	// 提供商注册
	// =========================================================================

	/**
	 * 注册或覆盖模型提供商。
	 *
	 * 如果提供了 `models`：替换此提供商的所有现有模型。
	 * 如果仅提供 `baseUrl`：覆盖现有模型的 URL。
	 * 如果提供了 `oauth`：注册 OAuth 提供商以支持 /login。
	 * 如果提供了 `streamSimple`：注册自定义 API 流处理程序。
	 *
	 * @example
	 * // 使用自定义模型注册新提供商
	 * pi.registerProvider("my-proxy", {
	 *   baseUrl: "https://proxy.example.com",
	 *   apiKey: "PROXY_API_KEY",
	 *   api: "anthropic-messages",
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4-20250514",
	 *       name: "Claude 4 Sonnet (proxy)",
	 *       reasoning: false,
	 *       input: ["text", "image"],
	 *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	 *       contextWindow: 200000,
	 *       maxTokens: 16384
	 *     }
	 *   ]
	 * });
	 *
	 * @example
	 * // 覆盖现有提供商的 baseUrl
	 * pi.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 *
	 * @example
	 * // 注册具有 OAuth 支持的提供商
	 * pi.registerProvider("corporate-ai", {
	 *   baseUrl: "https://ai.corp.com",
	 *   api: "openai-responses",
	 *   models: [...],
	 *   oauth: {
	 *     name: "Corporate AI (SSO)",
	 *     async login(callbacks) { ... },
	 *     async refreshToken(credentials) { ... },
	 *     getApiKey(credentials) { return credentials.access; }
	 *   }
	 * });
	 */
	registerProvider(name: string, config: ProviderConfig): void;

	/** 用于扩展通信的共享事件总线。 */
	events: EventBus;
}

// ============================================================================
// Provider Registration Types
// ============================================================================

/** 通过 pi.registerProvider() 注册提供商的配置。 */
export interface ProviderConfig {
	/** API 端点的基准 URL。定义模型时必填。 */
	baseUrl?: string;
	/** API 密钥或环境变量名称。定义模型时必填（除非提供了 oauth）。 */
	apiKey?: string;
	/** API 类型。定义模型时在提供商或模型级别必填。 */
	api?: Api;
	/** 用于自定义 API 的可选 streamSimple 处理程序。 */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** 要包含在请求中的自定义标头。 */
	headers?: Record<string, string>;
	/** 如果为 true，则添加带有解析后的 API 密钥的 Authorization: Bearer 标头。 */
	authHeader?: boolean;
	/** 要注册的模型。如果提供，则替换此提供商的所有现有模型。 */
	models?: ProviderModelConfig[];
	/** 用于 /login 支持的 OAuth 提供商。`id` 会根据提供商名称自动设置。 */
	oauth?: {
		/** 登录 UI 中显示给提供商的名称。 */
		name: string;
		/** 运行登录流程，返回要持久化的凭据。 */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		/** 刷新过期的凭据，返回更新后的要持久化的凭据。 */
		refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		/** 将凭据转换为提供商的 API 密钥字符串。 */
		getApiKey(credentials: OAuthCredentials): string;
		/** 可选：修改此提供商的模型（例如，根据凭据更新 baseUrl）。 */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

/** 提供商内模型的配置。 */
export interface ProviderModelConfig {
	/** 模型 ID（例如 "claude-sonnet-4-20250514"）。 */
	id: string;
	/** 显示名称（例如 "Claude 4 Sonnet"）。 */
	name: string;
	/** 此模型的 API 类型覆盖。 */
	api?: Api;
	/** 模型是否支持扩展思考。 */
	reasoning: boolean;
	/** 支持的输入类型。 */
	input: ("text" | "image")[];
	/** 每个 token 的成本（用于跟踪，可以为 0）。 */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** 以 token 为单位的最大上下文窗口大小。 */
	contextWindow: number;
	/** 最大输出 token 数。 */
	maxTokens: number;
	/** 此模型的自定义标头。 */
	headers?: Record<string, string>;
	/** OpenAI 兼容性设置。 */
	compat?: Model<Api>["compat"];
}

/** 扩展工厂函数类型。支持同步和异步初始化。 */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

// ============================================================================
// Loaded Extension Types
// ============================================================================

export interface RegisteredTool {
	definition: ToolDefinition;
	extensionPath: string;
}

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SendMessageHandler = <T = unknown>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp" },
) => void;

export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

export type SetSessionNameHandler = (name: string) => void;

export type GetSessionNameHandler = () => string | undefined;

export type GetActiveToolsHandler = () => string[];

/** 包含名称、描述和参数架构的工具信息 */
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters">;

export type GetAllToolsHandler = () => ToolInfo[];

export type GetCommandsHandler = () => SlashCommandInfo[];

export type SetActiveToolsHandler = (toolNames: string[]) => void;

export type SetModelHandler = (model: Model<any>) => Promise<boolean>;

export type GetThinkingLevelHandler = () => ThinkingLevel;

export type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

export type SetLabelHandler = (entryId: string, label: string | undefined) => void;

/**
 * 由加载器创建的共享状态，在注册和运行时使用。
 * 包含标志值（在注册期间设置默认值，在之后设置 CLI 值）。
 */
export interface ExtensionRuntimeState {
	flagValues: Map<string, boolean | string>;
	/** 在扩展加载期间排队的提供商注册，在运行器绑定时处理 */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig }>;
}

/**
 * pi.* API 方法的操作实现。
 * 提供给 runner.initialize()，复制到共享运行时。
 */
export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setSessionName: SetSessionNameHandler;
	getSessionName: GetSessionNameHandler;
	setLabel: SetLabelHandler;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
}

/**
 * ExtensionContext 的操作（事件处理程序中的 ctx.*）。
 * 所有模式都需要。
 */
export interface ExtensionContextActions {
	getModel: () => Model<any> | undefined;
	isIdle: () => boolean;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
}

/**
 * ExtensionCommandContext 的操作（命令处理程序中的 ctx.*）。
 * 仅交互模式下需要，在此模式下扩展命令可调用。
 */
export interface ExtensionCommandContextActions {
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	fork: (entryId: string) => Promise<{ cancelled: boolean }>;
	navigateTree: (
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	) => Promise<{ cancelled: boolean }>;
	switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

/**
 * 完整运行时 = 状态 + 操作。
 * 由加载器使用抛出异常的操作存根创建，由 runner.initialize() 完成。
 */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** 具有所有注册项的已加载扩展。 */
export interface Extension {
	path: string;
	resolvedPath: string;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool>;
	messageRenderers: Map<string, MessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** 加载扩展的结果。 */
export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	/** 共享运行时 - 操作是抛出异常的存根，直到 runner.initialize() */
	runtime: ExtensionRuntime;
}

// ============================================================================
// Extension Error
// ============================================================================

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}

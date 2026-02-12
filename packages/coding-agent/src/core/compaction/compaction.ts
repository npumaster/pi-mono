/**
 * 长会话的上下文压缩。
 *
 * 压缩逻辑的纯函数。会话管理器处理 I/O，
 * 压缩后会话将重新加载。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.js";
import type { CompactionEntry, SessionEntry } from "../session-manager.js";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.js";

// ============================================================================
// 文件操作跟踪
// ============================================================================

/** 存储在 CompactionEntry.details 中的详细信息，用于文件跟踪 */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * 从消息和以前的压缩条目中提取文件操作。
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// 收集以前压缩的详细信息（如果是 pi 生成的）
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook 字段保留用于会话文件兼容性
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// 从消息中的工具调用中提取
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// 消息提取
// ============================================================================

/**
 * 如果条目产生消息，则从中提取 AgentMessage。
 * 对于不贡献 LLM 上下文的条目，返回 undefined。
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

/** compact() 的结果 - SessionManager 在保存时添加 uuid/parentUuid */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** 扩展特定数据（例如，ArtifactIndex，结构化压缩的版本标记） */
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// 令牌计算
// ============================================================================

/**
 * 从使用情况计算总上下文令牌。
 * 在可用时使用本机 totalTokens 字段，否则回退到从组件计算。
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * 如果可用，从助手消息中获取使用情况。
 * 跳过中止和错误消息，因为它们没有有效的使用数据。
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * 从会话条目中查找最后一次非中止的助手消息使用情况。
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * 根据消息估算上下文令牌，在可用时使用最后一次助手使用情况。
 * 如果最后一次使用情况之后还有消息，则使用 estimateTokens 估算它们的令牌。
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * 根据上下文使用情况检查是否应触发压缩。
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// 切割点检测
// ============================================================================

/**
 * 使用 chars/4 启发式方法估算消息的令牌计数。
 * 这是保守的（高估令牌）。
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				chars = content.length;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			if (typeof message.content === "string") {
				chars = message.content.length;
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
					if (block.type === "image") {
						chars += 4800; // Estimate images as 4000 chars, or 1200 tokens
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

/**
 * 查找有效切割点：用户、助手、自定义或 bashExecution 消息的索引。
 * 切勿在工具结果处切割（它们必须跟随其工具调用）。
 * 当我们在带有工具调用的助手消息处切割时，其工具结果跟随它并将被保留。
 * BashExecutionMessage 被视为用户消息（用户发起的上下文）。
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
		}
		// branch_summary 和 custom_message 是用户角色消息，有效切割点
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * 查找开始包含给定条目索引的轮次的用户消息（或 bashExecution）。
 * 如果在索引之前未找到轮次开始，则返回 -1。
 * BashExecutionMessage 被视为轮次边界的用户消息。
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary 和 custom_message 是用户角色消息，可以开始轮次
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** 要保留的第一个条目的索引 */
	firstKeptEntryIndex: number;
	/** 开始被分割轮次的用户消息索引，如果不分割则为 -1 */
	turnStartIndex: number;
	/** 此切割点是否分割了轮次（切割点不是用户消息） */
	isSplitTurn: boolean;
}

/**
 * 在会话条目中查找保留约 `keepRecentTokens` 的切割点。
 *
 * 算法：从最新的条目开始向后遍历，累加估算的消息大小。
 * 当累加的令牌数 >= keepRecentTokens 时停止。在该点进行切割。
 *
 * 可以在用户或助手消息处切割（绝不能在工具结果处）。在带有工具调用的助手消息处切割时，
 * 其工具结果跟随其后并会被保留。
 *
 * 返回 CutPointResult，包含：
 * - firstKeptEntryIndex: 开始保留的条目索引
 * - turnStartIndex: 如果切割发生在轮次中，则是开始该轮次的用户消息
 * - isSplitTurn: 我们是否正在轮次中间切割
 *
 * 仅考虑 `startIndex` 和 `endIndex`（不包括）之间的条目。
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// 从最新的条目开始向后遍历，累加估算的消息大小
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // 默认值：从第一条消息开始保留（不是 header）

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		// 估算此消息的大小
		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;

		// 检查是否超出了预算
		if (accumulatedTokens >= keepRecentTokens) {
			// 找到此条目处或之后的最近有效切割点
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// 从 cutIndex 向后扫描，以包含任何非消息条目（bash、设置等）
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// 在会话 header 或压缩边界处停止
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// 如果遇到任何消息则停止
			break;
		}
		// 包含此非消息条目（bash、设置更改等）
		cutIndex--;
	}

	// 确定这是否是分割轮次
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// 摘要生成
// ============================================================================

const SUMMARIZATION_PROMPT = `上面的消息是要摘要的对话。创建一个结构化的上下文检查点摘要，供另一个 LLM 用于继续工作。

使用此精确格式：

## Goal
[用户试图完成什么？如果会话涵盖不同的任务，可以有多个项目。]

## Constraints & Preferences
- [用户提到的任何约束、偏好或要求]
- [如果没有提到，则为 "(none)"]

## Progress
### Done
- [x] [已完成的任务/更改]

### In Progress
- [ ] [当前工作]

### Blocked
- [阻碍进度的任何问题]

## Key Decisions
- **[决策]**: [简要理由]

## Next Steps
1. [接下来的有序步骤列表]

## Critical Context
- [继续工作所需的任何数据、示例或引用]
- [如果不适用，则为 "(none)"]

保持各部分简洁。保留精确的文件路径、函数名称和错误消息。`;

const UPDATE_SUMMARIZATION_PROMPT = `上面的消息是要合并到 <previous-summary> 标签中提供的现有摘要中的新对话消息。

使用新信息更新现有的结构化摘要。规则：
- 保留先前摘要中的所有现有信息
- 添加新消息中的新进度、决策和上下文
- 更新 Progress 部分：完成时将项目从 "In Progress" 移动到 "Done"
- 根据已完成的内容更新 "Next Steps"
- 保留精确的文件路径、函数名称和错误消息
- 如果某些内容不再相关，你可以将其删除

使用此精确格式：

## Goal
[保留现有目标，如果任务扩展则添加新目标]

## Constraints & Preferences
- [保留现有的，添加新发现的]

## Progress
### Done
- [x] [包括之前完成的项目和新完成的项目]

### In Progress
- [ ] [当前工作 - 根据进度更新]

### Blocked
- [当前的阻塞项 - 如果已解决则移除]

## Key Decisions
- **[决策]**: [简要理由] (保留之前的所有内容，添加新内容)

## Next Steps
1. [根据当前状态更新]

## Critical Context
- [保留重要上下文，如果需要则添加新上下文]

保持各部分简洁。保留精确的文件路径、函数名称和错误消息。`;

/**
 * 使用 LLM 生成对话摘要。
 * 如果提供了 previousSummary，则使用更新提示词进行合并。
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
): Promise<string> {
	const maxTokens = Math.floor(0.8 * reserveTokens);

	// 如果我们有以前的摘要，则使用更新提示词，否则使用初始提示词
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// 将对话序列化为文本，以免模型尝试继续对话
	// 首先转换为 LLM 消息（处理自定义消息类型，如 bashExecution、custom 等）
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	// 构建包含包裹在标签中的对话的提示词
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ maxTokens, signal, apiKey, reasoning: "high" },
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return textContent;
}

// ============================================================================
// 压缩准备（用于扩展）
// ============================================================================

export interface CompactionPreparation {
	/** 第一个保留条目的 UUID */
	firstKeptEntryId: string;
	/** 将被摘要并丢弃的消息 */
	messagesToSummarize: AgentMessage[];
	/** 将变成轮次前缀摘要（如果分割）的消息 */
	turnPrefixMessages: AgentMessage[];
	/** 这是否是分割轮次（切割点在轮次中间） */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** 来自先前压缩的摘要，用于迭代更新 */
	previousSummary?: string;
	/** 从 messagesToSummarize 中提取的文件操作 */
	fileOps: FileOperations;
	/** 来自 settings.jsonl 的压缩设置 */
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}
	const boundaryStart = prevCompactionIndex + 1;
	const boundaryEnd = pathEntries.length;

	const usageStart = prevCompactionIndex >= 0 ? prevCompactionIndex : 0;
	const usageMessages: AgentMessage[] = [];
	for (let i = usageStart; i < boundaryEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i]);
		if (msg) usageMessages.push(msg);
	}
	const tokensBefore = estimateContextTokens(usageMessages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// 获取第一个保留条目的 UUID
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // 会话需要迁移
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// 要摘要的消息（摘要后将被丢弃）
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// 轮次前缀摘要的消息（如果分割轮次）
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntry(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// 获取先前的摘要以进行迭代更新
	let previousSummary: string | undefined;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
	}

	// 从消息和先前的压缩中提取文件操作
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// 如果分割，也从轮次前缀中提取文件操作
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// 主压缩函数
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * 使用准备好的数据生成压缩摘要。
 * 返回 CompactionResult - SessionManager 在保存时添加 uuid/parentUuid。
 *
 * @param preparation - 从 prepareCompaction() 预先计算的准备数据
 * @param customInstructions - 可选的摘要自定义重点
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string,
	customInstructions?: string,
	signal?: AbortSignal,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// 生成摘要（如果需要，可以并行进行）并合并为一个
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// 并行生成两个摘要
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						signal,
						customInstructions,
						previousSummary,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, signal),
		]);
		// 合并为单个摘要
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		// 仅生成历史摘要
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			signal,
			customInstructions,
			previousSummary,
		);
	}

	// 计算文件列表并附加到摘要
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * 为轮次前缀生成摘要（当分割轮次时）。
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	const maxTokens = Math.floor(0.5 * reserveTokens); // 轮次前缀的预算较小
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ maxTokens, signal, apiKey },
	);

	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

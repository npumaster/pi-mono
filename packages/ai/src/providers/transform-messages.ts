import type { Api, AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "../types.js";

/**
 * 标准化工具调用 ID 以实现跨提供商兼容性。
 * OpenAI Responses API 生成的 ID 超过 450 个字符，且包含 `|` 等特殊字符。
 * Anthropic API 要求 ID 匹配 ^[a-zA-Z0-9_-]+$（最多 64 个字符）。
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// 建立原始工具调用 ID 到标准化 ID 的映射
	const toolCallIdMap = new Map<string, string>();

	// 第一遍：转换消息（思考块，工具调用 ID 标准化）
	const transformed = messages.map((msg) => {
		// 用户消息保持不变
		if (msg.role === "user") {
			return msg;
		}

		// 处理 toolResult 消息 - 如果我们有映射，则标准化 toolCallId
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// 助手消息需要检查转换
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// 对于相同模型：保留带有签名的思考块（回放所需）
					// 即使思考文本为空（OpenAI 加密推理）
					if (isSameModel && block.thinkingSignature) return block;
					// 跳过空的思考块，将其他转换为纯文本
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// 第二遍：为孤立的工具调用插入合成的空工具结果
	// 这保留了思考签名并满足 API 要求
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// 如果我们有来自上一个助手的待处理孤立工具调用，现在插入合成结果
			if (pendingToolCalls.length > 0) {
				for (const tc of pendingToolCalls) {
					if (!existingToolResultIds.has(tc.id)) {
						result.push({
							role: "toolResult",
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text", text: "No result provided" }],
							isError: true,
							timestamp: Date.now(),
						} as ToolResultMessage);
					}
				}
				pendingToolCalls = [];
				existingToolResultIds = new Set();
			}

			// 完全跳过错误/中止的助手消息。
			// 这些是不完整的轮次，不应该被回放：
			// - 可能有部分内容（没有消息的推理，不完整的工具调用）
			// - 回放它们可能会导致 API 错误（例如，OpenAI "reasoning without following item"）
			// - 模型应该从最后一个有效状态重试
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// 跟踪来自此助手消息的工具调用
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// 用户消息中断工具流程 - 为孤立的调用插入合成结果
			if (pendingToolCalls.length > 0) {
				for (const tc of pendingToolCalls) {
					if (!existingToolResultIds.has(tc.id)) {
						result.push({
							role: "toolResult",
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text", text: "No result provided" }],
							isError: true,
							timestamp: Date.now(),
						} as ToolResultMessage);
					}
				}
				pendingToolCalls = [];
				existingToolResultIds = new Set();
			}
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	return result;
}

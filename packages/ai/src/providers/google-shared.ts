/**
 * Google Generative AI 和 Google Cloud Code Assist 提供商的共享实用程序。
 */

import { type Content, FinishReason, FunctionCallingConfigMode, type Part } from "@google/genai";
import type { Context, ImageContent, Model, StopReason, TextContent, Tool } from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

type GoogleApiType = "google-generative-ai" | "google-gemini-cli" | "google-vertex";

/**
 * 确定流式 Gemini `Part` 是否应被视为“思考”。
 *
 * 协议说明（Gemini / Vertex AI 思考签名）：
 * - `thought: true` 是思考内容（思考摘要）的明确标记。
 * - `thoughtSignature` 是模型内部思维过程的加密表示，
 *   用于在多轮交互中保留推理上下文。
 * - `thoughtSignature` 可以出现在任何部分类型（text、functionCall 等）上 - 它并不
 *   表示该部分本身是思考内容。
 * - 对于非 functionCall 响应，签名出现在最后一部分以便上下文回放。
 * - 当持久化/回放模型输出时，必须按原样保留带有签名的部分；
 *   不要跨部分合并/移动签名。
 *
 * 参见：https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * 在流式传输期间保留思考签名。
 *
 * 某些后端仅在给定部分/块的第一个增量上发送 `thoughtSignature`；后续增量可能会省略它。
 * 此助手保留当前块的最后一个非空签名。
 *
 * 注意：这不会跨不同的响应部分合并或移动签名。它只是防止
 * 签名在同一个流式块中被 `undefined` 覆盖。
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// 思考签名对于 Google API (TYPE_BYTES) 必须是 base64。
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * 仅保留来自相同提供商/模型且具有有效 base64 的签名。
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * 通过 Google API 的模型，需要在函数调用/响应中显式提供工具调用 ID。
 */
export function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

/**
 * 将内部消息转换为 Gemini Content[] 格式。
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				const filteredParts = !model.input.includes("image") ? parts.filter((p) => p.text !== undefined) : parts;
				if (filteredParts.length === 0) continue;
				contents.push({
					role: "user",
					parts: filteredParts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// 检查消息是否来自相同的提供商和模型 - 只有这样才保留思考块
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					// 跳过空文本块 - 它们可能会导致某些模型（例如通过 Antigravity 的 Claude）出现问题
					if (!block.text || block.text.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// 跳过空思考块
					if (!block.thinking || block.thinking.trim() === "") continue;
					// 仅当相同提供商且相同模型时保留为思考块
					// 否则转换为纯文本（无标签以避免模型模仿它们）
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					// Gemini 3 在启用思考模式时要求所有函数调用都有 thoughtSignature。
					// 当从没有思考签名的提供商（例如通过 Antigravity 的 Claude）回放历史记录时，
					// 将未签名的函数调用转换为文本以避免 API 验证错误。
					// 我们包含一个注释告诉模型这是历史上下文，以防止模仿。
					const isGemini3 = model.id.toLowerCase().includes("gemini-3");
					if (isGemini3 && !thoughtSignature) {
						const argsStr = JSON.stringify(block.arguments ?? {}, null, 2);
						parts.push({
							text: `[Historical context: a different model called tool "${block.name}" with arguments: ${argsStr}. Do not mimic this format - use proper function calling.]`,
						});
					} else {
						const part: Part = {
							functionCall: {
								name: block.name,
								args: block.arguments ?? {},
								...(requiresToolCallId(model.id) ? { id: block.id } : {}),
							},
						};
						if (thoughtSignature) {
							part.thoughtSignature = thoughtSignature;
						}
						parts.push(part);
					}
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// 提取文本和图像内容
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3 支持多模态函数响应，图像嵌套在 functionResponse.parts 中
			// 参见：https://ai.google.dev/gemini-api/docs/function-calling#multimodal
			// 旧模型不支持此功能，因此我们将图像放在单独的用户消息中。
			const supportsMultimodalFunctionResponse = model.id.includes("gemini-3");

			// 根据 SDK 文档，使用 "output" 键表示成功，"error" 键表示错误
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					// 对于 Gemini 3，将图像嵌套在 functionResponse.parts 中
					...(hasImages && supportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API 要求所有函数响应都在单个用户轮次中。
			// 检查最后一个内容是否已经是带有函数响应的用户轮次并合并。
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// 对于旧模型，将图像添加到单独的用户消息中
			if (hasImages && !supportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

/**
 * 将工具转换为 Gemini 函数声明格式。
 *
 * 默认使用 `parametersJsonSchema`，它支持完整的 JSON Schema（包括
 * anyOf, oneOf, const 等）。将 `useParameters` 设置为 true 以使用旧版 `parameters`
 * 字段（OpenAPI 3.03 Schema）。这对于使用 Claude 模型的 Cloud Code Assist 是必需的，
 * 其中 API 将 `parameters` 转换为 Anthropic 的 `input_schema`。
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				...(useParameters ? { parameters: tool.parameters } : { parametersJsonSchema: tool.parameters }),
			})),
		},
	];
}

/**
 * 将工具选择字符串映射到 Gemini FunctionCallingConfigMode。
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

/**
 * 将 Gemini FinishReason 映射到我们的 StopReason。
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * 将字符串完成原因映射到我们的 StopReason（用于原始 API 响应）。
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

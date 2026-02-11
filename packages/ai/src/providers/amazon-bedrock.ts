import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	StopReason as BedrockStopReason,
	type Tool as BedrockTool,
	CachePointType,
	CacheTTL,
	type ContentBlock,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamMetadataEvent,
	ImageFormat,
	type Message,
	type SystemContentBlock,
	type ToolChoice,
	type ToolConfiguration,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";

import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* 有关支持的模型，请参阅 https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html。 */
	reasoning?: ThinkingLevel;
	/* 每个思考级别的自定义 token 预算。覆盖默认预算。 */
	thinkingBudgets?: ThinkingBudgets;
	/* 仅 Claude 4.x 模型支持，请参阅 https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
}

type Block = (TextContent | ThinkingContent | ToolCall) & { index?: number; partialJson?: string };

export const streamBedrock: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream" as Api,
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
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const blocks = output.content as Block[];

		const config: BedrockRuntimeClientConfig = {
			region: options.region,
			profile: options.profile,
		};

		// 仅在 Node.js/Bun 环境中
		if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
			config.region = config.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

			// 支持不需要身份验证的代理
			if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") {
				config.credentials = {
					accessKeyId: "dummy-access-key",
					secretAccessKey: "dummy-secret-key",
				};
			}

			if (
				process.env.HTTP_PROXY ||
				process.env.HTTPS_PROXY ||
				process.env.NO_PROXY ||
				process.env.http_proxy ||
				process.env.https_proxy ||
				process.env.no_proxy
			) {
				const nodeHttpHandler = await import("@smithy/node-http-handler");
				const proxyAgent = await import("proxy-agent");

				const agent = new proxyAgent.ProxyAgent();

				// Bedrock 运行时自 v3.798.0 起默认使用 NodeHttp2Handler，
				// 基于 `http2` 模块，不支持 http 代理。
				// 使用 NodeHttpHandler 以支持 http 代理。
				config.requestHandler = new nodeHttpHandler.NodeHttpHandler({
					httpAgent: agent,
					httpsAgent: agent,
				});
			} else if (process.env.AWS_BEDROCK_FORCE_HTTP1 === "1") {
				// 某些自定义端点需要 HTTP/1.1 而不是 HTTP/2
				const nodeHttpHandler = await import("@smithy/node-http-handler");
				config.requestHandler = new nodeHttpHandler.NodeHttpHandler();
			}
		}

		config.region = config.region || "us-east-1";

		try {
			const client = new BedrockRuntimeClient(config);

			const cacheRetention = resolveCacheRetention(options.cacheRetention);
			const commandInput = {
				modelId: model.id,
				messages: convertMessages(context, model, cacheRetention),
				system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
				inferenceConfig: { maxTokens: options.maxTokens, temperature: options.temperature },
				toolConfig: convertToolConfig(context.tools, options.toolChoice),
				additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
			};
			options?.onPayload?.(commandInput);
			const command = new ConverseStreamCommand(commandInput);

			const response = await client.send(command, { abortSignal: options.signal });

			for await (const item of response.stream!) {
				if (item.messageStart) {
					if (item.messageStart.role !== ConversationRole.ASSISTANT) {
						throw new Error("Unexpected assistant message start but got user message start instead");
					}
					stream.push({ type: "start", partial: output });
				} else if (item.contentBlockStart) {
					handleContentBlockStart(item.contentBlockStart, blocks, output, stream);
				} else if (item.contentBlockDelta) {
					handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
				} else if (item.contentBlockStop) {
					handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
				} else if (item.messageStop) {
					output.stopReason = mapStopReason(item.messageStop.stopReason);
				} else if (item.metadata) {
					handleMetadata(item.metadata, model, output);
				} else if (item.internalServerException) {
					throw new Error(`Internal server error: ${item.internalServerException.message}`);
				} else if (item.modelStreamErrorException) {
					throw new Error(`Model stream error: ${item.modelStreamErrorException.message}`);
				} else if (item.validationException) {
					throw new Error(`Validation error: ${item.validationException.message}`);
				} else if (item.throttlingException) {
					throw new Error(`Throttling error: ${item.throttlingException.message}`);
				} else if (item.serviceUnavailableException) {
					throw new Error(`Service unavailable: ${item.serviceUnavailableException.message}`);
				}
			}

			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as Block).index;
				delete (block as Block).partialJson;
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleBedrock: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, options, undefined);
	if (!options?.reasoning) {
		return streamBedrock(model, context, { ...base, reasoning: undefined } satisfies BedrockOptions);
	}

	if (model.id.includes("anthropic.claude") || model.id.includes("anthropic/claude")) {
		if (supportsAdaptiveThinking(model.id)) {
			return streamBedrock(model, context, {
				...base,
				reasoning: options.reasoning,
				thinkingBudgets: options.thinkingBudgets,
			} satisfies BedrockOptions);
		}

		const adjusted = adjustMaxTokensForThinking(
			base.maxTokens || 0,
			model.maxTokens,
			options.reasoning,
			options.thinkingBudgets,
		);

		return streamBedrock(model, context, {
			...base,
			maxTokens: adjusted.maxTokens,
			reasoning: options.reasoning,
			thinkingBudgets: {
				...(options.thinkingBudgets || {}),
				[clampReasoning(options.reasoning)!]: adjusted.thinkingBudget,
			},
		} satisfies BedrockOptions);
	}

	return streamBedrock(model, context, {
		...base,
		reasoning: options.reasoning,
		thinkingBudgets: options.thinkingBudgets,
	} satisfies BedrockOptions);
};

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex!;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: start.toolUse.toolUseId || "",
			name: start.toolUse.name || "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex!;
	const delta = event.delta;
	let index = blocks.findIndex((b) => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// 如果尚不存在文本块，则创建一个，因为不会为文本块发送 handleContentBlockStart
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
		block.arguments = parseStreamingJson(block.partialJson);
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			if (delta.reasoningContent.signature) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
		}
	}
}

function handleMetadata(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;
	delete (block as Block).index;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block.partialJson);
			delete (block as Block).partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * 检查模型是否支持自适应思考 (Opus 4.6+)。
 */
function supportsAdaptiveThinking(modelId: string): boolean {
	return modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}

function mapThinkingLevelToEffort(level: SimpleStreamOptions["reasoning"]): "low" | "medium" | "high" | "max" {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "max";
		default:
			return "high";
	}
}

/**
 * 解析缓存保留偏好。
 * 默认为 "short"，并使用 PI_CACHE_RETENTION 进行向后兼容。
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

/**
 * 检查模型是否支持提示缓存。
 * 支持：Claude 3.5 Haiku, Claude 3.7 Sonnet, Claude 4.x models
 */
function supportsPromptCaching(model: Model<"bedrock-converse-stream">): boolean {
	if (model.cost.cacheRead || model.cost.cacheWrite) {
		return true;
	}

	const id = model.id.toLowerCase();
	// Claude 4.x models (opus-4, sonnet-4, haiku-4)
	if (id.includes("claude") && (id.includes("-4-") || id.includes("-4."))) return true;
	// Claude 3.7 Sonnet
	if (id.includes("claude-3-7-sonnet")) return true;
	// Claude 3.5 Haiku
	if (id.includes("claude-3-5-haiku")) return true;
	return false;
}

/**
 * 检查模型是否支持 reasoningContent 中的思考签名。
 * 只有 Anthropic Claude 模型支持 signature 字段。
 * 其他模型（OpenAI、Qwen、Minimax、Moonshot 等）会拒绝它：
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	return id.includes("anthropic.claude") || id.includes("anthropic/claude");
}

function buildSystemPrompt(
	systemPrompt: string | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;

	const blocks: SystemContentBlock[] = [{ text: sanitizeSurrogates(systemPrompt) }];

	// 当启用缓存时，为支持的 Claude 模型添加缓存点
	if (cacheRetention !== "none" && supportsPromptCaching(model)) {
		blocks.push({
			cachePoint: { type: CachePointType.DEFAULT, ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) },
		});
	}

	return blocks;
}

function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): Message[] {
	const result: Message[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "user":
				result.push({
					role: ConversationRole.USER,
					content:
						typeof m.content === "string"
							? [{ text: sanitizeSurrogates(m.content) }]
							: m.content.map((c) => {
									switch (c.type) {
										case "text":
											return { text: sanitizeSurrogates(c.text) };
										case "image":
											return { image: createImageBlock(c.mimeType, c.data) };
										default:
											throw new Error("Unknown user content type");
									}
								}),
				});
				break;
			case "assistant": {
				// Skip assistant messages with empty content (e.g., from aborted requests)
				// Bedrock rejects messages with empty content arrays
				if (m.content.length === 0) {
					continue;
				}
				const contentBlocks: ContentBlock[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text":
							// Skip empty text blocks
							if (c.text.trim().length === 0) continue;
							contentBlocks.push({ text: sanitizeSurrogates(c.text) });
							break;
						case "toolCall":
							contentBlocks.push({
								toolUse: { toolUseId: c.id, name: c.name, input: c.arguments },
							});
							break;
						case "thinking":
							// Skip empty thinking blocks
							if (c.thinking.trim().length === 0) continue;
							// Only Anthropic models support the signature field in reasoningText.
							// For other models, we omit the signature to avoid errors like:
							// "This model doesn't support the reasoningContent.reasoningText.signature field"
							if (supportsThinkingSignature(model)) {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: sanitizeSurrogates(c.thinking), signature: c.thinkingSignature },
									},
								});
							} else {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: sanitizeSurrogates(c.thinking) },
									},
								});
							}
							break;
						default:
							throw new Error("Unknown assistant content type");
					}
				}
				// Skip if all content blocks were filtered out
				if (contentBlocks.length === 0) {
					continue;
				}
				result.push({
					role: ConversationRole.ASSISTANT,
					content: contentBlocks,
				});
				break;
			}
			case "toolResult": {
				// Collect all consecutive toolResult messages into a single user message
				// Bedrock requires all tool results to be in one message
				const toolResults: ContentBlock.ToolResultMember[] = [];

				// Add current tool result with all content blocks combined
				toolResults.push({
					toolResult: {
						toolUseId: m.toolCallId,
						content: m.content.map((c) =>
							c.type === "image"
								? { image: createImageBlock(c.mimeType, c.data) }
								: { text: sanitizeSurrogates(c.text) },
						),
						status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
					},
				});

				// Look ahead for consecutive toolResult messages
				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: nextMsg.toolCallId,
							content: nextMsg.content.map((c) =>
								c.type === "image"
									? { image: createImageBlock(c.mimeType, c.data) }
									: { text: sanitizeSurrogates(c.text) },
							),
							status: nextMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					j++;
				}

				// Skip the messages we've already processed
				i = j - 1;

				result.push({
					role: ConversationRole.USER,
					content: toolResults,
				});
				break;
			}
			default:
				throw new Error("Unknown message role");
		}
	}

	// Add cache point to the last user message for supported Claude models when caching is enabled
	if (cacheRetention !== "none" && supportsPromptCaching(model) && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
			(lastMessage.content as ContentBlock[]).push({
				cachePoint: {
					type: CachePointType.DEFAULT,
					...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
				},
			});
		}
	}

	return result;
}

function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
): ToolConfiguration | undefined {
	if (!tools?.length || toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = tools.map((tool) => ({
		toolSpec: {
			name: tool.name,
			description: tool.description,
			inputSchema: { json: tool.parameters },
		},
	}));

	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return "stop";
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return "length";
		case BedrockStopReason.TOOL_USE:
			return "toolUse";
		default:
			return "error";
	}
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, any> | undefined {
	if (!options.reasoning || !model.reasoning) {
		return undefined;
	}

	if (model.id.includes("anthropic.claude")) {
		const result: Record<string, any> = supportsAdaptiveThinking(model.id)
			? {
					thinking: { type: "adaptive" },
					output_config: { effort: mapThinkingLevelToEffort(options.reasoning) },
				}
			: (() => {
					const defaultBudgets: Record<ThinkingLevel, number> = {
						minimal: 1024,
						low: 2048,
						medium: 8192,
						high: 16384,
						xhigh: 16384, // Claude doesn't support xhigh, clamp to high
					};

					// 自定义预算覆盖默认值（xhigh 不在 ThinkingBudgets 中，使用 high）
					const level = options.reasoning === "xhigh" ? "high" : options.reasoning;
					const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

					return {
						thinking: {
							type: "enabled",
							budget_tokens: budget,
						},
					};
				})();

		if (options.interleavedThinking && !supportsAdaptiveThinking(model.id)) {
			result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
		}

		return result;
	}

	return undefined;
}

function createImageBlock(mimeType: string, data: string) {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}

	return { source: { bytes }, format };
}

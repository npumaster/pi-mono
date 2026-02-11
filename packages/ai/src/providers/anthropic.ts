import Anthropic from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";

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

function getCacheControl(
	baseUrl: string,
	cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: { type: "ephemeral"; ttl?: "1h" } } {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && baseUrl.includes("api.anthropic.com") ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// 隐身模式：完全模仿 Claude Code 的工具命名
const claudeCodeVersion = "2.1.2";

// Claude Code 2.x 工具名称（规范大小写）
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * 将内容块转换为 Anthropic API 格式
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// 如果只有文本块，为简单起见返回拼接字符串
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// 如果有图像，转换为内容块数组
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// 如果只有图像（没有文本），添加占位符文本块
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "max";

export interface AnthropicOptions extends StreamOptions {
	/**
	 * 启用扩展思考。
	 * 对于 Opus 4.6+：使用自适应思考（Claude 决定何时/思考多少）。
	 * 对于旧模型：使用基于预算的思考，配合 thinkingBudgetTokens。
	 */
	thinkingEnabled?: boolean;
	/**
	 * 扩展思考的 token 预算（仅限旧模型）。
	 * 对于使用自适应思考的 Opus 4.6+ 忽略此项。
	 */
	thinkingBudgetTokens?: number;
	/**
	 * 自适应思考的努力级别（仅限 Opus 4.6+）。
	 * 控制 Claude 分配多少思考：
	 * - "max": 总是无限制地思考
	 * - "high": 总是思考，深度推理（默认）
	 * - "medium": 适度思考，对于简单查询可能会跳过
	 * - "low": 极少思考，对于简单任务会跳过
	 * 对于旧模型忽略此项。
	 */
	effort?: AnthropicEffort;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
}

function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
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

		try {
			const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
			const { client, isOAuthToken } = createClient(
				model,
				apiKey,
				options?.interleavedThinking ?? true,
				options?.headers,
			);
			const params = buildParams(model, context, isOAuthToken, options);
			options?.onPayload?.(params);
			const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of anthropicStream) {
				if (event.type === "message_start") {
					// 从 message_start 事件捕获初始 token 使用情况
					// 这确保即使流提前中止，我们也有输入 token 计数
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					// Anthropic 不提供 total_tokens，从组件计算
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuthToken
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						delete (block as any).index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialJson);
							delete (block as any).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					if (event.delta.stop_reason) {
						output.stopReason = mapStopReason(event.delta.stop_reason);
					}
					// Only update usage fields if present (not null).
					// Preserves input_tokens from message_start when proxies omit it in message_delta.
					if (event.usage.input_tokens != null) {
						output.usage.input = event.usage.input_tokens;
					}
					if (event.usage.output_tokens != null) {
						output.usage.output = event.usage.output_tokens;
					}
					if (event.usage.cache_read_input_tokens != null) {
						output.usage.cacheRead = event.usage.cache_read_input_tokens;
					}
					if (event.usage.cache_creation_input_tokens != null) {
						output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
					}
					// Anthropic 不提供 total_tokens，从组件计算
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * 检查模型是否支持自适应思考 (Opus 4.6+)
 */
function supportsAdaptiveThinking(modelId: string): boolean {
	// Opus 4.6 model IDs (with or without date suffix)
	return modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}

/**
 * 将 ThinkingLevel 映射到自适应思考的 Anthropic 努力级别
 */
function mapThinkingLevelToEffort(level: SimpleStreamOptions["reasoning"]): AnthropicEffort {
	switch (level) {
		case "minimal":
			return "low";
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

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamAnthropic(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
	}

	// 对于 Opus 4.6+：使用带有努力级别的自适应思考
	// 对于旧模型：使用基于预算的思考
	if (supportsAdaptiveThinking(model.id)) {
		const effort = mapThinkingLevelToEffort(options.reasoning);
		return streamAnthropic(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens || 0,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropic(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	interleavedThinking: boolean,
	optionsHeaders?: Record<string, string>,
): { client: Anthropic; isOAuthToken: boolean } {
	const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
	if (interleavedThinking) {
		betaFeatures.push("interleaved-thinking-2025-05-14");
	}

	const oauthToken = isOAuthToken(apiKey);
	if (oauthToken) {
		// Stealth mode: Mimic Claude Code's headers exactly
		const defaultHeaders = mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				"anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
				"user-agent": `claude-cli/${claudeCodeVersion} (external, cli)`,
				"x-app": "cli",
			},
			model.headers,
			optionsHeaders,
		);

		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			defaultHeaders,
			dangerouslyAllowBrowser: true,
		});

		return { client, isOAuthToken: true };
	}

	const defaultHeaders = mergeHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-beta": betaFeatures.join(","),
		},
		model.headers,
		optionsHeaders,
	);

	const client = new Anthropic({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});

	return { client, isOAuthToken: false };
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model.baseUrl, options?.cacheRetention);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model, isOAuthToken, cacheControl),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};

	// 对于 OAuth 令牌，我们必须包含 Claude Code 身份
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		// 为非 OAuth 令牌向系统提示添加缓存控制
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools, isOAuthToken);
	}

	// 配置思考模式：自适应 (Opus 4.6+) 或基于预算 (旧模型)
	if (options?.thinkingEnabled && model.reasoning) {
		if (supportsAdaptiveThinking(model.id)) {
			// 自适应思考：Claude 决定何时以及思考多少
			params.thinking = { type: "adaptive" };
			if (options.effort) {
				params.output_config = { effort: options.effort };
			}
		} else {
			// 旧模型的基于预算的思考
			params.thinking = {
				type: "enabled",
				budget_tokens: options.thinkingBudgetTokens || 1024,
			};
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	return params;
}

// 标准化工具调用 ID 以匹配 Anthropic 要求的模式和长度
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	cacheControl?: { type: "ephemeral"; ttl?: "1h" },
): MessageParam[] {
	const params: MessageParam[] = [];

	// 转换消息以实现跨提供商兼容性
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				let filteredBlocks = !model?.input.includes("image") ? blocks.filter((b) => b.type !== "image") : blocks;
				filteredBlocks = filteredBlocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					if (block.thinking.trim().length === 0) continue;
					// 如果思考签名缺失/为空（例如，来自中止的流），
					// 转换为不带 <thinking> 标签的纯文本块，以避免 API 拒绝
					// 并防止 Claude 在响应中模仿这些标签
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push({
							type: "text",
							text: sanitizeSurrogates(block.thinking),
						});
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function convertTools(tools: Tool[], isOAuthToken: boolean): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool) => {
		const jsonSchema = tool.parameters as any; // TypeBox already generates JSON Schema

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			input_schema: {
				type: "object" as const,
				properties: jsonSchema.properties || {},
				required: jsonSchema.required || [],
			},
		};
	});
}

function mapStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop 已经足够好 -> 重新提交
			return "stop";
		case "stop_sequence":
			return "stop"; // 我们不提供停止序列，所以这应该永远不会发生
		case "sensitive": // 内容被安全过滤器标记（尚未在 SDK 类型中）
			return "error";
		default:
			// 优雅地处理未知的停止原因（API 可能会添加新值）
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}

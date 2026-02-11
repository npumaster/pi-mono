/**
 * 扩展的工具包装器。
 */

import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionRunner } from "./runner.js";
import type { RegisteredTool, ToolCallEventResult } from "./types.js";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const { definition } = registeredTool;
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, runner.createContext()),
	};
}

/**
 * 将所有已注册的工具包装为 AgentTool。
 * 使用 runner 的 createContext() 在工具和事件处理程序之间保持上下文一致。
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((rt) => wrapRegisteredTool(rt, runner));
}

/**
 * Wrap a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
export function wrapToolWithExtensions<T>(tool: AgentTool<any, T>, runner: ExtensionRunner): AgentTool<any, T> {
	return {
		...tool,
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<T>,
		) => {
			// 发出 tool_call 事件 - 扩展可以阻止执行
			if (runner.hasHandlers("tool_call")) {
				try {
					const callResult = (await runner.emitToolCall({
						type: "tool_call",
						toolName: tool.name,
						toolCallId,
						input: params,
					})) as ToolCallEventResult | undefined;

					if (callResult?.block) {
						const reason = callResult.reason || "Tool execution was blocked by an extension";
						throw new Error(reason);
					}
				} catch (err) {
					if (err instanceof Error) {
						throw err;
					}
					throw new Error(`Extension failed, blocking execution: ${String(err)}`);
				}
			}

			// Execute the actual tool
			try {
				const result = await tool.execute(toolCallId, params, signal, onUpdate);

				// Emit tool_result event - extensions can modify the result
				if (runner.hasHandlers("tool_result")) {
					const resultResult = await runner.emitToolResult({
						type: "tool_result",
						toolName: tool.name,
						toolCallId,
						input: params,
						content: result.content,
						details: result.details,
						isError: false,
					});

					if (resultResult) {
						return {
							content: resultResult.content ?? result.content,
							details: (resultResult.details ?? result.details) as T,
						};
					}
				}

				return result;
			} catch (err) {
				// Emit tool_result event for errors
				if (runner.hasHandlers("tool_result")) {
					await runner.emitToolResult({
						type: "tool_result",
						toolName: tool.name,
						toolCallId,
						input: params,
						content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
						details: undefined,
						isError: true,
					});
				}
				throw err;
			}
		},
	};
}

/**
 * 使用扩展回调包装所有工具。
 */
export function wrapToolsWithExtensions<T>(tools: AgentTool<any, T>[], runner: ExtensionRunner): AgentTool<any, T>[] {
	return tools.map((tool) => wrapToolWithExtensions(tool, runner));
}

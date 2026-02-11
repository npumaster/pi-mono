/**
 * 打印模式（单次）：发送提示，输出结果，退出。
 *
 * 用于：
 * - `pi -p "prompt"` - 文本输出
 * - `pi --mode json "prompt"` - JSON 事件流
 */

import type { AssistantMessage, ImageContent } from "@mariozechner/pi-ai";
import type { AgentSession } from "../core/agent-session.js";

/**
 * 打印模式的选项。
 */
export interface PrintModeOptions {
	/** 输出模式："text" 仅用于最终响应，"json" 用于所有事件 */
	mode: "text" | "json";
	/** initialMessage 之后要发送的额外提示数组 */
	messages?: string[];
	/** 要发送的第一条消息（可能包含 @file 内容） */
	initialMessage?: string;
	/** 附加到初始消息的图像 */
	initialImages?: ImageContent[];
}

/**
 * 在打印（单次）模式下运行。
 * 向 agent 发送提示并输出结果。
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			console.log(JSON.stringify(header));
		}
	}
	// 为打印模式设置扩展（无 UI）
	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (options) => {
				const success = await session.newSession({ parentSession: options?.parentSession });
				if (success && options?.setup) {
					await options.setup(session.sessionManager);
				}
				return { cancelled: !success };
			},
			fork: async (entryId) => {
				const result = await session.fork(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await session.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath) => {
				const success = await session.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await session.reload();
			},
		},
		onError: (err) => {
			console.error(`Extension error (${err.extensionPath}): ${err.error}`);
		},
	});

	// 始终订阅以通过 _handleAgentEvent 启用会话持久性
	session.subscribe((event) => {
		// 在 JSON 模式下，输出所有事件
		if (mode === "json") {
			console.log(JSON.stringify(event));
		}
	});

	// 发送带有附件的初始消息
	if (initialMessage) {
		await session.prompt(initialMessage, { images: initialImages });
	}

	// 发送剩余消息
	for (const message of messages) {
		await session.prompt(message);
	}

	// 在文本模式下，输出最终响应
	if (mode === "text") {
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;

			// 检查错误/中止
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				process.exit(1);
			}

			// 输出文本内容
			for (const content of assistantMsg.content) {
				if (content.type === "text") {
					console.log(content.text);
				}
			}
		}
	}

	// 确保 stdout 在返回之前完全刷新
	// 这可以防止进程在所有输出写入之前退出的竞争条件
	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

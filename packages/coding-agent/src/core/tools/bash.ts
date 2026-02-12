import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { getShellConfig, getShellEnv, killProcessTree } from "../../utils/shell.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * 为 bash 输出生成唯一的临时文件路径
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-bash-${id}.log`);
}

const bashSchema = Type.Object({
	command: Type.String({ description: "要执行的 bash 命令" }),
	timeout: Type.Optional(Type.Number({ description: "以秒为单位的超时时间（可选，无默认超时）" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * bash 工具的可插拔操作。
 * 覆盖这些以将命令执行委托给远程系统（例如 SSH）。
 */
export interface BashOperations {
	/**
	 * 执行命令并流式传输输出。
	 * @param command - 要执行的命令
	 * @param cwd - 工作目录
	 * @param options - 执行选项
	 * @returns Promise 解析为退出代码（如果被终止则为 null）
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * 使用本地 shell 的默认 bash 操作
 */
const defaultBashOperations: BashOperations = {
	exec: (command, cwd, { onData, signal, timeout, env }) => {
		return new Promise((resolve, reject) => {
			const { shell, args } = getShellConfig();

			if (!existsSync(cwd)) {
				reject(new Error(`工作目录不存在：${cwd}\n无法执行 bash 命令。`));
				return;
			}

			const child = spawn(shell, [...args, command], {
				cwd,
				detached: true,
				env: env ?? getShellEnv(),
				stdio: ["ignore", "pipe", "pipe"],
			});

			let timedOut = false;

			// 如果提供了超时，则设置超时
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					if (child.pid) {
						killProcessTree(child.pid);
					}
				}, timeout * 1000);
			}

			// 流式传输 stdout 和 stderr
			if (child.stdout) {
				child.stdout.on("data", onData);
			}
			if (child.stderr) {
				child.stderr.on("data", onData);
			}

			// 处理 shell spawn 错误
			child.on("error", (err) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
				reject(err);
			});

			// 处理中止信号 - 杀死整个进程树
			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			if (signal) {
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			// 处理进程退出
			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);

				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}

				if (timedOut) {
					reject(new Error(`timeout:${timeout}`));
					return;
				}

				resolve({ exitCode: code });
			});
		});
	},
};

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = {
		command,
		cwd,
		env: { ...getShellEnv() },
	};

	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** 命令执行的自定义操作。默认：本地 shell */
	operations?: BashOperations;
	/** 在每个命令之前附加的命令前缀（例如，别名支持的 "shopt -s expand_aliases"） */
	commandPrefix?: string;
	/** 执行前调整命令、cwd 或 env 的钩子 */
	spawnHook?: BashSpawnHook;
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const ops = options?.operations ?? defaultBashOperations;
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;

	return {
		name: "bash",
		label: "bash",
		description: `在当前工作目录中执行 bash 命令。返回 stdout 和 stderr。输出被截断为最后 ${DEFAULT_MAX_LINES} 行或 ${DEFAULT_MAX_BYTES / 1024}KB（以先达到者为准）。如果被截断，完整输出将保存到临时文件。可选择提供以秒为单位的超时。`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
		) => {
			// 如果配置了命令前缀，则应用它（例如，用于别名支持的 "shopt -s expand_aliases"）
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);

			return new Promise((resolve, reject) => {
				// 如果输出变大，我们将流式传输到临时文件
				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				let totalBytes = 0;

				// 保留最后一块的滚动缓冲区用于尾部截断
				const chunks: Buffer[] = [];
				let chunksBytes = 0;
				// 保留超过我们需要的内容，以便我们有足够的内容进行截断
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

				const handleData = (data: Buffer) => {
					totalBytes += data.length;

					// 一旦超过阈值，就开始写入临时文件
					if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
						tempFilePath = getTempFilePath();
						tempFileStream = createWriteStream(tempFilePath);
						// 将所有缓冲的块写入文件
						for (const chunk of chunks) {
							tempFileStream.write(chunk);
						}
					}

					// 如果有临时文件，则写入临时文件
					if (tempFileStream) {
						tempFileStream.write(data);
					}

					// 保留最近数据的滚动缓冲区
					chunks.push(data);
					chunksBytes += data.length;

					// 如果缓冲区太大，则修剪旧块
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift()!;
						chunksBytes -= removed.length;
					}

					// 将部分输出流式传输到回调（截断的滚动缓冲区）
					if (onUpdate) {
						const fullBuffer = Buffer.concat(chunks);
						const fullText = fullBuffer.toString("utf-8");
						const truncation = truncateTail(fullText);
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: tempFilePath,
							},
						});
					}
				};

				ops.exec(spawnContext.command, spawnContext.cwd, {
					onData: handleData,
					signal,
					timeout,
					env: spawnContext.env,
				})
					.then(({ exitCode }) => {
						// 关闭临时文件流
						if (tempFileStream) {
							tempFileStream.end();
						}

						// 合并所有缓冲的块
						const fullBuffer = Buffer.concat(chunks);
						const fullOutput = fullBuffer.toString("utf-8");

						// 应用尾部截断
						const truncation = truncateTail(fullOutput);
						let outputText = truncation.content || "(无输出)";

						// 构建包含截断信息的详情
						let details: BashToolDetails | undefined;

						if (truncation.truncated) {
							details = {
								truncation,
								fullOutputPath: tempFilePath,
							};

							// 构建可操作的通知
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;

							if (truncation.lastLinePartial) {
								// 边缘情况：最后一行本身 > 30KB
								const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
								outputText += `\n\n[显示第 ${endLine} 行的最后 ${formatSize(truncation.outputBytes)}（该行大小为 ${lastLineSize}）。完整输出：${tempFilePath}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[显示 ${truncation.totalLines} 行中的第 ${startLine}-${endLine} 行。完整输出：${tempFilePath}]`;
							} else {
								outputText += `\n\n[显示 ${truncation.totalLines} 行中的第 ${startLine}-${endLine} 行（限制为 ${formatSize(DEFAULT_MAX_BYTES)}）。完整输出：${tempFilePath}]`;
							}
						}

						if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\n命令退出，代码为 ${exitCode}`;
							reject(new Error(outputText));
						} else {
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch((err: Error) => {
						// 关闭临时文件流
						if (tempFileStream) {
							tempFileStream.end();
						}

						// 合并所有缓冲的块以输出错误
						const fullBuffer = Buffer.concat(chunks);
						let output = fullBuffer.toString("utf-8");

						if (err.message === "aborted") {
							if (output) output += "\n\n";
							output += "命令已中止";
							reject(new Error(output));
						} else if (err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							if (output) output += "\n\n";
							output += `命令在 ${timeoutSecs} 秒后超时`;
							reject(new Error(output));
						} else {
							reject(err);
						}
					});
			});
		},
	};
}

/** 使用 process.cwd() 的默认 bash 工具 - 为了向后兼容 */
export const bashTool = createBashTool(process.cwd());

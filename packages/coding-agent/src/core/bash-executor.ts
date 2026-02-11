/**
 * 具有流式传输支持和取消功能的 Bash 命令执行。
 *
 * 此模块提供统一的 bash 执行实现，用于：
 * - 交互式和 RPC 模式下的 AgentSession.executeBash()
 * - 需要 bash 执行的模式的直接调用
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess, spawn } from "child_process";
import stripAnsi from "strip-ansi";
import { getShellConfig, getShellEnv, killProcessTree, sanitizeBinaryOutput } from "../utils/shell.js";
import type { BashOperations } from "./tools/bash.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** 流式输出块的回调（已清理） */
	onChunk?: (chunk: string) => void;
	/** 用于取消的 AbortSignal */
	signal?: AbortSignal;
}

export interface BashResult {
	/** 组合的 stdout + stderr 输出（已清理，可能已截断） */
	output: string;
	/** 进程退出代码（如果被终止/取消则为 undefined） */
	exitCode: number | undefined;
	/** 命令是否通过信号被取消 */
	cancelled: boolean;
	/** 输出是否被截断 */
	truncated: boolean;
	/** 包含完整输出的临时文件路径（如果输出超过截断阈值） */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * 执行带有可选流式传输和取消支持的 bash 命令。
 *
 * 功能：
 * - 通过 onChunk 回调流式传输已清理的输出
 * - 将大量输出写入临时文件以供稍后检索
 * - 支持通过 AbortSignal 取消
 * - 清理输出（去除 ANSI，移除二进制垃圾，标准化换行符）
 * - 如果超过默认最大字节数，则截断输出
 *
 * @param command - 要执行的 bash 命令
 * @param options - 可选的流式传输回调和中止信号
 * @returns 解析为执行结果的 Promise
 */
export function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	return new Promise((resolve, reject) => {
		const { shell, args } = getShellConfig();
		const child: ChildProcess = spawn(shell, [...args, command], {
			detached: true,
			env: getShellEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});

		// 跟踪已清理的输出以进行截断
		const outputChunks: string[] = [];
		let outputBytes = 0;
		const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

		// 用于大量输出的临时文件
		let tempFilePath: string | undefined;
		let tempFileStream: WriteStream | undefined;
		let totalBytes = 0;

		// 处理中止信号
		const abortHandler = () => {
			if (child.pid) {
				killProcessTree(child.pid);
			}
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				// 已中止，甚至不要开始
				child.kill();
				resolve({
					output: "",
					exitCode: undefined,
					cancelled: true,
					truncated: false,
				});
				return;
			}
			options.signal.addEventListener("abort", abortHandler, { once: true });
		}

		const decoder = new TextDecoder();

		const handleData = (data: Buffer) => {
			totalBytes += data.length;

			// 来源处清理一次：去除 ANSI，替换二进制垃圾，标准化换行符
			const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

			// 如果超过阈值，开始写入临时文件
			if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
				const id = randomBytes(8).toString("hex");
				tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
				tempFileStream = createWriteStream(tempFilePath);
				// 将已缓冲的块写入临时文件
				for (const chunk of outputChunks) {
					tempFileStream.write(chunk);
				}
			}

			if (tempFileStream) {
				tempFileStream.write(text);
			}

			// 保持已清理文本的滚动缓冲区
			outputChunks.push(text);
			outputBytes += text.length;
			while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
				const removed = outputChunks.shift()!;
				outputBytes -= removed.length;
			}

			// 如果提供，流式传输到回调
			if (options?.onChunk) {
				options.onChunk(text);
			}
		};

		child.stdout?.on("data", handleData);
		child.stderr?.on("data", handleData);

		child.on("close", (code) => {
			// 清理中止监听器
			if (options?.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}

			if (tempFileStream) {
				tempFileStream.end();
			}

			// 组合缓冲块以进行截断（已清理）
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);

			// code === null 表示被终止（已取消）
			const cancelled = code === null;

			resolve({
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: cancelled ? undefined : code,
				cancelled,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			});
		});

		child.on("error", (err) => {
			// 清理中止监听器
			if (options?.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}

			if (tempFileStream) {
				tempFileStream.end();
			}

			reject(err);
		});
	});
}

/**
 * 使用自定义 BashOperations 执行 bash 命令。
 * 用于远程执行（SSH、容器等）。
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// 清理：去除 ANSI，替换二进制垃圾，标准化换行符
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// 如果超过阈值，开始写入临时文件
		if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
			const id = randomBytes(8).toString("hex");
			tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
			tempFileStream = createWriteStream(tempFilePath);
			for (const chunk of outputChunks) {
				tempFileStream.write(chunk);
			}
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// 保持滚动缓冲区
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// 流式传输到回调
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		if (tempFileStream) {
			tempFileStream.end();
		}

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		if (tempFileStream) {
			tempFileStream.end();
		}

		// 检查是否为中止
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		throw err;
	}
}

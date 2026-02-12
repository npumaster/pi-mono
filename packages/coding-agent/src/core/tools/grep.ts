import { createInterface } from "node:readline";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { readFileSync, statSync } from "fs";
import path from "path";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.js";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "搜索模式（正则或字面字符串）" }),
	path: Type.Optional(Type.String({ description: "要搜索的目录或文件（默认值：当前目录）" })),
	glob: Type.Optional(Type.String({ description: "按 glob 模式过滤文件，例如 '*.ts' 或 '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "区分大小写的搜索（默认值：false）" })),
	literal: Type.Optional(
		Type.Boolean({ description: "将模式视为字面字符串而非正则表达式（默认值：false）" }),
	),
	context: Type.Optional(
		Type.Number({ description: "在每个匹配项前后显示的行数（默认值：0）" }),
	),
	limit: Type.Optional(Type.Number({ description: "要返回的最大匹配数（默认值：100）" })),
});

export type GrepToolInput = Static<typeof grepSchema>;

const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/**
 * Grep 工具的可插拔操作。
 * 覆盖这些操作以将搜索委托给远程系统（例如 SSH）。
 */
export interface GrepOperations {
	/** 检查路径是否为目录。如果路径不存在则抛出异常。 */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** 为上下文行读取文件内容 */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: (p) => statSync(p).isDirectory(),
	readFile: (p) => readFileSync(p, "utf-8"),
};

export interface GrepToolOptions {
	/** 用于 grep 的自定义操作。默认值：本地文件系统 + ripgrep */
	operations?: GrepOperations;
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	const customOps = options?.operations;

	return {
		name: "grep",
		label: "grep",
		description: `在文件内容中搜索模式。返回带有文件路径和行号的匹配行。遵循 .gitignore。输出被截断为 ${DEFAULT_LIMIT} 个匹配项或 ${DEFAULT_MAX_BYTES / 1024}KB（以先达到者为准）。长行被截断为 ${GREP_MAX_LINE_LENGTH} 个字符。`,
		parameters: grepSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
		) => {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("操作已中止"));
					return;
				}

				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg", true);
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) 不可用且无法下载")));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;

						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch (_err) {
							settle(() => reject(new Error(`找不到路径：${searchPath}`)));
							return;
						}
						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];

						if (ignoreCase) {
							args.push("--ignore-case");
						}

						if (literal) {
							args.push("--fixed-strings");
						}

						if (glob) {
							args.push("--glob", glob);
						}

						args.push(pattern, searchPath);

						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};

						const stopChild = (dueToLimit: boolean = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};

						const onAbort = () => {
							aborted = true;
							stopChild();
						};

						signal?.addEventListener("abort", onAbort, { once: true });

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) {
								return [`${relativePath}:${lineNumber}: (无法读取文件)`];
							}

							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;

							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;

								// 截断长行
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) {
									linesTruncated = true;
								}

								if (isMatchLine) {
									block.push(`${relativePath}:${current}: ${truncatedText}`);
								} else {
									block.push(`${relativePath}-${current}- ${truncatedText}`);
								}
							}

							return block;
						};

						// 在流式传输期间收集匹配项，之后进行格式化
						const matches: Array<{ filePath: string; lineNumber: number }> = [];

						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) {
								return;
							}

							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}

							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;

								if (filePath && typeof lineNumber === "number") {
									matches.push({ filePath, lineNumber });
								}

								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`运行 ripgrep 失败：${error.message}`)));
						});

						child.on("close", async (code) => {
							cleanup();

							if (aborted) {
								settle(() => reject(new Error("操作已中止")));
								return;
							}

							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep 以代码 ${code} 退出`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}

							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "未找到匹配项" }], details: undefined }),
								);
								return;
							}

							// 格式化匹配项（异步以支持远程文件读取）
							for (const match of matches) {
								const block = await formatBlock(match.filePath, match.lineNumber);
								outputLines.push(...block);
							}

							// 应用字节截断（由于我们已经有了匹配限制，因此没有行限制）
							const rawOutput = outputLines.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

							let output = truncation.content;
							const details: GrepToolDetails = {};

							// 构建通知
							const notices: string[] = [];

							if (matchLimitReached) {
								notices.push(
									`已达到 ${effectiveLimit} 个匹配项的限制。使用 limit=${effectiveLimit * 2} 获取更多，或优化模式`,
								);
								details.matchLimitReached = effectiveLimit;
							}

							if (truncation.truncated) {
								notices.push(`已达到 ${formatSize(DEFAULT_MAX_BYTES)} 的限制`);
								details.truncation = truncation;
							}

							if (linesTruncated) {
								notices.push(
									`某些行已截断为 ${GREP_MAX_LINE_LENGTH} 个字符。使用 read 工具查看完整行`,
								);
								details.linesTruncated = true;
							}

							if (notices.length > 0) {
								output += `\n\n[${notices.join(". ")}]`;
							}

							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
	};
}

/** 使用 process.cwd() 的默认 grep 工具 - 为了向后兼容 */
export const grepTool = createGrepTool(process.cwd());

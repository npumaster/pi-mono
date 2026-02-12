import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { existsSync, readdirSync, statSync } from "fs";
import nodePath from "path";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "要列出的目录（默认：当前目录）" })),
	limit: Type.Optional(Type.Number({ description: "返回的最大条目数（默认：500）" })),
});

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

/**
 * ls 工具的可插拔操作。
 * 覆盖这些以将目录列表委托给远程系统（例如 SSH）。
 */
export interface LsOperations {
	/** 检查路径是否存在 */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** 获取文件/目录统计信息。如果未找到则抛出异常。 */
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** 读取目录条目 */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
	exists: existsSync,
	stat: statSync,
	readdir: readdirSync,
};

export interface LsToolOptions {
	/** 目录列表的自定义操作。默认：本地文件系统 */
	operations?: LsOperations;
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	const ops = options?.operations ?? defaultLsOperations;

	return {
		name: "ls",
		label: "ls",
		description: `列出目录内容。按字母顺序排序返回条目，目录带有 '/' 后缀。包括点文件。输出被截断为 ${DEFAULT_LIMIT} 个条目或 ${DEFAULT_MAX_BYTES / 1024}KB（以先达到者为准）。`,
		parameters: lsSchema,
		execute: async (
			_toolCallId: string,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
		) => {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("操作已中止"));
					return;
				}

				const onAbort = () => reject(new Error("操作已中止"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const dirPath = resolveToCwd(path || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;

						// 检查路径是否存在
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`找不到路径：${dirPath}`));
							return;
						}

						// 检查路径是否为目录
						const stat = await ops.stat(dirPath);
						if (!stat.isDirectory()) {
							reject(new Error(`不是目录：${dirPath}`));
							return;
						}

						// 读取目录条目
						let entries: string[];
						try {
							entries = await ops.readdir(dirPath);
						} catch (e: any) {
							reject(new Error(`无法读取目录：${e.message}`));
							return;
						}

						// 按字母顺序排序（不区分大小写）
						entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

						// 格式化带有目录指示符的条目
						const results: string[] = [];
						let entryLimitReached = false;

						for (const entry of entries) {
							if (results.length >= effectiveLimit) {
								entryLimitReached = true;
								break;
							}

							const fullPath = nodePath.join(dirPath, entry);
							let suffix = "";

							try {
								const entryStat = await ops.stat(fullPath);
								if (entryStat.isDirectory()) {
									suffix = "/";
								}
							} catch {
								// 跳过无法获取状态的条目
								continue;
							}

							results.push(entry + suffix);
						}

						signal?.removeEventListener("abort", onAbort);

						if (results.length === 0) {
							resolve({ content: [{ type: "text", text: "(空目录)" }], details: undefined });
							return;
						}

						// 应用字节截断（因为已经有条目限制，所以没有行数限制）
						const rawOutput = results.join("\n");
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

						let output = truncation.content;
						const details: LsToolDetails = {};

						// 构建通知
						const notices: string[] = [];

						if (entryLimitReached) {
							notices.push(`已达到 ${effectiveLimit} 个条目的限制。使用 limit=${effectiveLimit * 2} 获取更多`);
							details.entryLimitReached = effectiveLimit;
						}

						if (truncation.truncated) {
							notices.push(`已达到 ${formatSize(DEFAULT_MAX_BYTES)} 的限制`);
							details.truncation = truncation;
						}

						if (notices.length > 0) {
							output += `\n\n[${notices.join("。")}]`;
						}

						resolve({
							content: [{ type: "text", text: output }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
	};
}

/** 使用 process.cwd() 的默认 ls 工具 - 为了向后兼容 */
export const lsTool = createLsTool(process.cwd());

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { globSync } from "glob";
import path from "path";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const findSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "要在其中搜索的目录。如果未指定，将使用当前工作目录。请勿输入 \"undefined\" 或 \"null\" - 默认行为只需省略它。如果提供，必须是有效的绝对目录路径。" })),
	pattern: Type.String({ description: "匹配文件的 Glob 模式，例如 '*.ts'、'**/*.json' 或 'src/**/*.spec.ts'" }),
	limit: Type.Optional(Type.Number({ description: "最大结果数（默认：1000）" })),
}, { description: "一个快速的文件模式匹配工具，适用于任何代码库大小。支持像 '/*.js' 或 'src/**/*.ts' 这样的 glob 模式。返回相对于搜索目录的匹配文件路径。遵循 .gitignore。当你进行可能需要多轮 glob 和 grep 的开放式搜索时，请改用 SearchCodebase 工具。你可以在单个响应中调用多个工具。作为一批可能有用工具进行投机性执行多次搜索总是更好的。" });

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

/**
 * find 工具的可插拔操作。
 * 覆盖这些以将文件搜索委托给远程系统（例如 SSH）。
 */
export interface FindOperations {
	/** 检查路径是否存在 */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** 查找匹配 glob 模式的文件。返回相对路径。 */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: existsSync,
	glob: (_pattern, _searchCwd, _options) => {
		// This is a placeholder - actual fd execution happens in execute
		return [];
	},
};

export interface FindToolOptions {
	/** find 的自定义操作。默认：本地文件系统 + fd */
	operations?: FindOperations;
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	const customOps = options?.operations;

	return {
		name: "find",
		label: "find",
		description: `按 glob 模式搜索文件。返回相对于搜索目录的匹配文件路径。遵循 .gitignore。输出被截断为 ${DEFAULT_LIMIT} 个结果或 ${DEFAULT_MAX_BYTES / 1024}KB（以先达到者为准）。`,
		parameters: findSchema,
		execute: async (
			_toolCallId: string,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
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
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						// 如果提供了自定义操作 glob，则使用它
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								reject(new Error(`路径未找到: ${searchPath}`));
								return;
							}

							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});

							signal?.removeEventListener("abort", onAbort);

							if (results.length === 0) {
								resolve({
									content: [{ type: "text", text: "未找到匹配模式的文件" }],
									details: undefined,
								});
								return;
							}

							// 使路径变为相对路径
							const relativized = results.map((p) => {
								if (p.startsWith(searchPath)) {
									return p.slice(searchPath.length + 1);
								}
								return path.relative(searchPath, p);
							});

							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];

							if (resultLimitReached) {
								notices.push(`已达到 ${effectiveLimit} 个结果的限制`);
								details.resultLimitReached = effectiveLimit;
							}

							if (truncation.truncated) {
								notices.push(`已达到 ${formatSize(DEFAULT_MAX_BYTES)} 的限制`);
								details.truncation = truncation;
							}

							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}

							resolve({
								content: [{ type: "text", text: resultOutput }],
								details: Object.keys(details).length > 0 ? details : undefined,
							});
							return;
						}

						// 默认：使用 fd
						const fdPath = await ensureTool("fd", true);
						if (!fdPath) {
							reject(new Error("fd 不可用且无法下载"));
							return;
						}

						// 构建 fd 参数
						const args: string[] = [
							"--glob",
							"--color=never",
							"--hidden",
							"--max-results",
							String(effectiveLimit),
						];

						// 包含 .gitignore 文件
						const gitignoreFiles = new Set<string>();
						const rootGitignore = path.join(searchPath, ".gitignore");
						if (existsSync(rootGitignore)) {
							gitignoreFiles.add(rootGitignore);
						}

						try {
							const nestedGitignores = globSync("**/.gitignore", {
								cwd: searchPath,
								dot: true,
								absolute: true,
								ignore: ["**/node_modules/**", "**/.git/**"],
							});
							for (const file of nestedGitignores) {
								gitignoreFiles.add(file);
							}
						} catch {
							// 忽略 glob 错误
						}

						for (const gitignorePath of gitignoreFiles) {
							args.push("--ignore-file", gitignorePath);
						}

						args.push(pattern, searchPath);

						const result = spawnSync(fdPath, args, {
							encoding: "utf-8",
							maxBuffer: 10 * 1024 * 1024,
						});

						signal?.removeEventListener("abort", onAbort);

						if (result.error) {
							reject(new Error(`运行 fd 失败: ${result.error.message}`));
							return;
						}

						const output = result.stdout?.trim() || "";

						if (result.status !== 0) {
							const errorMsg = result.stderr?.trim() || `fd 退出，退出码为 ${result.status}`;
							if (!output) {
								reject(new Error(errorMsg));
								return;
							}
						}

						if (!output) {
							resolve({
								content: [{ type: "text", text: "未找到匹配模式的文件" }],
								details: undefined,
							});
							return;
						}

						const lines = output.split("\n");
						const relativized: string[] = [];

						for (const rawLine of lines) {
							const line = rawLine.replace(/\r$/, "").trim();
							if (!line) continue;

							const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
							let relativePath = line;
							if (line.startsWith(searchPath)) {
								relativePath = line.slice(searchPath.length + 1);
							} else {
								relativePath = path.relative(searchPath, line);
							}

							if (hadTrailingSlash && !relativePath.endsWith("/")) {
								relativePath += "/";
							}

							relativized.push(relativePath);
						}

						const resultLimitReached = relativized.length >= effectiveLimit;
						const rawOutput = relativized.join("\n");
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

						let resultOutput = truncation.content;
						const details: FindToolDetails = {};
						const notices: string[] = [];

						if (resultLimitReached) {
							notices.push(
								`已达到 ${effectiveLimit} 个结果的限制。使用 limit=${effectiveLimit * 2} 获取更多，或优化模式`,
							);
							details.resultLimitReached = effectiveLimit;
						}

						if (truncation.truncated) {
							notices.push(`已达到 ${formatSize(DEFAULT_MAX_BYTES)} 的限制`);
							details.truncation = truncation;
						}

						if (notices.length > 0) {
							resultOutput += `\n\n[${notices.join(". ")}]`;
						}

						resolve({
							content: [{ type: "text", text: resultOutput }],
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

/** 使用 process.cwd() 的默认 find 工具 - 为了向后兼容 */
export const findTool = createFindTool(process.cwd());

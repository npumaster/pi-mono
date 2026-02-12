import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import {
	detectLineEnding,
	fuzzyFindText,
	generateDiffString,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { resolveToCwd } from "./path-utils.js";

const editSchema = Type.Object({
	path: Type.String({ description: "要编辑的文件路径（相对或绝对）" }),
	oldText: Type.String({ description: "要查找和替换的确切文本（必须完全匹配）" }),
	newText: Type.String({ description: "用于替换旧文本的新文本" }),
});

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
	/** 对所做更改的统一 diff */
	diff: string;
	/** 新文件中第一次更改的行号（用于编辑器导航） */
	firstChangedLine?: number;
}

/**
 * 编辑工具的可插拔操作。
 * 覆盖这些操作以将文件编辑委托给远程系统（例如 SSH）。
 */
export interface EditOperations {
	/** 将文件内容读取为 Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** 将内容写入文件 */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** 检查文件是否可读写（如果不可读写则抛出异常） */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** 文件编辑的自定义操作。默认值：本地文件系统 */
	operations?: EditOperations;
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	const ops = options?.operations ?? defaultEditOperations;

	return {
		name: "edit",
		label: "edit",
		description:
			"通过替换精确文本来编辑文件。oldText 必须完全匹配（包括空格）。用于精确、外科手术式的编辑。",
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, oldText, newText }: { path: string; oldText: string; newText: string },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveToCwd(path, cwd);

			return new Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: EditToolDetails | undefined;
			}>((resolve, reject) => {
				// 检查是否已中止
				if (signal?.aborted) {
					reject(new Error("操作已中止"));
					return;
				}

				let aborted = false;

				// 设置中止处理程序
				const onAbort = () => {
					aborted = true;
					reject(new Error("操作已中止"));
				};

				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
				}

				// 执行编辑操作
				(async () => {
					try {
						// 检查文件是否存在
						try {
							await ops.access(absolutePath);
						} catch {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(new Error(`找不到文件：${path}`));
							return;
						}

						// 读取前检查是否中止
						if (aborted) {
							return;
						}

						// 读取文件
						const buffer = await ops.readFile(absolutePath);
						const rawContent = buffer.toString("utf-8");

						// 读取后检查是否中止
						if (aborted) {
							return;
						}

						// 在匹配之前去除 BOM（LLM 不会在 oldText 中包含不可见的 BOM）
						const { bom, text: content } = stripBom(rawContent);

						const originalEnding = detectLineEnding(content);
						const normalizedContent = normalizeToLF(content);
						const normalizedOldText = normalizeToLF(oldText);
						const normalizedNewText = normalizeToLF(newText);

						// 使用模糊匹配查找旧文本（先尝试精确匹配，然后模糊匹配）
						const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);

						if (!matchResult.found) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(
								new Error(
									`在 ${path} 中找不到确切的文本。旧文本必须完全匹配，包括所有空格和换行符。`,
								),
							);
							return;
						}

						// 使用模糊归一化的内容计算出现次数以保持一致性
						const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
						const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
						const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;

						if (occurrences > 1) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(
								new Error(
									`在 ${path} 中发现该文本出现了 ${occurrences} 次。文本必须是唯一的。请提供更多上下文以使其唯一。`,
								),
							);
							return;
						}

						// 写入前检查是否中止
						if (aborted) {
							return;
						}

						// 使用匹配的文本位置执行替换
						// 当使用模糊匹配时，contentForReplacement 是归一化版本
						const baseContent = matchResult.contentForReplacement;
						const newContent =
							baseContent.substring(0, matchResult.index) +
							normalizedNewText +
							baseContent.substring(matchResult.index + matchResult.matchLength);

						// 验证替换实际上是否更改了某些内容
						if (baseContent === newContent) {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							reject(
								new Error(
									`${path} 未发生更改。替换产生了相同的内容。这可能表示特殊字符存在问题，或者文本未按预期存在。`,
								),
							);
							return;
						}

						const finalContent = bom + restoreLineEndings(newContent, originalEnding);
						await ops.writeFile(absolutePath, finalContent);

						// 写入后检查是否中止
						if (aborted) {
							return;
						}

						// 清理中止处理程序
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}

						const diffResult = generateDiffString(baseContent, newContent);
						resolve({
							content: [
								{
									type: "text",
									text: `成功替换了 ${path} 中的文本。`,
								},
							],
							details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
						});
					} catch (error: any) {
						// 清理中止处理程序
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}

						if (!aborted) {
							reject(error);
						}
					}
				})();
			});
		},
	};
}

/** 使用 process.cwd() 的默认编辑工具 - 用于向后兼容 */
export const editTool = createEditTool(process.cwd());

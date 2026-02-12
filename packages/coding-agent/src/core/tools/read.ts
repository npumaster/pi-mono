import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import { resolveReadPath } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const readSchema = Type.Object({
	path: Type.String({ description: "要读取的文件路径（相对或绝对）" }),
	offset: Type.Optional(Type.Number({ description: "开始读取的行号（从 1 开始）" })),
	limit: Type.Optional(Type.Number({ description: "读取的最大行数" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * read 工具的可插拔操作。
 * 覆盖这些以将文件读取委托给远程系统（例如 SSH）。
 */
export interface ReadOperations {
	/** 将文件内容读取为 Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** 检查文件是否可读（如果不可读则抛出异常） */
	access: (absolutePath: string) => Promise<void>;
	/** 检测图像 MIME 类型，对于非图像返回 null/undefined */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** 是否自动将图像大小调整为最大 2000x2000。默认：true */
	autoResizeImages?: boolean;
	/** 文件读取的自定义操作。默认：本地文件系统 */
	operations?: ReadOperations;
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;

	return {
		name: "read",
		label: "read",
		description: `读取文件内容。支持文本文件和图像（jpg、png、gif、webp）。图像作为附件发送。对于文本文件，输出被截断为 ${DEFAULT_MAX_LINES} 行或 ${DEFAULT_MAX_BYTES / 1024}KB（以先达到者为准）。对于大文件，请使用 offset/limit。当你需要完整文件时，请使用 offset 继续，直到完成。`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveReadPath(path, cwd);

			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
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

					// 执行读取操作
					(async () => {
						try {
							// 检查文件是否存在
							await ops.access(absolutePath);

							// 读取前检查是否已中止
							if (aborted) {
								return;
							}

							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;

							// 根据类型读取文件
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;

							if (mimeType) {
								// 作为图像读取（二进制）
								const buffer = await ops.readFile(absolutePath);
								const base64 = buffer.toString("base64");

								if (autoResizeImages) {
									// 如果需要，调整图像大小
									const resized = await resizeImage({ type: "image", data: base64, mimeType });
									const dimensionNote = formatDimensionNote(resized);

									let textNote = `已读取图像文件 [${resized.mimeType}]`;
									if (dimensionNote) {
										textNote += `\n${dimensionNote}`;
									}

									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: resized.data, mimeType: resized.mimeType },
									];
								} else {
									const textNote = `已读取图像文件 [${mimeType}]`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: base64, mimeType },
									];
								}
							} else {
								// 作为文本读取
								const buffer = await ops.readFile(absolutePath);
								const textContent = buffer.toString("utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;

								// 如果指定了偏移量，则应用它（从 1 开始到从 0 开始）
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1; // 用于显示（从 1 开始）

								// 检查偏移量是否超出范围
								if (startLine >= allLines.length) {
									throw new Error(`偏移量 ${offset} 超出文件末尾（总共 ${allLines.length} 行）`);
								}

								// 如果用户指定了限制，则使用它；否则我们将让 truncateHead 决定
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}

								// 应用截断（尊重行数和字节限制）
								const truncation = truncateHead(selectedContent);

								let outputText: string;

								if (truncation.firstLineExceedsLimit) {
									// 偏移处的首行超过 30KB - 告诉模型使用 bash
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[第 ${startLineDisplay} 行大小为 ${firstLineSize}，超过了 ${formatSize(DEFAULT_MAX_BYTES)} 的限制。使用 bash：sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// 发生截断 - 构建可操作的通知
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;

									outputText = truncation.content;

									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[显示 ${totalFileLines} 行中的第 ${startLineDisplay}-${endLineDisplay} 行。使用 offset=${nextOffset} 继续。]`;
									} else {
										outputText += `\n\n[显示 ${totalFileLines} 行中的第 ${startLineDisplay}-${endLineDisplay} 行（限制为 ${formatSize(DEFAULT_MAX_BYTES)}）。使用 offset=${nextOffset} 继续。]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// 用户指定了限制，还有更多内容，但没有截断
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;

									outputText = truncation.content;
									outputText += `\n\n[文件中还有 ${remaining} 行。使用 offset=${nextOffset} 继续。]`;
								} else {
									// 无截断，未超过用户限制
									outputText = truncation.content;
								}

								content = [{ type: "text", text: outputText }];
							}

							// 读取后检查是否已中止
							if (aborted) {
								return;
							}

							// 清理中止处理程序
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}

							resolve({ content, details });
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
				},
			);
		},
	};
}

/** 使用 process.cwd() 的默认 read 工具 - 为了向后兼容 */
export const readTool = createReadTool(process.cwd());

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { resolveToCwd } from "./path-utils.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "要写入的文件路径（相对或绝对）" }),
	content: Type.String({ description: "要写入文件的内容" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * write 工具的可插拔操作。
 * 覆盖这些以将文件写入委托给远程系统（例如 SSH）。
 */
export interface WriteOperations {
	/** 将内容写入文件 */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** 创建目录（递归） */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** 文件写入的自定义操作。默认：本地文件系统 */
	operations?: WriteOperations;
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	const ops = options?.operations ?? defaultWriteOperations;

	return {
		name: "write",
		label: "write",
		description:
			"将内容写入文件。如果文件不存在则创建，如果存在则覆盖。自动创建父目录。",
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);

			return new Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }>(
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

					// 执行写入操作
					(async () => {
						try {
							// 如果需要，创建父目录
							await ops.mkdir(dir);

							// 写入前检查是否已中止
							if (aborted) {
								return;
							}

							// 写入文件
							await ops.writeFile(absolutePath, content);

							// 写入后检查是否已中止
							if (aborted) {
								return;
							}

							// 清理中止处理程序
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}

							resolve({
								content: [{ type: "text", text: `成功将 ${content.length} 字节写入 ${path}` }],
								details: undefined,
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
				},
			);
		},
	};
}

/** 使用 process.cwd() 的默认 write 工具 - 为了向后兼容 */
export const writeTool = createWriteTool(process.cwd());

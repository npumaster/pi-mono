import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";

const writeSchema = Type.Object({
	label: Type.String({ description: "你正在编写的内容的简短说明（显示给用户）" }),
	path: Type.String({ description: "要写入的文件路径（相对或绝对）" }),
	content: Type.String({ description: "要写入文件的内容" }),
});

export function createWriteTool(executor: Executor): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description:
			"将内容写入文件。如果文件不存在则创建，如果存在则覆盖。自动创建父目录。",
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path, content }: { label: string; path: string; content: string },
			signal?: AbortSignal,
		) => {
			// 创建父目录并使用 heredoc 写入文件
			const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";

			// 使用 printf 处理带有特殊字符的内容，并管道传输到文件
			// 这可以避免 heredoc 和特殊字符带来的问题
			const cmd = `mkdir -p ${shellEscape(dir)} && printf '%s' ${shellEscape(content)} > ${shellEscape(path)}`;

			const result = await executor.exec(cmd, { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr || `Failed to write file: ${path}`);
			}

			return {
				content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
				details: undefined,
			};
		},
	};
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

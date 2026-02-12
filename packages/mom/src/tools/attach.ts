import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { basename, resolve as resolvePath } from "path";

// 这将在运行前由 agent 设置
let uploadFn: ((filePath: string, title?: string) => Promise<void>) | null = null;

export function setUploadFunction(fn: (filePath: string, title?: string) => Promise<void>): void {
	uploadFn = fn;
}

const attachSchema = Type.Object({
	label: Type.String({ description: "你正在共享内容的简短说明（显示给用户）" }),
	path: Type.String({ description: "要附加的文件路径" }),
	title: Type.Optional(Type.String({ description: "文件的标题（默认为文件名）" })),
});

export const attachTool: AgentTool<typeof attachSchema> = {
	name: "attach",
	label: "attach",
	description:
		"在回复中附加文件。使用此功能与用户共享文件、图像或文档。仅能附加来自 /workspace/ 的文件。",
	parameters: attachSchema,
	execute: async (
		_toolCallId: string,
		{ path, title }: { label: string; path: string; title?: string },
		signal?: AbortSignal,
	) => {
		if (!uploadFn) {
			throw new Error("Upload function not configured");
		}

		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const absolutePath = resolvePath(path);
		const fileName = title || basename(absolutePath);

		await uploadFn(absolutePath, fileName);

		return {
			content: [{ type: "text" as const, text: `Attached file: ${fileName}` }],
			details: undefined,
		};
	},
};

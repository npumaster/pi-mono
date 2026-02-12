import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";
import type { Executor } from "../sandbox.js";

/**
 * 生成带有行号和上下文的统一 diff 字符串
 */
function generateDiffString(oldContent: string, newContent: string, contextLines = 4): string {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				oldLineNum += skipStart + skipEnd;
				newLineNum += skipStart + skipEnd;
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}

const editSchema = Type.Object({
	label: Type.String({ description: "你正在进行的编辑的简短说明（显示给用户）" }),
	path: Type.String({ description: "要编辑的文件路径（相对或绝对）" }),
	oldText: Type.String({ description: "要查找并替换的确切文本（必须完全匹配）" }),
	newText: Type.String({ description: "用于替换旧文本的新文本" }),
});

export function createEditTool(executor: Executor): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "edit",
		description:
			"通过替换确切文本来编辑文件。oldText 必须完全匹配（包括空白字符）。用于精确的外科手术式编辑。",
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, oldText, newText }: { label: string; path: string; oldText: string; newText: string },
			signal?: AbortSignal,
		) => {
			// 读取文件
			const readResult = await executor.exec(`cat ${shellEscape(path)}`, { signal });
			if (readResult.code !== 0) {
				throw new Error(readResult.stderr || `File not found: ${path}`);
			}

			const content = readResult.stdout;

			// 检查旧文本是否存在
			if (!content.includes(oldText)) {
				throw new Error(
					`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
				);
			}

			// 计算出现次数
			const occurrences = content.split(oldText).length - 1;

			if (occurrences > 1) {
				throw new Error(
					`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
				);
			}

			// 执行替换
			const index = content.indexOf(oldText);
			const newContent = content.substring(0, index) + newText + content.substring(index + oldText.length);

			if (content === newContent) {
				throw new Error(
					`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
				);
			}

			// 将文件写回
			const writeResult = await executor.exec(`printf '%s' ${shellEscape(newContent)} > ${shellEscape(path)}`, {
				signal,
			});
			if (writeResult.code !== 0) {
				throw new Error(writeResult.stderr || `Failed to write file: ${path}`);
			}

			return {
				content: [
					{
						type: "text",
						text: `Successfully replaced text in ${path}. Changed ${oldText.length} characters to ${newText.length} characters.`,
					},
				],
				details: { diff: generateDiffString(content, newContent) },
			};
		},
	};
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

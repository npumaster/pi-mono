/**
 * 用于截断文本和字节序列的实用程序。
 */
import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // 每个 grep 匹配行的最大字符数

export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 达到了哪个限制："lines"、"bytes"，如果未截断则为 null */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容的总行数 */
	totalLines: number;
	/** 原始内容的总字节数 */
	totalBytes: number;
	/** 截断输出中的完整行数 */
	outputLines: number;
	/** 截断输出中的字节数 */
	outputBytes: number;
	/** 最后一行是否被部分截断（仅适用于 tail 截断的边缘情况） */
	lastLinePartial: boolean;
	/** 第一行是否超过了字节限制（用于 head 截断） */
	firstLineExceedsLimit: boolean;
	/** 应用的最大行数限制 */
	maxLines: number;
	/** 应用的最大字节限制 */
	maxBytes: number;
}

export interface TruncationOptions {
	/** 最大行数（默认：2000） */
	maxLines?: number;
	/** 最大字节数（默认：50KB） */
	maxBytes?: number;
}

/**
 * 将字节格式化为人类可读的大小。
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * 从头部截断内容（保留前 N 行/字节）。
 * 适用于你希望看到开头的文本读取。
 *
 * 永远不会返回不完整的行。如果第一行超过了字节限制，
 * 则返回空内容并将 firstLineExceedsLimit 设置为 true。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	// 检查是否不需要截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 检查第一行是否单独超过字节限制
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// 收集符合条件的完整行
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 表示换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 如果我们是因为行数限制而退出的
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 从尾部截断内容（保留最后 N 行/字节）。
 * 适用于你希望看到结尾的 bash 输出（错误、最终结果）。
 *
 * 如果原始内容的最后一行超过字节限制，可能会返回部分第一行。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	// 检查是否不需要截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 从末尾向前处理
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 表示换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 边缘情况：如果我们还没有添加任何行，并且这一行超过了 maxBytes，
			// 则取该行的末尾（部分）
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// 如果我们是因为行数限制而退出的
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 将字符串截断以适应字节限制（从末尾开始）。
 * 正确处理多字节 UTF-8 字符。
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// 从末尾开始，向回跳 maxBytes
	let start = buf.length - maxBytes;

	// 找到有效的 UTF-8 边界（字符的开始）
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

/**
 * 将单行截断为最大字符数，并添加 [truncated] 后缀。
 * 用于 grep 匹配行。
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [截断]`, wasTruncated: true };
}

import { eastAsianWidth } from "get-east-asian-width";

// 字形分割器（共享实例）
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 获取共享的字形分割器实例。
 */
export function getSegmenter(): Intl.Segmenter {
	return segmenter;
}

/**
 * 检查字形集群（分割后）是否可能是 RGI 表情符号。
 * 这是一个快速启发式方法，用于避免昂贵的 rgiEmojiRegex 测试。
 * 测试的 Unicode 块故意设置得比较宽，以适应未来的 Unicode 添加。
 */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0)!;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) || // 表情符号和象形文字
		(cp >= 0x2300 && cp <= 0x23ff) || // 杂项技术符号
		(cp >= 0x2600 && cp <= 0x27bf) || // 杂项符号、装饰符号
		(cp >= 0x2b50 && cp <= 0x2b55) || // 特定的星星/圆圈
		segment.includes("\uFE0F") || // 包含 VS16（表情符号呈现选择器）
		segment.length > 2 // 多代码点序列（ZWJ、肤色等）
	);
}

// Regexes for character classification (same as string-width library)
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;

// Cache for non-ASCII strings
const WIDTH_CACHE_SIZE = 512;
const widthCache = new Map<string, number>();

/**
 * Calculate the terminal width of a single grapheme cluster.
 * Based on code from the string-width library, but includes a possible-emoji
 * check to avoid running the RGI_Emoji regex unnecessarily.
 */
function graphemeWidth(segment: string): number {
	// Zero-width clusters
	if (zeroWidthRegex.test(segment)) {
		return 0;
	}

	// Emoji check with pre-filter
	if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
		return 2;
	}

	// Get base visible codepoint
	const base = segment.replace(leadingNonPrintingRegex, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) {
		return 0;
	}

	let width = eastAsianWidth(cp);

	// Trailing halfwidth/fullwidth forms
	if (segment.length > 1) {
		for (const char of segment.slice(1)) {
			const c = char.codePointAt(0)!;
			if (c >= 0xff00 && c <= 0xffef) {
				width += eastAsianWidth(c);
			}
		}
	}

	return width;
}

/**
 * Calculate the visible width of a string in terminal columns.
 */
export function visibleWidth(str: string): number {
	if (str.length === 0) {
		return 0;
	}

	// Fast path: pure ASCII printable
	let isPureAscii = true;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			isPureAscii = false;
			break;
		}
	}
	if (isPureAscii) {
		return str.length;
	}

	// Check cache
	const cached = widthCache.get(str);
	if (cached !== undefined) {
		return cached;
	}

	// Normalize: tabs to 3 spaces, strip ANSI escape codes
	let clean = str;
	if (str.includes("\t")) {
		clean = clean.replace(/\t/g, "   ");
	}
	if (clean.includes("\x1b")) {
		// Strip SGR codes (\x1b[...m) and cursor codes (\x1b[...G/K/H/J)
		clean = clean.replace(/\x1b\[[0-9;]*[mGKHJ]/g, "");
		// Strip OSC 8 hyperlinks: \x1b]8;;URL\x07 and \x1b]8;;\x07
		clean = clean.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
		// Strip APC sequences: \x1b_...\x07 or \x1b_...\x1b\\ (used for cursor marker)
		clean = clean.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
	}

	// Calculate width
	let width = 0;
	for (const { segment } of segmenter.segment(clean)) {
		width += graphemeWidth(segment);
	}

	// Cache result
	if (widthCache.size >= WIDTH_CACHE_SIZE) {
		const firstKey = widthCache.keys().next().value;
		if (firstKey !== undefined) {
			widthCache.delete(firstKey);
		}
	}
	widthCache.set(str, width);

	return width;
}

/**
 * Extract ANSI escape sequences from a string at the given position.
 */
export function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	if (pos >= str.length || str[pos] !== "\x1b") return null;

	const next = str[pos + 1];

	// CSI sequence: ESC [ ... m/G/K/H/J
	if (next === "[") {
		let j = pos + 2;
		while (j < str.length && !/[mGKHJ]/.test(str[j]!)) j++;
		if (j < str.length) return { code: str.substring(pos, j + 1), length: j + 1 - pos };
		return null;
	}

	// OSC sequence: ESC ] ... BEL or ESC ] ... ST (ESC \)
	// Used for hyperlinks (OSC 8), window titles, etc.
	if (next === "]") {
		let j = pos + 2;
		while (j < str.length) {
			if (str[j] === "\x07") return { code: str.substring(pos, j + 1), length: j + 1 - pos };
			if (str[j] === "\x1b" && str[j + 1] === "\\") return { code: str.substring(pos, j + 2), length: j + 2 - pos };
			j++;
		}
		return null;
	}

	// APC sequence: ESC _ ... BEL or ESC _ ... ST (ESC \)
	// Used for cursor marker and application-specific commands
	if (next === "_") {
		let j = pos + 2;
		while (j < str.length) {
			if (str[j] === "\x07") return { code: str.substring(pos, j + 1), length: j + 1 - pos };
			if (str[j] === "\x1b" && str[j + 1] === "\\") return { code: str.substring(pos, j + 2), length: j + 2 - pos };
			j++;
		}
		return null;
	}

	return null;
}

/**
 * Track active ANSI SGR codes to preserve styling across line breaks.
 */
class AnsiCodeTracker {
	// Track individual attributes separately so we can reset them specifically
	private bold = false;
	private dim = false;
	private italic = false;
	private underline = false;
	private blink = false;
	private inverse = false;
	private hidden = false;
	private strikethrough = false;
	private fgColor: string | null = null; // Stores the full code like "31" or "38;5;240"
	private bgColor: string | null = null; // Stores the full code like "41" or "48;5;240"

	process(ansiCode: string): void {
		if (!ansiCode.endsWith("m")) {
			return;
		}

		// Extract the parameters between \x1b[ and m
		const match = ansiCode.match(/\x1b\[([\d;]*)m/);
		if (!match) return;

		const params = match[1];
		if (params === "" || params === "0") {
			// 完全重置
			this.reset();
			return;
		}

		// 解析参数（可以是分号分隔的）
		const parts = params.split(";");
		let i = 0;
		while (i < parts.length) {
			const code = Number.parseInt(parts[i], 10);

			// 处理占用多个参数的 256 色和 RGB 代码
			if (code === 38 || code === 48) {
				// 38;5;N (256 色前景色) 或 38;2;R;G;B (RGB 前景色)
				// 48;5;N (256 色背景色) 或 48;2;R;G;B (RGB 背景色)
				if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
					// 256 色：38;5;N 或 48;5;N
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 3;
					continue;
				} else if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
					// RGB 颜色：38;2;R;G;B 或 48;2;R;G;B
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 5;
					continue;
				}
			}

			// 标准 SGR 代码
			switch (code) {
				case 0:
					this.reset();
					break;
				case 1:
					this.bold = true;
					break;
				case 2:
					this.dim = true;
					break;
				case 3:
					this.italic = true;
					break;
				case 4:
					this.underline = true;
					break;
				case 5:
					this.blink = true;
					break;
				case 7:
					this.inverse = true;
					break;
				case 8:
					this.hidden = true;
					break;
				case 9:
					this.strikethrough = true;
					break;
				case 21:
					this.bold = false;
					break; // 某些终端
				case 22:
					this.bold = false;
					this.dim = false;
					break;
				case 23:
					this.italic = false;
					break;
				case 24:
					this.underline = false;
					break;
				case 25:
					this.blink = false;
					break;
				case 27:
					this.inverse = false;
					break;
				case 28:
					this.hidden = false;
					break;
				case 29:
					this.strikethrough = false;
					break;
				case 39:
					this.fgColor = null;
					break; // 默认前景色
				case 49:
					this.bgColor = null;
					break; // 默认背景色
				default:
					// 标准前景色 30-37, 90-97
					if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
						this.fgColor = String(code);
					}
					// 标准背景色 40-47, 100-107
					else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
						this.bgColor = String(code);
					}
					break;
			}
			i++;
		}
	}

	private reset(): void {
		this.bold = false;
		this.dim = false;
		this.italic = false;
		this.underline = false;
		this.blink = false;
		this.inverse = false;
		this.hidden = false;
		this.strikethrough = false;
		this.fgColor = null;
		this.bgColor = null;
	}

	/** 清除所有状态以便重用。 */
	clear(): void {
		this.reset();
	}

	getActiveCodes(): string {
		const codes: string[] = [];
		if (this.bold) codes.push("1");
		if (this.dim) codes.push("2");
		if (this.italic) codes.push("3");
		if (this.underline) codes.push("4");
		if (this.blink) codes.push("5");
		if (this.inverse) codes.push("7");
		if (this.hidden) codes.push("8");
		if (this.strikethrough) codes.push("9");
		if (this.fgColor) codes.push(this.fgColor);
		if (this.bgColor) codes.push(this.bgColor);

		if (codes.length === 0) return "";
		return `\x1b[${codes.join(";")}m`;
	}

	hasActiveCodes(): boolean {
		return (
			this.bold ||
			this.dim ||
			this.italic ||
			this.underline ||
			this.blink ||
			this.inverse ||
			this.hidden ||
			this.strikethrough ||
			this.fgColor !== null ||
			this.bgColor !== null
		);
	}

	/**
	 * 获取需要在行尾关闭的属性的重置代码，
	 * 特别是会溢出到填充区域的下划线。
	 * 如果没有激活有问题的属性，则返回空字符串。
	 */
	getLineEndReset(): string {
		// 只有下划线会导致视觉溢出到填充区域
		// 其他属性（如颜色）不会在视觉上溢出到填充区域
		if (this.underline) {
			return "\x1b[24m"; // 仅关闭下划线
		}
		return "";
	}
}

function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
	let i = 0;
	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			tracker.process(ansiResult.code);
			i += ansiResult.length;
		} else {
			i++;
		}
	}
}

/**
 * 将文本拆分为单词，同时保持 ANSI 代码附着。
 */
function splitIntoTokensWithAnsi(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let pendingAnsi = ""; // 等待附着到下一个可见内容的 ANSI 代码
	let inWhitespace = false;
	let i = 0;

	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			// 单独保存 ANSI 代码 - 它们将被附着到下一个可见字符
			pendingAnsi += ansiResult.code;
			i += ansiResult.length;
			continue;
		}

		const char = text[i];
		const charIsSpace = char === " ";

		if (charIsSpace !== inWhitespace && current) {
			// 在空白和非空白之间切换，推送当前标记
			tokens.push(current);
			current = "";
		}

		// 将任何待处理的 ANSI 代码附着到此可见字符
		if (pendingAnsi) {
			current += pendingAnsi;
			pendingAnsi = "";
		}

		inWhitespace = charIsSpace;
		current += char;
		i++;
	}

	// 处理任何剩余的待处理 ANSI 代码（附着到最后一个标记）
	if (pendingAnsi) {
		current += pendingAnsi;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * 在保留 ANSI 代码的情况下包装文本。
 *
 * 仅进行分词包装 - 无填充，无背景颜色。
 * 返回每一行可见字符数 <= width 的行。
 * 激活的 ANSI 代码在换行时会被保留。
 *
 * @param text - 要包装的文本（可能包含 ANSI 代码和换行符）
 * @param width - 每行最大可见宽度
 * @returns 包装后的行数组（不填充到 width）
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (!text) {
		return [""];
	}

	// 通过分别处理每一行来处理换行符
	// 跨行跟踪 ANSI 状态，以便样式在字面换行符后得以延续
	const inputLines = text.split("\n");
	const result: string[] = [];
	const tracker = new AnsiCodeTracker();

	for (const inputLine of inputLines) {
		// 在前面的行（除第一行外）前置激活的 ANSI 代码
		const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
		result.push(...wrapSingleLine(prefix + inputLine, width));
		// 使用此行的代码更新跟踪器，以便下次迭代使用
		updateTrackerFromText(inputLine, tracker);
	}

	return result.length > 0 ? result : [""];
}

function wrapSingleLine(line: string, width: number): string[] {
	if (!line) {
		return [""];
	}

	const visibleLength = visibleWidth(line);
	if (visibleLength <= width) {
		return [line];
	}

	const wrapped: string[] = [];
	const tracker = new AnsiCodeTracker();
	const tokens = splitIntoTokensWithAnsi(line);

	let currentLine = "";
	let currentVisibleLength = 0;

	for (const token of tokens) {
		const tokenVisibleLength = visibleWidth(token);
		const isWhitespace = token.trim() === "";

		// 标记本身太长 - 逐个字符拆分
		if (tokenVisibleLength > width && !isWhitespace) {
			if (currentLine) {
				// 仅为下划线添加特定重置（保留背景）
				const lineEndReset = tracker.getLineEndReset();
				if (lineEndReset) {
					currentLine += lineEndReset;
				}
				wrapped.push(currentLine);
				currentLine = "";
				currentVisibleLength = 0;
			}

			// 拆分长标记 - breakLongWord 处理其自身的重置
			const broken = breakLongWord(token, width, tracker);
			wrapped.push(...broken.slice(0, -1));
			currentLine = broken[broken.length - 1];
			currentVisibleLength = visibleWidth(currentLine);
			continue;
		}

		// 检查添加此标记是否会超过宽度
		const totalNeeded = currentVisibleLength + tokenVisibleLength;

		if (totalNeeded > width && currentVisibleLength > 0) {
			// 修剪末尾空白，然后添加下划线重置（不是完整重置，以保留背景）
			let lineToWrap = currentLine.trimEnd();
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) {
				lineToWrap += lineEndReset;
			}
			wrapped.push(lineToWrap);
			if (isWhitespace) {
				// 不要以空白开始新行
				currentLine = tracker.getActiveCodes();
				currentVisibleLength = 0;
			} else {
				currentLine = tracker.getActiveCodes() + token;
				currentVisibleLength = tokenVisibleLength;
			}
		} else {
			// 添加到当前行
			currentLine += token;
			currentVisibleLength += tokenVisibleLength;
		}

		updateTrackerFromText(token, tracker);
	}

	if (currentLine) {
		// 最后一行末尾不重置 - 由调用者处理
		wrapped.push(currentLine);
	}

	// 末尾空白可能导致行超过请求的宽度
	return wrapped.length > 0 ? wrapped.map((line) => line.trimEnd()) : [""];
}

const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

/**
 * 检查字符是否为空白字符。
 */
export function isWhitespaceChar(char: string): boolean {
	return /\s/.test(char);
}

/**
 * 检查字符是否为标点符号。
 */
export function isPunctuationChar(char: string): boolean {
	return PUNCTUATION_REGEX.test(char);
}

function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
	const lines: string[] = [];
	let currentLine = tracker.getActiveCodes();
	let currentWidth = 0;

	// 首先，将 ANSI 代码与可见内容分离
	// 我们需要专门处理 ANSI 代码，因为它们不是字形
	let i = 0;
	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];

	while (i < word.length) {
		const ansiResult = extractAnsiCode(word, i);
		if (ansiResult) {
			segments.push({ type: "ansi", value: ansiResult.code });
			i += ansiResult.length;
		} else {
			// 查找下一个 ANSI 代码或字符串末尾
			let end = i;
			while (end < word.length) {
				const nextAnsi = extractAnsiCode(word, end);
				if (nextAnsi) break;
				end++;
			}
			// 将此非 ANSI 部分分割为字形
			const textPortion = word.slice(i, end);
			for (const seg of segmenter.segment(textPortion)) {
				segments.push({ type: "grapheme", value: seg.segment });
			}
			i = end;
		}
	}

	// 现在处理段
	for (const seg of segments) {
		if (seg.type === "ansi") {
			currentLine += seg.value;
			tracker.process(seg.value);
			continue;
		}

		const grapheme = seg.value;
		// 跳过空字形以避免字符串宽度计算出现问题
		if (!grapheme) continue;

		const graphemeWidth = visibleWidth(grapheme);

		if (currentWidth + graphemeWidth > width) {
			// 仅为下划线添加特定重置（保留背景）
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) {
				currentLine += lineEndReset;
			}
			lines.push(currentLine);
			currentLine = tracker.getActiveCodes();
			currentWidth = 0;
		}

		currentLine += grapheme;
		currentWidth += graphemeWidth;
	}

	if (currentLine) {
		// 最后一个段末尾不重置 - 调用者处理延续
		lines.push(currentLine);
	}

	return lines.length > 0 ? lines : [""];
}

/**
 * 为一行应用背景颜色，并填充到完整宽度。
 *
 * @param line - 文本行（可能包含 ANSI 代码）
 * @param width - 要填充到的总宽度
 * @param bgFn - 背景颜色函数
 * @returns 应用了背景并填充到宽度的行
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// 计算所需的填充
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);
	const padding = " ".repeat(paddingNeeded);

	// 为内容 + 填充应用背景
	const withPadding = line + padding;
	return bgFn(withPadding);
}

/**
 * 截断文本以适应最大可见宽度，必要时添加省略号。
 * 可选地用空格填充以精确达到 maxWidth。
 * 正确处理 ANSI 转义代码（它们不计入宽度）。
 *
 * @param text - 要截断的文本（可能包含 ANSI 代码）
 * @param maxWidth - 最大可见宽度
 * @param ellipsis - 截断时附加的省略号字符串（默认："..."）
 * @param pad - 如果为 true，则用空格填充结果以精确达到 maxWidth（默认：false）
 * @returns 截断后的文本，可选地填充到精确的 maxWidth
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis: string = "...",
	pad: boolean = false,
): string {
	const textVisibleWidth = visibleWidth(text);

	if (textVisibleWidth <= maxWidth) {
		return pad ? text + " ".repeat(maxWidth - textVisibleWidth) : text;
	}

	const ellipsisWidth = visibleWidth(ellipsis);
	const targetWidth = maxWidth - ellipsisWidth;

	if (targetWidth <= 0) {
		return ellipsis.substring(0, maxWidth);
	}

	// 使用字形分割将 ANSI 代码与可见内容分离
	let i = 0;
	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];

	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			segments.push({ type: "ansi", value: ansiResult.code });
			i += ansiResult.length;
		} else {
			// 查找下一个 ANSI 代码或字符串末尾
			let end = i;
			while (end < text.length) {
				const nextAnsi = extractAnsiCode(text, end);
				if (nextAnsi) break;
				end++;
			}
			// 将此非 ANSI 部分分割为字形
			const textPortion = text.slice(i, end);
			for (const seg of segmenter.segment(textPortion)) {
				segments.push({ type: "grapheme", value: seg.segment });
			}
			i = end;
		}
	}

	// 从段构建截断的字符串
	let result = "";
	let currentWidth = 0;

	for (const seg of segments) {
		if (seg.type === "ansi") {
			result += seg.value;
			continue;
		}

		const grapheme = seg.value;
		// 跳过空字形以避免字符串宽度计算出现问题
		if (!grapheme) continue;

		const graphemeWidth = visibleWidth(grapheme);

		if (currentWidth + graphemeWidth > targetWidth) {
			break;
		}

		result += grapheme;
		currentWidth += graphemeWidth;
	}

	// 在省略号前添加重置代码，以防止样式泄露到省略号中
	const truncated = `${result}\x1b[0m${ellipsis}`;
	if (pad) {
		const truncatedWidth = visibleWidth(truncated);
		return truncated + " ".repeat(Math.max(0, maxWidth - truncatedWidth));
	}
	return truncated;
}

/**
 * 从行中提取可见列范围。处理 ANSI 代码和宽字符。
 * @param strict - 如果为 true，则排除边界处会延伸超出范围的宽字符
 */
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}

/** 类似于 sliceByColumn，但还返回结果的实际可见宽度。 */
export function sliceWithWidth(
	line: string,
	startCol: number,
	length: number,
	strict = false,
): { text: string; width: number } {
	if (length <= 0) return { text: "", width: 0 };
	const endCol = startCol + length;
	let result = "",
		resultWidth = 0,
		currentCol = 0,
		i = 0,
		pendingAnsi = "";

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			if (currentCol >= startCol && currentCol < endCol) result += ansi.code;
			else if (currentCol < startCol) pendingAnsi += ansi.code;
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);
			const inRange = currentCol >= startCol && currentCol < endCol;
			const fits = !strict || currentCol + w <= endCol;
			if (inRange && fits) {
				if (pendingAnsi) {
					result += pendingAnsi;
					pendingAnsi = "";
				}
				result += segment;
				resultWidth += w;
			}
			currentCol += w;
			if (currentCol >= endCol) break;
		}
		i = textEnd;
		if (currentCol >= endCol) break;
	}
	return { text: result, width: resultWidth };
}

// 用于 extractSegments 的池化跟踪器实例（避免每次调用都进行分配）
const pooledStyleTracker = new AnsiCodeTracker();

/**
 * 在单次处理中从行中提取“前”和“后”段。
 * 用于叠加层合成，其中我们需要叠加区域之前和之后的内容。
 * 保留叠加层之前的样式，这些样式应该影响叠加层之后的内容。
 */
export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter = false,
): { before: string; beforeWidth: number; after: string; afterWidth: number } {
	let before = "",
		beforeWidth = 0,
		after = "",
		afterWidth = 0;
	let currentCol = 0,
		i = 0;
	let pendingAnsiBefore = "";
	let afterStarted = false;
	const afterEnd = afterStart + afterLen;

	// 跟踪样式状态，以便“后”段继承叠加层之前的样式
	pooledStyleTracker.clear();

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			// 跟踪所有 SGR 代码以了解 afterStart 处的样式状态
			pooledStyleTracker.process(ansi.code);
			// 在各自的段中包含 ANSI 代码
			if (currentCol < beforeEnd) {
				pendingAnsiBefore += ansi.code;
			} else if (currentCol >= afterStart && currentCol < afterEnd && afterStarted) {
				// 仅在“后”段开始后包含（样式已预置）
				after += ansi.code;
			}
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);

			if (currentCol < beforeEnd) {
				if (pendingAnsiBefore) {
					before += pendingAnsiBefore;
					pendingAnsiBefore = "";
				}
				before += segment;
				beforeWidth += w;
			} else if (currentCol >= afterStart && currentCol < afterEnd) {
				const fits = !strictAfter || currentCol + w <= afterEnd;
				if (fits) {
					// 在第一个“后”段字形上，预置从叠加层之前继承的样式
					if (!afterStarted) {
						after += pooledStyleTracker.getActiveCodes();
						afterStarted = true;
					}
					after += segment;
					afterWidth += w;
				}
			}

			currentCol += w;
			// 提前退出：仅完成“前”段，或两个段都已完成
			if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
		}
		i = textEnd;
		if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
	}

	return { before, beforeWidth, after, afterWidth };
}

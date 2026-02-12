import { marked, type Token } from "marked";
import { isImageLine } from "../terminal-image.js";
import type { Component } from "../tui.js";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";

/**
 * Markdown 内容的默认文本样式。
 * 应用于所有文本，除非被 markdown 格式覆盖。
 */
export interface DefaultTextStyle {
	/** 前景色函数 */
	color?: (text: string) => string;
	/** 背景色函数 */
	bgColor?: (text: string) => string;
	/** 粗体文本 */
	bold?: boolean;
	/** 斜体文本 */
	italic?: boolean;
	/** 删除线文本 */
	strikethrough?: boolean;
	/** 下划线文本 */
	underline?: boolean;
}

/**
 * Markdown 元素的主题函数。
 * 每个函数接收文本并返回带有 ANSI 代码的样式化文本。
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** 应用于每个渲染的代码块行的前缀（默认："  "） */
	codeBlockIndent?: string;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // 左右内边距
	private paddingY: number; // 上下内边距
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private defaultStylePrefix?: string;

	// 渲染输出的缓存
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
	}

	setText(text: string): void {
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// 检查缓存
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// 计算内容的可用宽度（减去水平内边距）
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// 如果没有实际文本，则不渲染任何内容
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			// 更新缓存
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// 将制表符替换为 3 个空格，以实现一致的渲染
		const normalizedText = this.text.replace(/\t/g, "   ");

		// 将 markdown 解析为类 HTML 的 token
		const tokens = marked.lexer(normalizedText);

		// 将 token 转换为样式化的终端输出
		const renderedLines: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
			renderedLines.push(...tokenLines);
		}

		// 换行（尚未添加内边距和背景）
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
			} else {
				wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
			}
		}

		// 为每个换行后的行添加边距和背景
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			if (isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// 没有背景 - 仅填充到宽度
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// 添加上下内边距（空行）
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// 合并上内边距、内容和下内边距
		const result = [...emptyLines, ...contentLines, ...emptyLines];

		// 更新缓存
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * 对字符串应用默认文本样式。
	 * 这是应用于所有文本内容的基础样式。
	 * 注意：此处不应用背景色 - 背景色在内边距阶段应用，
	 * 以确保其延伸到整个行宽。
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// 应用前景色（不是背景色 - 背景色在内边距阶段应用）
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// 使用 this.theme 应用文本装饰
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(token: Token, width: number, nextTokenType?: string): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;
				const headingText = this.renderInlineTokens(token.tokens || []);
				let styledHeading: string;
				if (headingLevel === 1) {
					styledHeading = this.theme.heading(this.theme.bold(this.theme.underline(headingText)));
				} else if (headingLevel === 2) {
					styledHeading = this.theme.heading(this.theme.bold(headingText));
				} else {
					styledHeading = this.theme.heading(this.theme.bold(headingPrefix + headingText));
				}
				lines.push(styledHeading);
				if (nextTokenType !== "space") {
					lines.push(""); // 在标题后添加间距（除非后面跟着空格 token）
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || []);
				lines.push(paragraphText);
				// 如果下一个 token 是空格或列表，则不添加间距
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				if (this.theme.highlightCode) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines) {
						lines.push(`${indent}${hlLine}`);
					}
				} else {
					// 按换行符分割代码并为每行应用样式
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
					}
				}
				lines.push(this.theme.codeBlockBorder("```"));
				if (nextTokenType !== "space") {
					lines.push(""); // 在代码块后添加间距（除非后面跟着空格 token）
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as any, 0);
				lines.push(...listLines);
				// 如果后面跟着空格 token，则不在列表后添加间距
				// （空格 token 会处理它）
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as any, width);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStyleContext: InlineStyleContext = {
					applyText: quoteStyle,
					stylePrefix: this.getStylePrefix(quoteStyle),
				};
				const quoteText = this.renderInlineTokens(token.tokens || [], quoteStyleContext);
				const quoteLines = quoteText.split("\n");

				// 计算引用内容的可用宽度（减去边框 "│ " = 2 个字符）
				const quoteContentWidth = Math.max(1, width - 2);

				for (const quoteLine of quoteLines) {
					// 对样式化的行进行换行，然后为每个换行后的行添加边框
					const wrappedLines = wrapTextWithAnsi(quoteLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType !== "space") {
					lines.push(""); // 在块引用后添加间距（除非后面跟着空格 token）
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				if (nextTokenType !== "space") {
					lines.push(""); // 在水平分割线后添加间距（除非后面跟着空格 token）
				}
				break;

			case "html":
				// 将 HTML 渲染为纯文本（针对终端进行了转义）
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// 空格 token 代表 markdown 中的空行
				lines.push("");
				break;

			default:
				// 将任何其他 token 类型作为纯文本处理
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "text":
					// 列表项中的文本 token 可以包含用于内联格式化的嵌套 token
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "paragraph":
					// 段落 token 包含嵌套的内联 token
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					// 如果链接文本与 href 匹配，则仅显示一次链接
					// 比较原始文本（token.text）而不是样式化文本（linkText），因为 linkText 包含 ANSI 代码
					// 对于 mailto: 链接，在比较前剥离前缀（自动链接的电子邮件具有 text="foo@bar.com" 但 href="mailto:foo@bar.com"）
					const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
					if (token.text === token.href || token.text === hrefForComparison) {
						result += this.theme.link(this.theme.underline(linkText)) + stylePrefix;
					} else {
						result +=
							this.theme.link(this.theme.underline(linkText)) +
							this.theme.linkUrl(` (${token.href})`) +
							stylePrefix;
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// 将内联 HTML 渲染为纯文本
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					}
					break;

				default:
					// 将任何其他内联 token 类型作为纯文本处理
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		return result;
	}

	/**
	 * 渲染具有适当嵌套支持的列表
	 */
	private renderList(token: Token & { items: any[]; ordered: boolean; start?: number }, depth: number): string[] {
		const lines: string[] = [];
		const indent = "  ".repeat(depth);
		// 使用列表的 start 属性（有序列表默认为 1）
		const startNumber = token.start ?? 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";

			// 处理项 token 以处理嵌套列表
			const itemLines = this.renderListItem(item.tokens || [], depth);

			if (itemLines.length > 0) {
				// 第一行 - 检查是否为嵌套列表
				// 嵌套列表将以缩进（空格）开始，后跟青色项目符号
				const firstLine = itemLines[0];
				const isNestedList = /^\s+\x1b\[36m[-\d]/.test(firstLine); // 以空格 + 青色 + 项目符号字符开始

				if (isNestedList) {
					// 这是一个嵌套列表，直接按原样添加（已经具有完整缩进）
					lines.push(firstLine);
				} else {
					// 普通文本内容 - 添加缩进和项目符号
					lines.push(indent + this.theme.listBullet(bullet) + firstLine);
				}

				// 剩余行
				for (let j = 1; j < itemLines.length; j++) {
					const line = itemLines[j];
					const isNestedListLine = /^\s+\x1b\[36m[-\d]/.test(line); // 以空格 + 青色 + 项目符号字符开始

					if (isNestedListLine) {
						// 嵌套列表行 - 已经具有完整缩进
						lines.push(line);
					} else {
						// 普通内容 - 添加父级缩进 + 2 个空格以继续
						lines.push(`${indent}  ${line}`);
					}
				}
			} else {
				lines.push(indent + this.theme.listBullet(bullet));
			}
		}

		return lines;
	}

	/**
	 * 渲染列表项 token，处理嵌套列表
	 * 返回不带父级缩进的行（renderList 会添加它）
	 */
	private renderListItem(tokens: Token[], parentDepth: number): string[] {
		const lines: string[] = [];

		for (const token of tokens) {
			if (token.type === "list") {
				// 嵌套列表 - 以额外的一级缩进渲染
				// 这些行将具有它们自己的缩进，因此我们直接按原样添加它们
				const nestedLines = this.renderList(token as any, parentDepth + 1);
				lines.push(...nestedLines);
			} else if (token.type === "text") {
				// 文本内容（可能包含内联 token）
				const text =
					token.tokens && token.tokens.length > 0 ? this.renderInlineTokens(token.tokens) : token.text || "";
				lines.push(text);
			} else if (token.type === "paragraph") {
				// 列表项中的段落
				const text = this.renderInlineTokens(token.tokens || []);
				lines.push(text);
			} else if (token.type === "code") {
				// 列表项中的代码块
				const indent = this.theme.codeBlockIndent ?? "  ";
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				if (this.theme.highlightCode) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines) {
						lines.push(`${indent}${hlLine}`);
					}
				} else {
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
					}
				}
				lines.push(this.theme.codeBlockBorder("```"));
			} else {
				// 其他 token 类型 - 尝试作为内联渲染
				const text = this.renderInlineTokens([token]);
				if (text) {
					lines.push(text);
				}
			}
		}

		return lines;
	}

	/**
	 * 获取字符串中最长单词的视觉宽度。
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * 换行表格单元格以适应列。
	 *
	 * 委托给 wrapTextWithAnsi()，以便 ANSI 代码 + 长 token 的处理方式
	 * 与渲染器的其余部分保持一致。
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * 渲染具有宽度感知单元格换行的表格。
	 * 不适应的单元格将换行为多行。
	 */
	private renderTable(
		token: Token & { header: any[]; rows: any[][]; raw?: string },
		availableWidth: number,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// 计算边框开销："│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// 太窄而无法渲染稳定的表格。回退到原始 markdown。
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			fallbackLines.push("");
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// 计算自然列宽（每列在没有约束的情况下需要的宽度）
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || []);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || []);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// 计算适应可用宽度的列宽
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// 所有内容都能自然适应
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// 需要缩小列以适应
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// 调整舍入误差 - 分配剩余空间
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// 渲染顶边框
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// 渲染带有换行的表头
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || []);
			return this.wrapCellText(text, columnWidths[i]);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// 渲染分隔符
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// 渲染带有换行的行
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || []);
				return this.wrapCellText(text, columnWidths[i]);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// 渲染底边框
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		lines.push(""); // 在表格后添加间距
		return lines;
	}
}

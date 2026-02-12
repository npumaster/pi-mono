import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

/**
 * 截断文本以适应视口宽度的 Text 组件
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {
		// 当前没有需要失效的缓存状态
	}

	render(width: number): string[] {
		const result: string[] = [];

		// 填充到宽度的空行
		const emptyLine = " ".repeat(width);

		// 在上方添加垂直内边距
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		// 计算水平内边距后的可用宽度
		const availableWidth = Math.max(1, width - this.paddingX * 2);

		// 仅提取第一行（在换行符处停止）
		let singleLineText = this.text;
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		// 如果需要，则截断文本（考虑 ANSI 代码）
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// 添加水平内边距
		const leftPadding = " ".repeat(this.paddingX);
		const rightPadding = " ".repeat(this.paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// 将行填充为恰好宽度个字符
		const lineVisibleWidth = visibleWidth(lineWithPadding);
		const paddingNeeded = Math.max(0, width - lineVisibleWidth);
		const finalLine = lineWithPadding + " ".repeat(paddingNeeded);

		result.push(finalLine);

		// 在下方添加垂直内边距
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		return result;
	}
}

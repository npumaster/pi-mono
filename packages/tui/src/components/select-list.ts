import { getEditorKeybindings } from "../keybindings.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	private maxVisible: number = 5;
	private theme: SelectListTheme;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
	}

	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// 过滤器更改时重置选择
		this.selectedIndex = 0;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate(): void {
		// 当前没有需要失效的缓存状态
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// 如果没有项目匹配过滤器，则显示消息
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching commands"));
			return lines;
		}

		// 计算带有滚动的可见范围
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// 渲染可见项目
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;

			let line = "";
			if (isSelected) {
				// 使用箭头指示器表示选中项 - 整行使用 selectedText 颜色
				const prefixWidth = 2; // "→ " 在视觉上占 2 个字符
				const displayValue = item.label || item.value;

				if (descriptionSingleLine && width > 40) {
					// 计算值 + 描述所占用的空间
					const maxValueWidth = Math.min(30, width - prefixWidth - 4);
					const truncatedValue = truncateToWidth(displayValue, maxValueWidth, "");
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));

					// 使用可见宽度计算描述的剩余空间
					const descriptionStart = prefixWidth + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2; // -2 用于安全缓冲

					if (remainingWidth > 10) {
						const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
						// 将 selectedText 应用于整行内容
						line = this.theme.selectedText(`→ ${truncatedValue}${spacing}${truncatedDesc}`);
					} else {
						// 描述空间不足
						const maxWidth = width - prefixWidth - 2;
						line = this.theme.selectedText(`→ ${truncateToWidth(displayValue, maxWidth, "")}`);
					}
				} else {
					// 无描述或宽度不足
					const maxWidth = width - prefixWidth - 2;
					line = this.theme.selectedText(`→ ${truncateToWidth(displayValue, maxWidth, "")}`);
				}
			} else {
				const displayValue = item.label || item.value;
				const prefix = "  ";

				if (descriptionSingleLine && width > 40) {
					// 计算值 + 描述所占用的空间
					const maxValueWidth = Math.min(30, width - prefix.length - 4);
					const truncatedValue = truncateToWidth(displayValue, maxValueWidth, "");
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));

					// 计算描述的剩余空间
					const descriptionStart = prefix.length + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2; // -2 用于安全缓冲

					if (remainingWidth > 10) {
						const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
						const descText = this.theme.description(spacing + truncatedDesc);
						line = prefix + truncatedValue + descText;
					} else {
						// 描述空间不足
						const maxWidth = width - prefix.length - 2;
						line = prefix + truncateToWidth(displayValue, maxWidth, "");
					}
				} else {
					// 无描述或宽度不足
					const maxWidth = width - prefix.length - 2;
					line = prefix + truncateToWidth(displayValue, maxWidth, "");
				}
			}

			lines.push(line);
		}

		// 如果需要，添加滚动指示器
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// 如果对于终端来说太长，则进行截断
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		// 上箭头 - 在顶部时循环到底部
		if (kb.matches(keyData, "selectUp")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.notifySelectionChange();
		}
		// 下箭头 - 在底部时循环到顶部
		else if (kb.matches(keyData, "selectDown")) {
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.notifySelectionChange();
		}
		// 回车
		else if (kb.matches(keyData, "selectConfirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape 或 Ctrl+C
		else if (kb.matches(keyData, "selectCancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}

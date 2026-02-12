/**
 * 具有差异化渲染的最小 TUI 实现
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isKeyRelease, matchesKey } from "./keys.js";
import type { Terminal } from "./terminal.js";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.js";
import { extractSegments, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.js";

/**
 * 组件接口 - 所有组件都必须实现此接口
 */
export interface Component {
	/**
	 * 为给定的视口宽度将组件渲染为行
	 * @param width - 当前视口宽度
	 * @returns 字符串数组，每个字符串代表一行
	 */
	render(width: number): string[];

	/**
	 * 当组件获得焦点时，键盘输入的可选处理器
	 */
	handleInput?(data: string): void;

	/**
	 * 如果为 true，组件将接收键释放事件（Kitty 协议）。
	 * 默认为 false - 释放事件会被过滤掉。
	 */
	wantsKeyRelease?: boolean;

	/**
	 * 使任何缓存的渲染状态失效。
	 * 当主题更改或组件需要从头开始重新渲染时调用。
	 */
	invalidate(): void;
}

/**
 * 可以接收焦点并显示硬件光标的组件接口。
 * 获得焦点时，组件应在其渲染输出中的光标位置发出 CURSOR_MARKER。
 * TUI 将找到此标记并在该处放置硬件光标，以便正确定位 IME 候选窗口。
 */
export interface Focusable {
	/** 由 TUI 在焦点更改时设置。当为 true 时，组件应发出 CURSOR_MARKER。 */
	focused: boolean;
}

/** 用于检查组件是否实现 Focusable 的类型守卫 */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * 光标位置标记 - APC (Application Program Command) 序列。
 * 这是一个终端忽略的零宽转义序列。
 * 组件在获得焦点时在光标位置发出此标记。
 * TUI 找到并剥离此标记，然后将硬件光标定位在该处。
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * 叠加层的锚点位置
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * 叠加层的边距配置
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** 可以是绝对值（数字）或百分比（如 "50%" 的字符串）的值 */
export type SizeValue = number | `${number}%`;

/** 给定参考大小，将 SizeValue 解析为绝对值 */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// 解析百分比字符串，如 "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * 叠加层定位和大小的选项。
 * 值可以是绝对数字或百分比字符串（例如 "50%"）。
 */
export interface OverlayOptions {
	// === 尺寸 ===
	/** 以列为单位的宽度，或终端宽度的百分比（例如 "50%"） */
	width?: SizeValue;
	/** 以列为单位的最小宽度 */
	minWidth?: number;
	/** 以行为单位的最大高度，或终端高度的百分比（例如 "50%"） */
	maxHeight?: SizeValue;

	// === 定位 - 基于锚点 ===
	/** 定位的锚点（默认：'center'） */
	anchor?: OverlayAnchor;
	/** 相对于锚点位置的水平偏移（正值 = 向右） */
	offsetX?: number;
	/** 相对于锚点位置的垂直偏移（正值 = 向下） */
	offsetY?: number;

	// === 定位 - 百分比或绝对值 ===
	/** 行位置：绝对数字，或百分比（例如 "25%" = 距离顶部 25%） */
	row?: SizeValue;
	/** 列位置：绝对数字，或百分比（例如 "50%" = 水平居中） */
	col?: SizeValue;

	// === 距离终端边缘的边距 ===
	/** 距离终端边缘的边距。数字适用于所有侧面。 */
	margin?: OverlayMargin | number;

	// === 可见性 ===
	/**
	 * 根据终端尺寸控制叠加层的可见性。
	 * 如果提供，则仅在此函数返回 true 时渲染叠加层。
	 * 在每个渲染周期使用当前终端尺寸调用。
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
}

/**
 * showOverlay 返回的用于控制叠加层的句柄
 */
export interface OverlayHandle {
	/** 永久移除叠加层（无法再次显示） */
	hide(): void;
	/** 临时隐藏或显示叠加层 */
	setHidden(hidden: boolean): void;
	/** 检查叠加层是否被临时隐藏 */
	isHidden(): boolean;
}

/**
 * 容器 - 包含其他组件的组件
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

/**
 * TUI - 管理具有差异化渲染的终端 UI 的主类
 */
export class TUI extends Container {
	public terminal: Terminal;
	private previousLines: string[] = [];
	private previousWidth = 0;
	private focusedComponent: Component | null = null;

	/** 调试键 (Shift+Ctrl+D) 的全局回调。在输入转发到聚焦组件之前调用。 */
	public onDebug?: () => void;
	private renderRequested = false;
	private cursorRow = 0; // 逻辑光标行（渲染内容的末尾）
	private hardwareCursorRow = 0; // 实际终端光标行（由于 IME 定位可能有所不同）
	private inputBuffer = ""; // 用于解析终端响应的缓冲区
	private cellSizeQueryPending = false;
	private showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1"; // 当内容收缩时清除空行（默认：关闭）
	private maxLinesRendered = 0; // 跟踪终端的工作区域（曾渲染过的最大行数）
	private previousViewportTop = 0; // 跟踪之前的视口顶部，用于感知调整大小的光标移动
	private fullRedrawCount = 0;
	private stopped = false;

	// 叠加层栈，用于在基础内容之上渲染模态组件
	private overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * 设置当内容收缩时是否触发完整重新渲染。
	 * 当为 true（默认）时，内容收缩时会清除空行。
	 * 当为 false 时，空行保留（减少慢速终端上的重绘）。
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	setFocus(component: Component | null): void {
		// 清除旧组件上的聚焦标志
		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = component;

		// 设置新组件上的聚焦标志
		if (isFocusable(component)) {
			component.focused = true;
		}
	}

	/**
	 * 显示具有可配置定位和尺寸的叠加层组件。
	 * 返回用于控制叠加层可见性的句柄。
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry = { component, options, preFocus: this.focusedComponent, hidden: false };
		this.overlayStack.push(entry);
		// 仅当叠加层实际可见时才聚焦
		if (this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// 返回用于控制此叠加层的句柄
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// 如果此叠加层拥有焦点，则恢复焦点
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// 隐藏/显示时更新焦点
				if (hidden) {
					// 如果此叠加层拥有焦点，则将焦点移至下一个可见叠加层或 preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// 显示时恢复此叠加层的焦点（如果它实际可见）
					if (this.isOverlayVisible(entry)) {
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	/** 隐藏最顶层的叠加层并恢复之前的焦点。 */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		// 查找最顶层的可见叠加层，或回退到 preFocus
		const topVisible = this.getTopmostVisibleOverlay();
		this.setFocus(topVisible?.component ?? overlay.preFocus);
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** 检查是否有任何可见的叠加层 */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** 检查叠加层条目当前是否可见 */
	private isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** 查找最顶层的可见叠加层（如果有） */
	private getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.stopped = false;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.queryCellSize();
		this.requestRender();
	}

	private queryCellSize(): void {
		// 仅当终端支持图像时才查询（单元格大小仅用于图像渲染）
		if (!getCapabilities().images) {
			return;
		}
		// 向终端查询以像素为单位的单元格大小：CSI 16 t
		// 响应格式：CSI 6 ; height ; width t
		this.cellSizeQueryPending = true;
		this.terminal.write("\x1b[16t");
	}

	stop(): void {
		this.stopped = true;
		// 将光标移至内容的末尾，以防止退出时出现覆盖/残留
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // 最后一行内容之后的一行
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(force = false): void {
		if (force) {
			this.previousLines = [];
			this.previousWidth = -1; // -1 触发 widthChanged，强制全量清除
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => {
			this.renderRequested = false;
			this.doRender();
		});
	}

	private handleInput(data: string): void {
		// 如果我们正在等待单元格大小响应，则缓冲输入并解析
		if (this.cellSizeQueryPending) {
			this.inputBuffer += data;
			const filtered = this.parseCellSizeResponse();
			if (filtered.length === 0) return;
			data = filtered;
		}

		// 全局调试键处理器 (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// 如果聚焦的组件是叠加层，请验证它是否仍然可见
		// （可见性可能会由于终端调整大小或 visible() 回调而改变）
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// 聚焦的叠加层不再可见，重定向到最顶层的可见叠加层
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// 没有可见的叠加层，恢复到 preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// 将输入传递给聚焦组件（包括 Ctrl+C）
		// 聚焦组件可以决定如何处理 Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// 过滤掉键释放事件，除非组件选择接收
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	private parseCellSizeResponse(): string {
		// 响应格式：ESC [ 6 ; height ; width t
		// 匹配响应模式
		const responsePattern = /\x1b\[6;(\d+);(\d+)t/;
		const match = this.inputBuffer.match(responsePattern);

		if (match) {
			const heightPx = parseInt(match[1], 10);
			const widthPx = parseInt(match[2], 10);

			if (heightPx > 0 && widthPx > 0) {
				setCellDimensions({ widthPx, heightPx });
				// 使所有组件失效，以便图像以正确的尺寸重新渲染
				this.invalidate();
				this.requestRender();
			}

			// 从缓冲区中移除响应
			this.inputBuffer = this.inputBuffer.replace(responsePattern, "");
			this.cellSizeQueryPending = false;
		}

		// 检查是否有部分单元格大小响应开始（等待更多数据）
		// 可能是不完整的单元格大小响应的模式：\x1b, \x1b[, \x1b[6, \x1b[6;...(尚未出现 t)
		const partialCellSizePattern = /\x1b(\[6?;?[\d;]*)?$/;
		if (partialCellSizePattern.test(this.inputBuffer)) {
			// 检查它是否实际上是一个完整的不同转义序列（以字母结尾）
			// 单元格大小响应以 't' 结尾，Kitty 键盘以 'u' 结尾，箭头以 A-D 结尾等。
			const lastChar = this.inputBuffer[this.inputBuffer.length - 1];
			if (!/[a-zA-Z~]/.test(lastChar)) {
				// 不以终止符结尾，可能不完整 - 等待更多
				return "";
			}
		}

		// 未找到单元格大小响应，将缓冲的数据作为用户输入返回
		const result = this.inputBuffer;
		this.inputBuffer = "";
		this.cellSizeQueryPending = false; // 放弃等待
		return result;
	}

	/**
	 * 从选项中解析叠加层布局。
	 * 返回用于渲染的 { width, row, col, maxHeight }。
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// 解析边距（限制为非负数）
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// 边距后的可用空间
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === 解析宽度 ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// 应用最小宽度
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// 限制在可用空间内
		width = Math.max(1, Math.min(width, availWidth));

		// === 解析最大高度 ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// 限制在可用空间内
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// 有效的叠加层高度（可能受 maxHeight 限制）
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === 解析位置 ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// 百分比：0% = 顶部，100% = 底部（叠加层保持在边界内）
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// 格式无效，回退到居中
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// 绝对行位置
				row = opt.row;
			}
		} else {
			// 基于锚点（默认：居中）
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// 百分比：0% = 左侧，100% = 右侧（叠加层保持在边界内）
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// 格式无效，回退到居中
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// 绝对列位置
				col = opt.col;
			}
		} else {
			// 基于锚点（默认：居中）
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// 应用偏移量
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// 限制在终端边界内（尊重边距）
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** 将所有叠加层合成到内容行中（按栈顺序，后者在上）。 */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// 预渲染所有可见叠加层并计算位置
		const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		for (const entry of this.overlayStack) {
			// 跳过不可见叠加层（隐藏或 visible() 返回 false）
			if (!this.isOverlayVisible(entry)) continue;

			const { component, options } = entry;

			// 首先获取 height=0 的布局以确定 width 和 maxHeight
			// （width 和 maxHeight 不依赖于叠加层高度）
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// 以计算出的宽度渲染组件
			let overlayLines = component.render(width);

			// 如果指定了 maxHeight，则应用它
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// 获取具有实际叠加层高度的最终 row/col
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// 确保结果覆盖终端工作区域，以在调整大小时保持叠加层定位稳定。
		// maxLinesRendered 在收缩后可能超过当前内容长度；填充以保持 viewportStart 一致。
		const workingHeight = Math.max(this.maxLinesRendered, minLinesNeeded);

		// 如果内容太短，无法放置叠加层或工作区域，则用空行扩展结果
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// 跟踪哪些行被修改，用于最终验证
		const modifiedLines = new Set<number>();

		// 合成每个叠加层
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// 防御性：在合成之前将叠加层行截断为声明的宽度
					// （组件应该已经遵守宽度，但这可以确保它）
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
					modifiedLines.add(idx);
				}
			}
		}

		// 最终验证：确保没有合成行超过终端宽度
		// 这是一个额外的安全保障 - compositeLineAt 应该已经保证了这一点，
		// 但我们在这里进行验证以防止任何边缘情况导致崩溃。
		// 仅检查实际修改过的行（优化）
		for (const idx of modifiedLines) {
			const lineWidth = visibleWidth(result[idx]);
			if (lineWidth > termWidth) {
				result[idx] = sliceByColumn(result[idx], 0, termWidth, true);
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	private applyLineResets(lines: string[]): string[] {
		const reset = TUI.SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = line + reset;
			}
		}
		return lines;
	}

	/** 将叠加层内容拼接到特定列的基础行中。单次处理优化。 */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// 单次处理基础行，同时提取“前”和“后”段
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// 提取具有宽度跟踪的叠加层（strict=true 以排除边界处的宽字符）
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// 将段填充到目标宽度
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// 组合结果
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// 重要：始终验证并截断为终端宽度。
		// 这是防止宽度溢出导致 TUI 崩溃的最后一道防线。
		// 宽度跟踪可能由于以下原因与实际可见宽度产生偏差：
		// - 复杂的 ANSI/OSC 序列（超链接、颜色）
		// - 段边界处的宽字符
		// - 段提取中的边缘情况
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// 使用 strict=true 截断，以确保不超过 totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * 从渲染的行中查找并提取光标位置。
	 * 搜索 CURSOR_MARKER，计算其位置，并从输出中剥离它。
	 * 仅扫描底部终端高度行（可见视口）。
	 * @param lines - 要搜索的渲染行
	 * @param height - 终端高度（可见视口大小）
	 * @returns 光标位置 { row, col }，如果未找到标记则返回 null
	 */
	private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// 仅扫描底部 `height` 行（可见视口）
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// 计算视觉列（标记前的文本宽度）
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// 从行中剥离标记
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	private doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		let viewportTop = Math.max(0, this.maxLinesRendered - height);
		let prevViewportTop = this.previousViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// 渲染所有组件以获取新行
		let newLines = this.render(width);

		// 将叠加层合成到渲染的行中（在差异比较之前）
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// 在应用行重置之前提取光标位置（必须先找到标记）
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// 宽度已更改 - 需要完整重新渲染（行换行发生变化）
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;

		// 清除回滚和视口并渲染所有新行的辅助函数
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h"; // 开始同步输出
			if (clear) buffer += "\x1b[3J\x1b[2J\x1b[H"; // 清除回滚、屏幕并复位光标
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // 结束同步输出
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// 清除时重置最大行数，否则跟踪增长
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.appendFileSync(logPath, msg);
		};

		// 首次渲染 - 直接输出所有内容而不清除（假设屏幕是干净的）
		if (this.previousLines.length === 0 && !widthChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// 宽度已更改 - 完整重新渲染（行换行发生变化）
		if (widthChanged) {
			logRedraw(`width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// 内容收缩到工作区域以下且没有叠加层 - 重新渲染以清除空行
		// （叠加层需要填充，因此仅在没有激活的叠加层时才执行此操作）
		// 可通过 setClearOnShrink() 或 PI_CLEAR_ON_SHRINK=0 环境变量进行配置
		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// 查找第一行和最后一行更改的行
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// 无更改 - 但如果硬件光标移动了，仍需要更新其位置
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			return;
		}

		// 所有更改都在删除的行中（无需渲染，只需清除）
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				// 移至新内容的末尾（空内容限制为 0）
				const targetRow = Math.max(0, newLines.length - 1);
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// 清除多余行而不滚动
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				if (extraLines > 0) {
					buffer += "\x1b[1B";
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				if (extraLines > 0) {
					buffer += `\x1b[${extraLines}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
			this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);
			return;
		}

		// 检查 firstChanged 是否在之前可见的范围之上
		// 使用 previousLines.length（而非 maxLinesRendered）以避免内容收缩后的误报
		const previousContentViewportTop = Math.max(0, this.previousLines.length - height);
		if (firstChanged < previousContentViewportTop) {
			// 第一次更改在之前的视口之上 - 需要完整重新渲染
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${previousContentViewportTop})`);
			fullRender(true);
			return;
		}

		// 从第一个更改的行渲染到末尾
		// 构建包含所有更新并包裹在同步输出中的缓冲区
		let buffer = "\x1b[?2026h"; // 开始同步输出
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// 将光标移至第一个更改的行（使用 hardwareCursorRow 表示实际位置）
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // 向下移动
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // 向上移动
		}

		buffer += appendStart ? "\r\n" : "\r"; // 移至第 0 列

		// 仅渲染更改的行（firstChanged 到 lastChanged），而不是渲染到末尾的所有行
		// 这可以减少只有单行更改时的闪烁（例如：微调器动画）
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K"; // 清除当前行
			const line = newLines[i];
			const isImage = isImageLine(line);
			if (!isImage && visibleWidth(line) > width) {
				// 将所有行记录到崩溃文件中以便调试
				const crashLogPath = path.join(os.homedir(), ".pi", "agent", "pi-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// 在抛出错误前清理终端状态
				this.stop();

				const errorMsg = [
					`渲染行 ${i} 超过终端宽度 (${visibleWidth(line)} > ${width})。`,
					"",
					"这可能是由于自定义 TUI 组件未截断其输出造成的。",
					"使用 visibleWidth() 进行测量，并使用 truncateToWidth() 截断行。",
					"",
					`调试日志已写入：${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			buffer += line;
		}

		// 跟踪渲染后光标所在的位置
		let finalCursorRow = renderEnd;

		// 如果之前有更多行，清除它们并将光标移回
		if (this.previousLines.length > newLines.length) {
			// 如果我们在新内容之前停止，先移至新内容的末尾
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// 将光标移回新内容的末尾
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // 结束同步输出

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// 一次性写入整个缓冲区
		this.terminal.write(buffer);

		// 跟踪下次渲染的光标位置
		// cursorRow 跟踪内容的末尾（用于视口计算）
		// hardwareCursorRow 跟踪实际终端光标位置（用于移动）
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// 跟踪终端的工作区域（增长但不收缩，除非清除）
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(0, this.maxLinesRendered - height);

		// 为 IME 定位硬件光标
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousWidth = width;
	}

	/**
	 * 为 IME 候选窗口定位硬件光标。
	 * @param cursorPos 从渲染输出中提取的光标位置，或为 null
	 * @param totalLines 渲染的总行数
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// 将光标位置限制在有效范围内
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// 将光标从当前位置移至目标位置
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // 向下移动
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // 向上移动
		}
		// 移至绝对列（从 1 开始计数）
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}

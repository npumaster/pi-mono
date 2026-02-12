import {
	getCapabilities,
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
} from "../terminal-image.js";
import type { Component } from "../tui.js";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Kitty 图像 ID。如果提供，将重用此 ID（用于动画/更新）。 */
	imageId?: number;
}

export class Image implements Component {
	private base64Data: string;
	private mimeType: string;
	private dimensions: ImageDimensions;
	private theme: ImageTheme;
	private options: ImageOptions;
	private imageId?: number;

	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.imageId = options.imageId;
	}

	/** 获取此图像使用的 Kitty 图像 ID（如果有）。 */
	getImageId(): number | undefined {
		return this.imageId;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const maxWidth = Math.min(width - 2, this.options.maxWidthCells ?? 60);

		const caps = getCapabilities();
		let lines: string[];

		if (caps.images) {
			const result = renderImage(this.base64Data, this.dimensions, {
				maxWidthCells: maxWidth,
				imageId: this.imageId,
			});

			if (result) {
				// 存储图像 ID 以备后续清理
				if (result.imageId) {
					this.imageId = result.imageId;
				}

				// 返回 `rows` 行，以便 TUI 考虑图像高度
				// 前 (rows-1) 行是空的（TUI 会清除它们）
				// 最后一行：将光标移回上方，然后输出图像序列
				lines = [];
				for (let i = 0; i < result.rows - 1; i++) {
					lines.push("");
				}
				// 将光标移回第一行，然后输出图像
				const moveUp = result.rows > 1 ? `\x1b[${result.rows - 1}A` : "";
				lines.push(moveUp + result.sequence);
			} else {
				const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
				lines = [this.theme.fallbackColor(fallback)];
			}
		} else {
			const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
			lines = [this.theme.fallbackColor(fallback)];
		}

		this.cachedLines = lines;
		this.cachedWidth = width;

		return lines;
	}
}

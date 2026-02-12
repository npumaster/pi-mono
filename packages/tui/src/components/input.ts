import { getEditorKeybindings } from "../keybindings.js";
import { KillRing } from "../kill-ring.js";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui.js";
import { UndoStack } from "../undo-stack.js";
import { getSegmenter, isPunctuationChar, isWhitespaceChar, visibleWidth } from "../utils.js";

const segmenter = getSegmenter();

interface InputState {
	value: string;
	cursor: number;
}

/**
 * Input 组件 - 带有水平滚动的单行文本输入
 */
export class Input implements Component, Focusable {
	private value: string = "";
	private cursor: number = 0; // 值中的光标位置
	public onSubmit?: (value: string) => void;
	public onEscape?: () => void;

	/** Focusable 接口 - 当焦点改变时由 TUI 设置 */
	focused: boolean = false;

	// 括号粘贴模式（Bracketed paste mode）缓冲
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// 用于 Emacs 风格删除/粘贴操作的 Kill ring
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// 撤销支持
	private undoStack = new UndoStack<InputState>();

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}

	handleInput(data: string): void {
		// 处理括号粘贴模式
		// 粘贴开始：\x1b[200~
		// 粘贴结束：\x1b[201~

		// 检查是否正在开始括号粘贴
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		// 如果处于粘贴中，缓冲数据
		if (this.isInPaste) {
			// 检查此块是否包含结束标记
			this.pasteBuffer += data;

			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				// 提取粘贴的内容
				const pasteContent = this.pasteBuffer.substring(0, endIndex);

				// 处理完整的粘贴
				this.handlePaste(pasteContent);

				// 重置粘贴状态
				this.isInPaste = false;

				// 处理粘贴标记后的任何剩余输入
				const remaining = this.pasteBuffer.substring(endIndex + 6); // 6 = \x1b[201~ 的长度
				this.pasteBuffer = "";
				if (remaining) {
					this.handleInput(remaining);
				}
			}
			return;
		}

		const kb = getEditorKeybindings();

		// 退出/取消
		if (kb.matches(data, "selectCancel")) {
			if (this.onEscape) this.onEscape();
			return;
		}

		// 撤销
		if (kb.matches(data, "undo")) {
			this.undo();
			return;
		}

		// 提交
		if (kb.matches(data, "submit") || data === "\n") {
			if (this.onSubmit) this.onSubmit(this.value);
			return;
		}

		// 删除
		if (kb.matches(data, "deleteCharBackward")) {
			this.handleBackspace();
			return;
		}

		if (kb.matches(data, "deleteCharForward")) {
			this.handleForwardDelete();
			return;
		}

		if (kb.matches(data, "deleteWordBackward")) {
			this.deleteWordBackwards();
			return;
		}

		if (kb.matches(data, "deleteWordForward")) {
			this.deleteWordForward();
			return;
		}

		if (kb.matches(data, "deleteToLineStart")) {
			this.deleteToLineStart();
			return;
		}

		if (kb.matches(data, "deleteToLineEnd")) {
			this.deleteToLineEnd();
			return;
		}

		// Kill ring 操作
		if (kb.matches(data, "yank")) {
			this.yank();
			return;
		}
		if (kb.matches(data, "yankPop")) {
			this.yankPop();
			return;
		}

		// 光标移动
		if (kb.matches(data, "cursorLeft")) {
			this.lastAction = null;
			if (this.cursor > 0) {
				const beforeCursor = this.value.slice(0, this.cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "cursorRight")) {
			this.lastAction = null;
			if (this.cursor < this.value.length) {
				const afterCursor = this.value.slice(this.cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "cursorLineStart")) {
			this.lastAction = null;
			this.cursor = 0;
			return;
		}

		if (kb.matches(data, "cursorLineEnd")) {
			this.lastAction = null;
			this.cursor = this.value.length;
			return;
		}

		if (kb.matches(data, "cursorWordLeft")) {
			this.moveWordBackwards();
			return;
		}

		if (kb.matches(data, "cursorWordRight")) {
			this.moveWordForwards();
			return;
		}

		// 普通字符输入 - 接受包括 Unicode 在内的可打印字符，
		// 但拒绝控制字符（C0: 0x00-0x1F, DEL: 0x7F, C1: 0x80-0x9F）
		const hasControlChars = [...data].some((ch) => {
			const code = ch.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		if (!hasControlChars) {
			this.insertCharacter(data);
		}
	}

	private insertCharacter(char: string): void {
		// 撤销合并：连续的单词字符合并为一个撤销单元
		if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
			this.pushUndo();
		}
		this.lastAction = "type-word";

		this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor);
		this.cursor += char.length;
	}

	private handleBackspace(): void {
		this.lastAction = null;
		if (this.cursor > 0) {
			this.pushUndo();
			const beforeCursor = this.value.slice(0, this.cursor);
			const graphemes = [...segmenter.segment(beforeCursor)];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor);
			this.cursor -= graphemeLength;
		}
	}

	private handleForwardDelete(): void {
		this.lastAction = null;
		if (this.cursor < this.value.length) {
			this.pushUndo();
			const afterCursor = this.value.slice(this.cursor);
			const graphemes = [...segmenter.segment(afterCursor)];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + graphemeLength);
		}
	}

	private deleteToLineStart(): void {
		if (this.cursor === 0) return;
		this.pushUndo();
		const deletedText = this.value.slice(0, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(this.cursor);
		this.cursor = 0;
	}

	private deleteToLineEnd(): void {
		if (this.cursor >= this.value.length) return;
		this.pushUndo();
		const deletedText = this.value.slice(this.cursor);
		this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(0, this.cursor);
	}

	private deleteWordBackwards(): void {
		if (this.cursor === 0) return;

		// 在光标移动前保存 lastAction（moveWordBackwards 会重置它）
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordBackwards();
		const deleteFrom = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(deleteFrom, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, deleteFrom) + this.value.slice(this.cursor);
		this.cursor = deleteFrom;
	}

	private deleteWordForward(): void {
		if (this.cursor >= this.value.length) return;

		// 在光标移动前保存 lastAction（moveWordForwards 会重置它）
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordForwards();
		const deleteTo = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(this.cursor, deleteTo);
		this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, this.cursor) + this.value.slice(deleteTo);
	}

	private yank(): void {
		const text = this.killRing.peek();
		if (!text) return;

		this.pushUndo();

		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private yankPop(): void {
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndo();

		// 删除之前粘贴的文本（在旋转前仍在 ring 的末尾）
		const prevText = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor - prevText.length) + this.value.slice(this.cursor);
		this.cursor -= prevText.length;

		// 旋转并插入新条目
		this.killRing.rotate();
		const text = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private pushUndo(): void {
		this.undoStack.push({ value: this.value, cursor: this.cursor });
	}

	private undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.value = snapshot.value;
		this.cursor = snapshot.cursor;
		this.lastAction = null;
	}

	private moveWordBackwards(): void {
		if (this.cursor === 0) {
			return;
		}

		this.lastAction = null;
		const textBeforeCursor = this.value.slice(0, this.cursor);
		const graphemes = [...segmenter.segment(textBeforeCursor)];

		// 跳过末尾空白字符
		while (graphemes.length > 0 && isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "")) {
			this.cursor -= graphemes.pop()?.segment.length || 0;
		}

		if (graphemes.length > 0) {
			const lastGrapheme = graphemes[graphemes.length - 1]?.segment || "";
			if (isPunctuationChar(lastGrapheme)) {
				// 跳过连续标点符号
				while (graphemes.length > 0 && isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "")) {
					this.cursor -= graphemes.pop()?.segment.length || 0;
				}
			} else {
				// 跳过连续单词字符
				while (
					graphemes.length > 0 &&
					!isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "") &&
					!isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "")
				) {
					this.cursor -= graphemes.pop()?.segment.length || 0;
				}
			}
		}
	}

	private moveWordForwards(): void {
		if (this.cursor >= this.value.length) {
			return;
		}

		this.lastAction = null;
		const textAfterCursor = this.value.slice(this.cursor);
		const segments = segmenter.segment(textAfterCursor);
		const iterator = segments[Symbol.iterator]();
		let next = iterator.next();

		// 跳过开头的空白字符
		while (!next.done && isWhitespaceChar(next.value.segment)) {
			this.cursor += next.value.segment.length;
			next = iterator.next();
		}

		if (!next.done) {
			const firstGrapheme = next.value.segment;
			if (isPunctuationChar(firstGrapheme)) {
				// 跳过连续标点符号
				while (!next.done && isPunctuationChar(next.value.segment)) {
					this.cursor += next.value.segment.length;
					next = iterator.next();
				}
			} else {
				// 跳过连续单词字符
				while (!next.done && !isWhitespaceChar(next.value.segment) && !isPunctuationChar(next.value.segment)) {
					this.cursor += next.value.segment.length;
					next = iterator.next();
				}
			}
		}
	}

	private handlePaste(pastedText: string): void {
		this.lastAction = null;
		this.pushUndo();

		// 清理粘贴的文本 - 移除换行符和回车符
		const cleanText = pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "");

		// 在光标位置插入
		this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
		this.cursor += cleanText.length;
	}

	invalidate(): void {
		// 当前没有需要失效的缓存状态
	}

	render(width: number): string[] {
		// 计算可见窗口
		const prompt = "> ";
		const availableWidth = width - prompt.length;

		if (availableWidth <= 0) {
			return [prompt];
		}

		let visibleText = "";
		let cursorDisplay = this.cursor;

		if (this.value.length < availableWidth) {
			// 全部内容都能容纳（在末尾为光标预留空间）
			visibleText = this.value;
		} else {
			// 需要水平滚动
			// 如果光标在末尾，则预留一个字符空间
			const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
			const halfWidth = Math.floor(scrollWidth / 2);

			const findValidStart = (start: number) => {
				while (start < this.value.length) {
					const charCode = this.value.charCodeAt(start);
					// 这是低位代理项，不是有效的起始位置
					if (charCode >= 0xdc00 && charCode < 0xe000) {
						start++;
						continue;
					}
					break;
				}
				return start;
			};

			const findValidEnd = (end: number) => {
				while (end > 0) {
					const charCode = this.value.charCodeAt(end - 1);
					// 这是高位代理项，可能会被分割
					if (charCode >= 0xd800 && charCode < 0xdc00) {
						end--;
						continue;
					}
					break;
				}
				return end;
			};

			if (this.cursor < halfWidth) {
				// 光标靠近开头
				visibleText = this.value.slice(0, findValidEnd(scrollWidth));
				cursorDisplay = this.cursor;
			} else if (this.cursor > this.value.length - halfWidth) {
				// 光标靠近末尾
				const start = findValidStart(this.value.length - scrollWidth);
				visibleText = this.value.slice(start);
				cursorDisplay = this.cursor - start;
			} else {
				// 光标在中间
				const start = findValidStart(this.cursor - halfWidth);
				visibleText = this.value.slice(start, findValidEnd(start + scrollWidth));
				cursorDisplay = halfWidth;
			}
		}

		// 构建带有虚拟光标的行
		// 在光标位置插入光标字符
		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? " "; // 光标处的字符，如果在末尾则为空格
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// 硬件光标标记（零宽，在虚拟光标前发出，用于 IME 定位）
		const marker = this.focused ? CURSOR_MARKER : "";

		// 使用反色显示光标
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`; // ESC[7m = 反色, ESC[27m = 正常
		const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;

		// 计算视觉宽度
		const visualLength = visibleWidth(textWithCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + padding;

		return [line];
	}
}

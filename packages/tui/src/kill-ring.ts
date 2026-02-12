/**
 * 用于 Emacs 风格的剪切/粘贴（kill/yank）操作的环形缓冲区。
 *
 * 跟踪被剪切（删除）的文本条目。连续的剪切可以累积
 * 到单个条目中。支持粘贴（yank，粘贴最近的内容）和粘贴循环
 * （yank-pop，循环浏览较旧的条目）。
 */
export class KillRing {
	private ring: string[] = [];

	/**
	 * 将文本添加到剪切环。
	 *
	 * @param text - 要添加的被剪切文本
	 * @param opts - 推入选项
	 * @param opts.prepend - 如果是累积模式，是前置（向后删除）还是追加（向前删除）
	 * @param opts.accumulate - 与最近的条目合并，而不是创建新条目
	 */
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;

		if (opts.accumulate && this.ring.length > 0) {
			const last = this.ring.pop()!;
			this.ring.push(opts.prepend ? text + last : last + text);
		} else {
			this.ring.push(text);
		}
	}

	/** 获取最近的条目而不修改剪切环。 */
	peek(): string | undefined {
		return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
	}

	/** 将最后一个条目移到最前面（用于 yank-pop 循环）。 */
	rotate(): void {
		if (this.ring.length > 1) {
			const last = this.ring.pop()!;
			this.ring.unshift(last);
		}
	}

	get length(): number {
		return this.ring.length;
	}
}

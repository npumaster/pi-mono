import * as fs from "node:fs";
import { setKittyProtocolActive } from "./keys.js";
import { StdinBuffer } from "./stdin-buffer.js";

/**
 * TUI 的最小终端接口
 */
export interface Terminal {
	// 启动终端，设置输入和调整大小的处理程序
	start(onInput: (data: string) => void, onResize: () => void): void;

	// 停止终端并恢复状态
	stop(): void;

	/**
	 * 在退出前排空 stdin，以防止 Kitty 按键释放事件在缓慢的 SSH 连接上泄露到父 shell。
	 * @param maxMs - 最大排空时间（默认：1000ms）
	 * @param idleMs - 如果在此时间内没有输入到达，则提前退出（默认：50ms）
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// 向终端写入输出
	write(data: string): void;

	// 获取终端尺寸
	get columns(): number;
	get rows(): number;

	// Kitty 键盘协议是否处于活动状态
	get kittyProtocolActive(): boolean;

	// 光标定位（相对于当前位置）
	moveBy(lines: number): void; // 向上（负数）或向下（正数）移动光标 N 行

	// 光标可见性
	hideCursor(): void; // 隐藏光标
	showCursor(): void; // 显示光标

	// 清除操作
	clearLine(): void; // 清除当前行
	clearFromCursor(): void; // 从光标清除到屏幕末尾
	clearScreen(): void; // 清除整个屏幕并将光标移动到 (0,0)

	// 标题操作
	setTitle(title: string): void; // 设置终端窗口标题
}

/**
 * 使用 process.stdin/stdout 的真实终端
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private writeLogPath = process.env.PI_TUI_WRITE_LOG || "";

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// 保存之前的状态并启用原始模式
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// 启用括号粘贴模式 - 终端会将粘贴内容包裹在 \x1b[200~ ... \x1b[201~ 中
		process.stdout.write("\x1b[?2004h");

		// 立即设置调整大小处理器
		process.stdout.on("resize", this.resizeHandler);

		// 刷新终端尺寸 - 在挂起/恢复后它们可能会过期（进程停止时 SIGWINCH 会丢失）。仅限 Unix。
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// 查询并启用 Kitty 键盘协议
		// 查询处理器会临时拦截输入，然后安装用户的处理器
		// 参见：https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * 设置 StdinBuffer 以将批量输入拆分为单个序列。
	 * 这确保组件接收单个事件，使 matchesKey/isKeyRelease 正常工作。
	 *
	 * 同时监视 Kitty 协议响应并在检测到时启用它。
	 * 这是在这里（stdinBuffer 解析后）而不是在原始 stdin 上完成的，
	 * 以处理响应跨多个事件拆分到达的情况。
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Kitty 协议响应模式：\x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// 将单个序列转发给输入处理器
		this.stdinBuffer.on("data", (sequence) => {
			// 检查 Kitty 协议响应（仅当尚未启用时）
			if (!this._kittyProtocolActive) {
				const match = sequence.match(kittyResponsePattern);
				if (match) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);

					// 启用 Kitty 键盘协议（推送标志）
					// 标志 1 = 消除转义码歧义
					// 标志 2 = 报告事件类型（按下/重复/释放）
					// 标志 4 = 报告备用键（偏移键、基础布局键）
					// 基础布局键使快捷键能够处理非拉丁键盘布局
					process.stdout.write("\x1b[>7u");
					return; // 不要将协议响应转发给 TUI
				}
			}

			if (this.inputHandler) {
				this.inputHandler(sequence);
			}
		});

		// 使用括号粘贴标记重新包裹粘贴内容，以便现有编辑器处理
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// 通过缓冲区管道传输 stdin 数据的处理器
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * 查询终端对 Kitty 键盘协议的支持，如果可用则启用。
	 *
	 * 发送 CSI ? u 查询当前标志。如果终端响应 CSI ? <flags> u，
	 * 则它支持该协议，我们使用 CSI > 1 u 启用它。
	 *
	 * 响应在 setupStdinBuffer 的数据处理器中检测，该处理器正确
	 * 处理响应跨多个 stdin 事件拆分到达的情况。
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		process.stdout.write("\x1b[?u");
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this._kittyProtocolActive) {
			// 首先禁用 Kitty 键盘协议，以便任何延迟的键释放
			// 不会生成新的 Kitty 转义序列。
			process.stdout.write("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		// 禁用括号粘贴模式
		process.stdout.write("\x1b[?2004l");

		// 如果 drainInput() 尚未完成，则禁用 Kitty 键盘协议
		if (this._kittyProtocolActive) {
			process.stdout.write("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}

		// 清理 StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// 移除事件处理器
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// 暂停 stdin，以防止在禁用原始模式后重新解释任何缓冲输入（例如 Ctrl+D）。
		// 这修复了 Ctrl+D 可能在 SSH 上关闭父 shell 的竞态条件。
		process.stdin.pause();

		// 恢复原始模式状态
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		process.stdout.write(data);
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// 忽略日志错误
			}
		}
	}

	get columns(): number {
		return process.stdout.columns || 80;
	}

	get rows(): number {
		return process.stdout.rows || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// 向下移动
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// 向上移动
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: 无需移动
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // 清除屏幕并移动到 home 位置 (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - 设置终端窗口标题
		process.stdout.write(`\x1b]0;${title}\x07`);
	}
}

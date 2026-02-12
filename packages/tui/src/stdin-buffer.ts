/**
 * StdinBuffer 缓冲输入并发出完整的序列。
 *
 * 这是必要的，因为 stdin 数据事件可能以部分块的形式到达，
 * 特别是对于像鼠标事件这样的转义序列。如果没有缓冲，
 * 部分序列可能会被误解为常规按键。
 *
 * 例如，鼠标 SGR 序列 `\x1b[<35;20;5m` 可能按以下方式到达：
 * - 事件 1：`\x1b`
 * - 事件 2：`[<35`
 * - 事件 3：`;20;5m`
 *
 * 缓冲区会累积这些内容，直到检测到完整的序列。
 * 调用 `process()` 方法来输入数据。
 *
 * 基于 OpenTUI (https://github.com/anomalyco/opentui) 的代码
 * MIT 许可证 - 版权所有 (c) 2025 opentui
 */

import { EventEmitter } from "events";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * 检查字符串是完整的转义序列还是需要更多数据
 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI 序列：ESC [
	if (afterEsc.startsWith("[")) {
		// 检查旧式鼠标序列：ESC[M + 3 字节
		if (afterEsc.startsWith("[M")) {
			// 旧式鼠标需要 ESC[M + 3 字节 = 总共 6 字节
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC 序列：ESC ]
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS 序列：ESC P ... ESC \（包括 XTVersion 响应）
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC 序列：ESC _ ... ESC \（包括 Kitty 图形响应）
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// SS3 序列：ESC O
	if (afterEsc.startsWith("O")) {
		// ESC O 后跟单个字符
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta 键序列：ESC 后跟单个字符
	if (afterEsc.length === 1) {
		return "complete";
	}

	// 未知的转义序列 - 视为完整
	return "complete";
}

/**
 * 检查 CSI 序列是否完整
 * CSI 序列：ESC [ ... 后跟结束字节 (0x40-0x7E)
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// 至少需要 ESC [ 和一个额外字符
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI 序列以 0x40-0x7E (@-~) 范围内的字节结尾
	// 这包括所有字母和几个特殊字符
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// SGR 鼠标序列的特殊处理
		// 格式：ESC[<B;X;Ym 或 ESC[<B;X;YM
		if (payload.startsWith("<")) {
			// 必须具有格式：<数字;数字;数字[Mm]
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			if (mouseMatch) {
				return "complete";
			}
			// 如果以 M 或 m 结尾但不匹配模式，则仍不完整
			if (lastChar === "M" || lastChar === "m") {
				// 检查结构是否正确
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
					return "complete";
				}
			}

			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * 检查 OSC 序列是否完整
 * OSC 序列：ESC ] ... ST（其中 ST 是 ESC \ 或 BEL）
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC 序列以 ST (ESC \) 或 BEL (\x07) 结尾
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * 检查 DCS（设备控制字符串）序列是否完整
 * DCS 序列：ESC P ... ST（其中 ST 是 ESC \）
 * 用于 XTVersion 响应，例如 ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS 序列以 ST (ESC \) 结尾
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * 检查 APC（应用程序控制命令）序列是否完整
 * APC 序列：ESC _ ... ST（其中 ST 是 ESC \）
 * 用于 Kitty 图形响应，例如 ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC 序列以 ST (ESC \) 结尾
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * 将累积的缓冲区拆分为完整的序列
 */
function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		// 尝试从此位置开始提取序列
		if (remaining.startsWith(ESC)) {
			// 查找此转义序列的末尾
			let seqEnd = 1;
			while (seqEnd <= remaining.length) {
				const candidate = remaining.slice(0, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "complete") {
					sequences.push(candidate);
					pos += seqEnd;
					break;
				} else if (status === "incomplete") {
					seqEnd++;
				} else {
					// 以 ESC 开头时不应发生此情况
					sequences.push(candidate);
					pos += seqEnd;
					break;
				}
			}

			if (seqEnd > remaining.length) {
				return { sequences, remainder: remaining };
			}
		} else {
			// 不是转义序列 - 取单个字符
			sequences.push(remaining[0]!);
			pos++;
		}
	}

	return { sequences, remainder: "" };
}

export type StdinBufferOptions = {
	/**
	 * 等待序列完成的最长时间（默认：10ms）
	 * 超过此时间后，即使不完整也会刷新缓冲区
	 */
	timeout?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * 缓冲 stdin 输入并通过 'data' 事件发出完整的序列。
 * 处理跨多个数据块到达的部分转义序列。
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private pasteMode: boolean = false;
	private pasteBuffer: string = "";

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? 10;
	}

	public process(data: string | Buffer): void {
		// 清除任何待处理的超时
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// 处理高字节转换（为了与 parseKeypress 兼容）
		// 如果缓冲区有大于 127 的单字节，则转换为 ESC + (byte - 128)
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emit("data", "");
			return;
		}

		this.buffer += str;

		if (this.pasteMode) {
			this.pasteBuffer += this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.emit("data", sequence);
				}
			}

			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.emit("data", sequence);
		}

		if (this.buffer.length > 0) {
			this.timeout = setTimeout(() => {
				const flushed = this.flush();

				for (const sequence of flushed) {
					this.emit("data", sequence);
				}
			}, this.timeoutMs);
		}
	}

	flush(): string[] {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		return sequences;
	}

	clear(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.buffer = "";
		this.pasteMode = false;
		this.pasteBuffer = "";
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}

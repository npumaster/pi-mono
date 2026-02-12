import { type KeyId, matchesKey } from "./keys.js";

/**
 * 可绑定到按键的编辑器操作。
 */
export type EditorAction =
	// 光标移动
	| "cursorUp"
	| "cursorDown"
	| "cursorLeft"
	| "cursorRight"
	| "cursorWordLeft"
	| "cursorWordRight"
	| "cursorLineStart"
	| "cursorLineEnd"
	| "jumpForward"
	| "jumpBackward"
	| "pageUp"
	| "pageDown"
	// 删除
	| "deleteCharBackward"
	| "deleteCharForward"
	| "deleteWordBackward"
	| "deleteWordForward"
	| "deleteToLineStart"
	| "deleteToLineEnd"
	// 文本输入
	| "newLine"
	| "submit"
	| "tab"
	// 选择/自动补全
	| "selectUp"
	| "selectDown"
	| "selectPageUp"
	| "selectPageDown"
	| "selectConfirm"
	| "selectCancel"
	// 剪贴板
	| "copy"
	// 剪切环（Kill ring）
	| "yank"
	| "yankPop"
	// 撤销
	| "undo"
	// 工具输出
	| "expandTools"
	// 会话
	| "toggleSessionPath"
	| "toggleSessionSort"
	| "renameSession"
	| "deleteSession"
	| "deleteSessionNoninvasive";

// 从 keys.ts 重新导出 KeyId
export type { KeyId };

/**
 * 编辑器按键绑定配置。
 */
export type EditorKeybindingsConfig = {
	[K in EditorAction]?: KeyId | KeyId[];
};

/**
 * 默认编辑器按键绑定。
 */
export const DEFAULT_EDITOR_KEYBINDINGS: Required<EditorKeybindingsConfig> = {
	// 光标移动
	cursorUp: "up",
	cursorDown: "down",
	cursorLeft: ["left", "ctrl+b"],
	cursorRight: ["right", "ctrl+f"],
	cursorWordLeft: ["alt+left", "ctrl+left", "alt+b"],
	cursorWordRight: ["alt+right", "ctrl+right", "alt+f"],
	cursorLineStart: ["home", "ctrl+a"],
	cursorLineEnd: ["end", "ctrl+e"],
	jumpForward: "ctrl+]",
	jumpBackward: "ctrl+alt+]",
	pageUp: "pageUp",
	pageDown: "pageDown",
	// 删除
	deleteCharBackward: "backspace",
	deleteCharForward: ["delete", "ctrl+d"],
	deleteWordBackward: ["ctrl+w", "alt+backspace"],
	deleteWordForward: ["alt+d", "alt+delete"],
	deleteToLineStart: "ctrl+u",
	deleteToLineEnd: "ctrl+k",
	// 文本输入
	newLine: "shift+enter",
	submit: "enter",
	tab: "tab",
	// 选择/自动补全
	selectUp: "up",
	selectDown: "down",
	selectPageUp: "pageUp",
	selectPageDown: "pageDown",
	selectConfirm: "enter",
	selectCancel: ["escape", "ctrl+c"],
	// 剪贴板
	copy: "ctrl+c",
	// 剪切环（Kill ring）
	yank: "ctrl+y",
	yankPop: "alt+y",
	// 撤销
	undo: "ctrl+-",
	// 工具输出
	expandTools: "ctrl+o",
	// 会话
	toggleSessionPath: "ctrl+p",
	toggleSessionSort: "ctrl+s",
	renameSession: "ctrl+r",
	deleteSession: "ctrl+d",
	deleteSessionNoninvasive: "ctrl+backspace",
};

/**
 * 管理编辑器的按键绑定。
 */
export class EditorKeybindingsManager {
	private actionToKeys: Map<EditorAction, KeyId[]>;

	constructor(config: EditorKeybindingsConfig = {}) {
		this.actionToKeys = new Map();
		this.buildMaps(config);
	}

	private buildMaps(config: EditorKeybindingsConfig): void {
		this.actionToKeys.clear();

		// 从默认值开始
		for (const [action, keys] of Object.entries(DEFAULT_EDITOR_KEYBINDINGS)) {
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.actionToKeys.set(action as EditorAction, [...keyArray]);
		}

		// 使用用户配置覆盖
		for (const [action, keys] of Object.entries(config)) {
			if (keys === undefined) continue;
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.actionToKeys.set(action as EditorAction, keyArray);
		}
	}

	/**
	 * 检查输入是否匹配特定操作。
	 */
	matches(data: string, action: EditorAction): boolean {
		const keys = this.actionToKeys.get(action);
		if (!keys) return false;
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * 获取绑定到操作的按键。
	 */
	getKeys(action: EditorAction): KeyId[] {
		return this.actionToKeys.get(action) ?? [];
	}

	/**
	 * 更新配置。
	 */
	setConfig(config: EditorKeybindingsConfig): void {
		this.buildMaps(config);
	}
}

// 全局实例
let globalEditorKeybindings: EditorKeybindingsManager | null = null;

export function getEditorKeybindings(): EditorKeybindingsManager {
	if (!globalEditorKeybindings) {
		globalEditorKeybindings = new EditorKeybindingsManager();
	}
	return globalEditorKeybindings;
}

export function setEditorKeybindings(manager: EditorKeybindingsManager): void {
	globalEditorKeybindings = manager;
}

import {
	DEFAULT_EDITOR_KEYBINDINGS,
	type EditorAction,
	type EditorKeybindingsConfig,
	EditorKeybindingsManager,
	type KeyId,
	matchesKey,
	setEditorKeybindings,
} from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.js";

/**
 * 应用程序级操作（编码代理特定）。
 */
export type AppAction =
	| "interrupt"
	| "clear"
	| "exit"
	| "suspend"
	| "cycleThinkingLevel"
	| "cycleModelForward"
	| "cycleModelBackward"
	| "selectModel"
	| "expandTools"
	| "toggleThinking"
	| "toggleSessionNamedFilter"
	| "externalEditor"
	| "followUp"
	| "dequeue"
	| "pasteImage"
	| "newSession"
	| "tree"
	| "fork"
	| "resume";

/**
 * 所有可配置的操作。
 */
export type KeyAction = AppAction | EditorAction;

/**
 * 完整的键绑定配置（应用程序 + 编辑器操作）。
 */
export type KeybindingsConfig = {
	[K in KeyAction]?: KeyId | KeyId[];
};

/**
 * 默认应用程序键绑定。
 */
export const DEFAULT_APP_KEYBINDINGS: Record<AppAction, KeyId | KeyId[]> = {
	interrupt: "escape",
	clear: "ctrl+c",
	exit: "ctrl+d",
	suspend: "ctrl+z",
	cycleThinkingLevel: "shift+tab",
	cycleModelForward: "ctrl+p",
	cycleModelBackward: "shift+ctrl+p",
	selectModel: "ctrl+l",
	expandTools: "ctrl+o",
	toggleThinking: "ctrl+t",
	toggleSessionNamedFilter: "ctrl+n",
	externalEditor: "ctrl+g",
	followUp: "alt+enter",
	dequeue: "alt+up",
	pasteImage: "ctrl+v",
	newSession: [],
	tree: [],
	fork: [],
	resume: [],
};

/**
 * 所有默认键绑定（应用程序 + 编辑器）。
 */
export const DEFAULT_KEYBINDINGS: Required<KeybindingsConfig> = {
	...DEFAULT_EDITOR_KEYBINDINGS,
	...DEFAULT_APP_KEYBINDINGS,
};

// 用于类型检查的应用程序操作列表
const APP_ACTIONS: AppAction[] = [
	"interrupt",
	"clear",
	"exit",
	"suspend",
	"cycleThinkingLevel",
	"cycleModelForward",
	"cycleModelBackward",
	"selectModel",
	"expandTools",
	"toggleThinking",
	"toggleSessionNamedFilter",
	"externalEditor",
	"followUp",
	"dequeue",
	"pasteImage",
	"newSession",
	"tree",
	"fork",
	"resume",
];

function isAppAction(action: string): action is AppAction {
	return APP_ACTIONS.includes(action as AppAction);
}

/**
 * 管理所有键绑定（应用程序 + 编辑器）。
 */
export class KeybindingsManager {
	private config: KeybindingsConfig;
	private appActionToKeys: Map<AppAction, KeyId[]>;

	private constructor(config: KeybindingsConfig) {
		this.config = config;
		this.appActionToKeys = new Map();
		this.buildMaps();
	}

	/**
	 * 从配置文件创建并设置编辑器键绑定。
	 */
	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const configPath = join(agentDir, "keybindings.json");
		const config = KeybindingsManager.loadFromFile(configPath);
		const manager = new KeybindingsManager(config);

		// 全局设置编辑器键绑定
		// 包括编辑器操作和 expandTools（应用程序和编辑器之间共享）
		const editorConfig: EditorKeybindingsConfig = {};
		for (const [action, keys] of Object.entries(config)) {
			if (!isAppAction(action) || action === "expandTools") {
				editorConfig[action as EditorAction] = keys;
			}
		}
		setEditorKeybindings(new EditorKeybindingsManager(editorConfig));

		return manager;
	}

	/**
	 * 在内存中创建。
	 */
	static inMemory(config: KeybindingsConfig = {}): KeybindingsManager {
		return new KeybindingsManager(config);
	}

	private static loadFromFile(path: string): KeybindingsConfig {
		if (!existsSync(path)) return {};
		try {
			return JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return {};
		}
	}

	private buildMaps(): void {
		this.appActionToKeys.clear();

		// 为应用程序操作设置默认值
		for (const [action, keys] of Object.entries(DEFAULT_APP_KEYBINDINGS)) {
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.appActionToKeys.set(action as AppAction, [...keyArray]);
		}

		// 使用用户配置覆盖（仅限应用程序操作）
		for (const [action, keys] of Object.entries(this.config)) {
			if (keys === undefined || !isAppAction(action)) continue;
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.appActionToKeys.set(action, keyArray);
		}
	}

	/**
	 * 检查输入是否匹配应用程序操作。
	 */
	matches(data: string, action: AppAction): boolean {
		const keys = this.appActionToKeys.get(action);
		if (!keys) return false;
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * 获取绑定到应用程序操作的键。
	 */
	getKeys(action: AppAction): KeyId[] {
		return this.appActionToKeys.get(action) ?? [];
	}

	/**
	 * 获取完整的有效配置。
	 */
	getEffectiveConfig(): Required<KeybindingsConfig> {
		const result = { ...DEFAULT_KEYBINDINGS };
		for (const [action, keys] of Object.entries(this.config)) {
			if (keys !== undefined) {
				(result as KeybindingsConfig)[action as KeyAction] = keys;
			}
		}
		return result;
	}
}

// 为方便起见重新导出
export type { EditorAction, KeyId };

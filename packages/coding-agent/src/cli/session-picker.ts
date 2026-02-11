/**
 * 用于 --resume 标志的 TUI 会话选择器
 */

import { ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import { KeybindingsManager } from "../core/keybindings.js";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.js";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.js";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** 显示 TUI 会话选择器并返回选定的会话路径，如果取消则返回 null */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
): Promise<string | null> {
	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		const keybindings = KeybindingsManager.create();
		let resolved = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		ui.start();
	});
}

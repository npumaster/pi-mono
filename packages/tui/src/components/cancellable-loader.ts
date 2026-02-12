import { getEditorKeybindings } from "../keybindings.js";
import { Loader } from "./loader.js";

/**
 * 可以通过 Escape 键取消的加载器。
 * 扩展了 Loader，带有一个用于取消异步操作的 AbortSignal。
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	private abortController = new AbortController();

	/** 当用户按下 Escape 键时调用 */
	onAbort?: () => void;

	/** 用户按下 Escape 键时中止的 AbortSignal */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/** 加载器是否已中止 */
	get aborted(): boolean {
		return this.abortController.signal.aborted;
	}

	handleInput(data: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(data, "selectCancel")) {
			this.abortController.abort();
			this.onAbort?.();
		}
	}

	dispose(): void {
		this.stop();
	}
}

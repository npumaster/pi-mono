import { existsSync, type FSWatcher, readFileSync, statSync, watch } from "fs";
import { dirname, join, resolve } from "path";

/**
 * 从 cwd 向上查找 git HEAD 路径。
 * 处理常规 git 仓库（.git 是目录）和工作树（.git 是文件）。
 */
function findGitHeadPath(): string | null {
	let dir = process.cwd();
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = content.slice(8);
						const headPath = resolve(dir, gitDir, "HEAD");
						if (existsSync(headPath)) return headPath;
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (existsSync(headPath)) return headPath;
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * 提供 git 分支和扩展状态 - 扩展无法通过其他方式访问的数据。
 * 令牌统计信息、模型信息可通过 ctx.sessionManager 和 ctx.model 获取。
 */
export class FooterDataProvider {
	private extensionStatuses = new Map<string, string>();
	private cachedBranch: string | null | undefined = undefined;
	private gitWatcher: FSWatcher | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;

	constructor() {
		this.setupGitWatcher();
	}

	/** 当前 git 分支，如果不在仓库中则为 null，如果是 detached HEAD 则为 "detached" */
	getGitBranch(): string | null {
		if (this.cachedBranch !== undefined) return this.cachedBranch;

		try {
			const gitHeadPath = findGitHeadPath();
			if (!gitHeadPath) {
				this.cachedBranch = null;
				return null;
			}
			const content = readFileSync(gitHeadPath, "utf8").trim();
			this.cachedBranch = content.startsWith("ref: refs/heads/") ? content.slice(16) : "detached";
		} catch {
			this.cachedBranch = null;
		}
		return this.cachedBranch;
	}

	/** 通过 ctx.ui.setStatus() 设置的扩展状态文本 */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** 订阅 git 分支更改。返回取消订阅函数。 */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** 内部：设置扩展状态 */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** 内部：清除扩展状态 */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** 具有可用模型的唯一提供商数量（用于页脚显示） */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** 内部：更新可用提供商数量 */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	/** 内部：清理 */
	dispose(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}
		this.branchChangeCallbacks.clear();
	}

	private setupGitWatcher(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}

		const gitHeadPath = findGitHeadPath();
		if (!gitHeadPath) return;

		// 监视包含 HEAD 的目录，而不是 HEAD 本身。
		// Git 使用原子写入（写入临时文件，重命名覆盖 HEAD），这会更改 inode。
		// inode 更改后，fs.watch 在文件上会停止工作。
		const gitDir = dirname(gitHeadPath);

		try {
			this.gitWatcher = watch(gitDir, (_eventType, filename) => {
				if (filename === "HEAD") {
					this.cachedBranch = undefined;
					for (const cb of this.branchChangeCallbacks) cb();
				}
			});
		} catch {
			// 如果无法监视则静默失败
		}
	}
}

/** 扩展的只读视图 - 排除 setExtensionStatus、setAvailableProviderCount 和 dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;

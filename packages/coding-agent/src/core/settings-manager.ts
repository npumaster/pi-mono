import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	maxDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

/**
 * npm/git 包的包源。
 * - 字符串形式：从包中加载所有资源
 * - 对象形式：过滤要加载的资源
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // 自定义 shell 路径（例如，Windows 上的 Cygwin 用户）
	quietStartup?: boolean;
	shellCommandPrefix?: string; // 添加到每个 bash 命令的前缀（例如，"shopt -s expand_aliases" 用于别名支持）
	collapseChangelog?: boolean; // 更新后显示简明变更日志（使用 /changelog 查看完整内容）
	packages?: PackageSource[]; // npm/git 包源数组（字符串或带有过滤的对象）
	extensions?: string[]; // 本地扩展文件路径或目录的数组
	skills?: string[]; // 本地技能文件路径或目录的数组
	prompts?: string[]; // 本地提示词模板路径或目录的数组
	themes?: string[]; // 本地主题文件路径或目录的数组
	enableSkillCommands?: boolean; // 默认：true - 将技能注册为 /skill:name 命令
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // 用于循环的模型模式（与 --models CLI 标志格式相同）
	doubleEscapeAction?: "fork" | "tree" | "none"; // 空编辑器时双击 escape 的操作（默认："tree"）
	thinkingBudgets?: ThinkingBudgetsSettings; // 思考级别的自定义令牌预算
	editorPaddingX?: number; // 输入编辑器的水平填充（默认：0）
	autocompleteMaxVisible?: number; // 自动完成下拉菜单中的最大可见项目数（默认：5）
	showHardwareCursor?: boolean; // 在为输入法定位时仍显示终端光标
	markdown?: MarkdownSettings;
}

/** 深度合并设置：项目/覆盖优先，嵌套对象递归合并 */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// 对于嵌套对象，递归合并
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// 对于基元和数组，覆盖值胜出
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

export class SettingsManager {
	private settingsPath: string | null;
	private projectSettingsPath: string | null;
	private globalSettings: Settings;
	private inMemoryProjectSettings: Settings; // 用于内存模式
	private settings: Settings;
	private persist: boolean;
	private modifiedFields = new Set<keyof Settings>(); // 跟踪会话期间修改的字段
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // 跟踪嵌套字段修改
	private globalSettingsLoadError: Error | null = null; // 跟踪设置文件是否有解析错误

	private constructor(
		settingsPath: string | null,
		projectSettingsPath: string | null,
		initialSettings: Settings,
		persist: boolean,
		loadError: Error | null = null,
	) {
		this.settingsPath = settingsPath;
		this.projectSettingsPath = projectSettingsPath;
		this.persist = persist;
		this.globalSettings = initialSettings;
		this.inMemoryProjectSettings = {};
		this.globalSettingsLoadError = loadError;
		const projectSettings = this.loadProjectSettings();
		this.settings = deepMergeSettings(this.globalSettings, projectSettings);
	}

	/** 创建从文件加载的 SettingsManager */
	static create(cwd: string = process.cwd(), agentDir: string = getAgentDir()): SettingsManager {
		const settingsPath = join(agentDir, "settings.json");
		const projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");

		let globalSettings: Settings = {};
		let loadError: Error | null = null;

		try {
			globalSettings = SettingsManager.loadFromFile(settingsPath);
		} catch (error) {
			loadError = error as Error;
			console.error(`Warning: Invalid JSON in ${settingsPath}: ${error}`);
			console.error(`Fix the syntax error to enable settings persistence.`);
		}

		return new SettingsManager(settingsPath, projectSettingsPath, globalSettings, true, loadError);
	}

	/** 创建内存中的 SettingsManager（无文件 I/O） */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		return new SettingsManager(null, null, settings, false);
	}

	private static loadFromFile(path: string): Settings {
		if (!existsSync(path)) {
			return {};
		}
		const content = readFileSync(path, "utf-8");
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	/** 将旧设置格式迁移到新格式 */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// 迁移 queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// 将旧的 skills 对象格式迁移到新的数组格式
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		return settings as Settings;
	}

	private loadProjectSettings(): Settings {
		// 内存模式：返回存储的内存项目设置
		if (!this.persist) {
			return structuredClone(this.inMemoryProjectSettings);
		}

		if (!this.projectSettingsPath || !existsSync(this.projectSettingsPath)) {
			return {};
		}

		try {
			const content = readFileSync(this.projectSettingsPath, "utf-8");
			const settings = JSON.parse(content);
			return SettingsManager.migrateSettings(settings);
		} catch (error) {
			console.error(`Warning: Could not read project settings file: ${error}`);
			return {};
		}
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return this.loadProjectSettings();
	}

	reload(): void {
		let nextGlobalSettings: Settings | null = null;

		if (this.persist && this.settingsPath) {
			try {
				nextGlobalSettings = SettingsManager.loadFromFile(this.settingsPath);
				this.globalSettingsLoadError = null;
			} catch (error) {
				this.globalSettingsLoadError = error as Error;
			}
		}

		if (nextGlobalSettings) {
			this.globalSettings = nextGlobalSettings;
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();

		const projectSettings = this.loadProjectSettings();
		this.settings = deepMergeSettings(this.globalSettings, projectSettings);
	}

	/** 在当前设置之上应用额外的覆盖 */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** 将字段标记为在本次会话期间已修改 */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	private save(): void {
		if (this.persist && this.settingsPath) {
			// 如果文件在初始加载时有解析错误，请勿覆盖
			if (this.globalSettingsLoadError) {
				// 即使我们无法持久化，也重新合并以更新活动设置
				const projectSettings = this.loadProjectSettings();
				this.settings = deepMergeSettings(this.globalSettings, projectSettings);
				return;
			}

			try {
				const dir = dirname(this.settingsPath);
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}

				// 重新读取当前文件以获取最新的外部更改
				const currentFileSettings = SettingsManager.loadFromFile(this.settingsPath);

				// 以文件设置作为基础 - 保留外部编辑
				const mergedSettings: Settings = { ...currentFileSettings };

				// 仅覆盖在本次会话期间显式修改的字段的内存值
				for (const field of this.modifiedFields) {
					const value = this.globalSettings[field];

					// 特别处理嵌套对象 - 在嵌套级别合并以保留未修改的嵌套键
					if (this.modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
						const nestedModified = this.modifiedNestedFields.get(field)!;
						const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
						const inMemoryNested = value as Record<string, unknown>;
						const mergedNested = { ...baseNested };
						for (const nestedKey of nestedModified) {
							mergedNested[nestedKey] = inMemoryNested[nestedKey];
						}
						(mergedSettings as Record<string, unknown>)[field] = mergedNested;
					} else {
						// 对于顶级基元和数组，直接使用修改后的值
						(mergedSettings as Record<string, unknown>)[field] = value;
					}
				}

				this.globalSettings = mergedSettings;
				writeFileSync(this.settingsPath, JSON.stringify(this.globalSettings, null, 2), "utf-8");
			} catch (error) {
				// 文件可能已被外部修改且 JSON 无效 - 请勿覆盖
				console.error(`Warning: Could not save settings file: ${error}`);
			}
		}

		// 始终重新合并以更新活动设置（文件和内存模式都需要）
		const projectSettings = this.loadProjectSettings();
		this.settings = deepMergeSettings(this.globalSettings, projectSettings);
	}

	private saveProjectSettings(settings: Settings): void {
		// 内存模式：存储在内存中
		if (!this.persist) {
			this.inMemoryProjectSettings = structuredClone(settings);
			return;
		}

		if (!this.projectSettingsPath) {
			return;
		}
		try {
			const dir = dirname(this.projectSettingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.projectSettingsPath, JSON.stringify(settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save project settings file: ${error}`);
		}
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
			maxDelayMs: this.settings.retry?.maxDelayMs ?? 60000,
		};
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		const projectSettings = this.loadProjectSettings();
		projectSettings.packages = packages;
		this.saveProjectSettings(projectSettings);
		this.settings = deepMergeSettings(this.globalSettings, projectSettings);
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		const projectSettings = this.loadProjectSettings();
		projectSettings.extensions = paths;
		this.saveProjectSettings(projectSettings);
		this.settings = deepMergeSettings(this.globalSettings, projectSettings);
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		const projectSettings = this.loadProjectSettings();
		projectSettings.skills = paths;
		this.saveProjectSettings(projectSettings);
		this.settings = deepMergeSettings(this.globalSettings, projectSettings);
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		const projectSettings = this.loadProjectSettings();
		projectSettings.prompts = paths;
		this.saveProjectSettings(projectSettings);
		this.settings = deepMergeSettings(this.globalSettings, projectSettings);
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		const projectSettings = this.loadProjectSettings();
		projectSettings.themes = paths;
		this.saveProjectSettings(projectSettings);
		this.settings = deepMergeSettings(this.globalSettings, projectSettings);
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getClearOnShrink(): boolean {
		// 设置优先，然后是环境变量，然后默认 false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}
}

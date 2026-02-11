/**
 * 编码代理 CLI 的主入口点。
 *
 * 此文件处理 CLI 参数解析并将它们转换为 createAgentSession() 选项。
 * SDK 负责繁重的工作。
 */

import { type ImageContent, modelsAreEqual, supportsXhigh } from "@mariozechner/pi-ai";
import chalk from "chalk";
import { createInterface } from "readline";
import { type Args, parseArgs, printHelp } from "./cli/args.js";
import { selectConfig } from "./cli/config-selector.js";
import { processFileArguments } from "./cli/file-processor.js";
import { listModels } from "./cli/list-models.js";
import { selectSession } from "./cli/session-picker.js";
import { APP_NAME, getAgentDir, getModelsPath, VERSION } from "./config.js";
import { AuthStorage } from "./core/auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "./core/defaults.js";
import { exportFromFile } from "./core/export-html/index.js";
import type { LoadExtensionsResult } from "./core/extensions/index.js";
import { KeybindingsManager } from "./core/keybindings.js";
import { ModelRegistry } from "./core/model-registry.js";
import { resolveModelScope, type ScopedModel } from "./core/model-resolver.js";
import { DefaultPackageManager } from "./core/package-manager.js";
import { DefaultResourceLoader } from "./core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "./core/sdk.js";
import { SessionManager } from "./core/session-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { printTimings, time } from "./core/timings.js";
import { allTools } from "./core/tools/index.js";
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.js";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";

/**
 * 从管道 stdin 读取所有内容。
 * 如果 stdin 是 TTY（交互式终端），则返回 undefined。
 */
async function readPipedStdin(): Promise<string | undefined> {
	// 如果 stdin 是 TTY，则我们正在交互式运行 - 不要读取 stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

type PackageCommand = "install" | "remove" | "update" | "list";

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	local: boolean;
	help: boolean;
	invalidOption?: string;
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l]`;
		case "update":
			return `${APP_NAME} update [source]`;
		case "list":
			return `${APP_NAME} list`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

安装包并将其添加到设置中。

Options:
  -l, --local    在项目本地安装 (.pi/settings.json)

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install git@github.com:user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

从设置中移除包及其源。

Options:
  -l, --local    从项目设置中移除 (.pi/settings.json)

Example:
  ${APP_NAME} remove npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

更新已安装的包。
如果提供了 <source>，则仅更新该包。
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

列出用户和项目设置中已安装的包。
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [command, ...rest] = args;
	if (command !== "install" && command !== "remove" && command !== "update" && command !== "list") {
		return undefined;
	}

	let local = false;
	let help = false;
	let invalidOption: string | undefined;
	let source: string | undefined;

	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		}
	}

	return { command, source, local, help, invalidOption };
}

async function handlePackageCommand(args: string[]): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.install(source!, { local: options.local });
				packageManager.addSourceToSettings(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				await packageManager.remove(source!, { local: options.local });
				const removed = packageManager.removeSourceFromSettings(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				const globalSettings = settingsManager.getGlobalSettings();
				const projectSettings = settingsManager.getProjectSettings();
				const globalPackages = globalSettings.packages ?? [];
				const projectPackages = projectSettings.packages ?? [];

				if (globalPackages.length === 0 && projectPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				const formatPackage = (pkg: (typeof globalPackages)[number], scope: "user" | "project") => {
					const source = typeof pkg === "string" ? pkg : pkg.source;
					const filtered = typeof pkg === "object";
					const display = filtered ? `${source} (filtered)` : source;
					console.log(`  ${display}`);
					const path = packageManager.getInstalledPath(source, scope);
					if (path) {
						console.log(chalk.dim(`    ${path}`));
					}
				};

				if (globalPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of globalPackages) {
						formatPackage(pkg, "user");
					}
				}

				if (projectPackages.length > 0) {
					if (globalPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg, "project");
					}
				}

				return true;
			}

			case "update":
				await packageManager.update(source);
				if (source) {
					console.log(chalk.green(`Updated ${source}`));
				} else {
					console.log(chalk.green("Updated packages"));
				}
				return true;
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return {};
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });

	let initialMessage: string;
	if (parsed.messages.length > 0) {
		initialMessage = text + parsed.messages[0];
		parsed.messages.shift();
	} else {
		initialMessage = text;
	}

	return {
		initialMessage,
		initialImages: images.length > 0 ? images : undefined,
	};
}

/** 解析会话参数的结果 */
type ResolvedSession =
	| { type: "path"; path: string } // 直接文件路径
	| { type: "local"; path: string } // 在当前项目中找到
	| { type: "global"; path: string; cwd: string } // 在不同项目中找到
	| { type: "not_found"; arg: string }; // 未在任何地方找到

/**
 * 将会话参数解析为文件路径。
 * 如果它看起来像路径，则按原样使用。否则尝试匹配会话 ID 前缀。
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// 如果它看起来像文件路径，则按原样使用
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: sessionArg };
	}

	// 首先尝试在当前项目中匹配会话 ID
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));

	if (localMatches.length >= 1) {
		return { type: "local", path: localMatches[0].path };
	}

	// 尝试跨所有项目进行全局搜索
	const allSessions = await SessionManager.listAll();
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));

	if (globalMatches.length >= 1) {
		const match = globalMatches[0];
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// 未在任何地方找到
	return { type: "not_found", arg: sessionArg };
}

/** 提示用户进行是/否确认 */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

async function createSessionManager(parsed: Args, cwd: string): Promise<SessionManager | undefined> {
	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, parsed.sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, parsed.sessionDir);

			case "global": {
				// 在不同项目中找到会话 - 询问用户是否要 fork
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return SessionManager.forkFrom(resolved.path, cwd, parsed.sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}
	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, parsed.sessionDir);
	}
	// --resume 单独处理（需要选择器 UI）
	// 如果提供了 --session-dir 但没有 --continue/--resume，则在那里创建新会话
	if (parsed.sessionDir) {
		return SessionManager.create(cwd, parsed.sessionDir);
	}
	// 默认情况（新会话）返回 undefined，SDK 将创建一个
	return undefined;
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): CreateAgentSessionOptions {
	const options: CreateAgentSessionOptions = {};

	if (sessionManager) {
		options.sessionManager = sessionManager;
	}

	// 来自 CLI 的模型
	if (parsed.provider && parsed.model) {
		const model = modelRegistry.find(parsed.provider, parsed.model);
		if (!model) {
			console.error(chalk.red(`Model ${parsed.provider}/${parsed.model} not found`));
			process.exit(1);
		}
		options.model = model;
	} else if (scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
		// 检查保存的默认值是否在作用域模型中 - 如果在则使用它，否则使用第一个作用域模型
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// 如果显式设置，则使用作用域模型配置中的思考级别
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// 如果显式设置，则使用第一个作用域模型中的思考级别
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// 来自 CLI 的思考级别（优先于上面设置的作用域模型思考级别）
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// 用于 Ctrl+P 循环的作用域模型 - 为没有显式级别的模型填充默认思考级别
	if (scopedModels.length > 0) {
		const defaultThinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel ?? defaultThinkingLevel,
		}));
	}

	// 来自 CLI 的 API 密钥 - 在 authStorage 中设置
	// （在 createAgentSession 之前由调用者处理）

	// 工具
	if (parsed.noTools) {
		// --no-tools: 启动时不带任何内置工具
		// --tools 仍然可以添加特定的工具
		if (parsed.tools && parsed.tools.length > 0) {
			options.tools = parsed.tools.map((name) => allTools[name]);
		} else {
			options.tools = [];
		}
	} else if (parsed.tools) {
		options.tools = parsed.tools.map((name) => allTools[name]);
	}

	return options;
}

async function handleConfigCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

export async function main(args: string[]) {
	if (await handlePackageCommand(args)) {
		return;
	}

	if (await handleConfigCommand(args)) {
		return;
	}

	// 运行迁移（传递 cwd 以进行项目本地迁移）
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(process.cwd());

	// 第一遍：解析参数以获取 --extension 路径
	const firstPass = parseArgs(args);

	// 尽早加载扩展以发现它们的 CLI 标志
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const authStorage = new AuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, getModelsPath());

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: firstPass.extensions,
		additionalSkillPaths: firstPass.skills,
		additionalPromptTemplatePaths: firstPass.promptTemplates,
		additionalThemePaths: firstPass.themes,
		noExtensions: firstPass.noExtensions,
		noSkills: firstPass.noSkills,
		noPromptTemplates: firstPass.noPromptTemplates,
		noThemes: firstPass.noThemes,
		systemPrompt: firstPass.systemPrompt,
		appendSystemPrompt: firstPass.appendSystemPrompt,
	});
	await resourceLoader.reload();
	time("resourceLoader.reload");

	const extensionsResult: LoadExtensionsResult = resourceLoader.getExtensions();
	for (const { path, error } of extensionsResult.errors) {
		console.error(chalk.red(`Failed to load extension "${path}": ${error}`));
	}

	// 立即应用扩展中待处理的提供商注册
	// 以便在创建 AgentSession 之前可用于模型解析
	for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];

	const extensionFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const ext of extensionsResult.extensions) {
		for (const [name, flag] of ext.flags) {
			extensionFlags.set(name, { type: flag.type });
		}
	}

	// 第二遍：使用扩展标志解析参数
	const parsed = parseArgs(args, extensionFlags);

	// 通过运行时将标志值传递给扩展
	for (const [name, value] of parsed.unknownFlags) {
		extensionsResult.runtime.flagValues.set(name, value);
	}

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.help) {
		printHelp();
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	// 读取管道 stdin 内容（如果有）- RPC 模式跳过，因为它使用 stdin 进行 JSON-RPC
	if (parsed.mode !== "rpc") {
		const stdinContent = await readPipedStdin();
		if (stdinContent !== undefined) {
			// 强制打印模式，因为交互式模式需要 TTY 进行键盘输入
			parsed.print = true;
			// 将 stdin 内容添加到消息前面
			parsed.messages.unshift(stdinContent);
		}
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, settingsManager.getImageAutoResize());
	const isInteractive = !parsed.print && parsed.mode === undefined;
	const mode = parsed.mode || "text";
	initTheme(settingsManager.getTheme(), isInteractive);

	// 在交互式模式下显示弃用警告
	if (isInteractive && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	let scopedModels: ScopedModel[] = [];
	const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
	if (modelPatterns && modelPatterns.length > 0) {
		scopedModels = await resolveModelScope(modelPatterns, modelRegistry);
	}

	// 根据 CLI 标志创建会话管理器
	let sessionManager = await createSessionManager(parsed, cwd);

	// 处理 --resume：显示会话选择器
	if (parsed.resume) {
		// 初始化按键绑定，以便会话选择器遵循用户配置
		KeybindingsManager.create();

		const selectedPath = await selectSession(
			(onProgress) => SessionManager.list(cwd, parsed.sessionDir, onProgress),
			SessionManager.listAll,
		);
		if (!selectedPath) {
			console.log(chalk.dim("No session selected"));
			stopThemeWatcher();
			process.exit(0);
		}
		sessionManager = SessionManager.open(selectedPath);
	}

	const sessionOptions = buildSessionOptions(parsed, scopedModels, sessionManager, modelRegistry, settingsManager);
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.resourceLoader = resourceLoader;

	// 将 CLI --api-key 处理为运行时覆盖（不持久化）
	if (parsed.apiKey) {
		if (!sessionOptions.model) {
			console.error(chalk.red("--api-key requires a model to be specified via --provider/--model or -m/--models"));
			process.exit(1);
		}
		authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
	}

	const { session, modelFallbackMessage } = await createAgentSession(sessionOptions);

	if (!isInteractive && !session.model) {
		console.error(chalk.red("No models available."));
		console.error(chalk.yellow("\nSet an API key environment variable:"));
		console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.");
		console.error(chalk.yellow(`\nOr create ${getModelsPath()}`));
		process.exit(1);
	}

	// 将思考级别限制为模型能力（针对 CLI 覆盖情况）
	if (session.model && parsed.thinking) {
		let effectiveThinking = parsed.thinking;
		if (!session.model.reasoning) {
			effectiveThinking = "off";
		} else if (effectiveThinking === "xhigh" && !supportsXhigh(session.model)) {
			effectiveThinking = "high";
		}
		if (effectiveThinking !== session.thinkingLevel) {
			session.setThinkingLevel(effectiveThinking);
		}
	}

	if (mode === "rpc") {
		await runRpcMode(session);
	} else if (isInteractive) {
		if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
			const modelList = scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		printTimings();
		const mode = new InteractiveMode(session, {
			migratedProviders,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		await mode.run();
	} else {
		await runPrintMode(session, {
			mode,
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		if (process.stdout.writableLength > 0) {
			await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
		}
		process.exit(0);
	}
}

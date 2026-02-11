/**
 * CLI 参数解析和帮助显示
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../config.js";
import { allTools, type ToolName } from "../core/tools/index.js";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	session?: string;
	sessionDir?: string;
	models?: string[];
	tools?: ToolName[];
	noTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	listModels?: string | true;
	verbose?: boolean;
	messages: string[];
	fileArgs: string[];
	/** 未知标志（可能是扩展标志）- 标志名称到值的映射 */
	unknownFlags: Map<string, boolean | string>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function parseArgs(args: string[], extensionFlags?: Map<string, { type: "boolean" | "string" }>): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = args[++i];
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--no-tools") {
			result.noTools = true;
		} else if (arg === "--tools" && i + 1 < args.length) {
			const toolNames = args[++i].split(",").map((s) => s.trim());
			const validTools: ToolName[] = [];
			for (const name of toolNames) {
				if (name in allTools) {
					validTools.push(name as ToolName);
				} else {
					console.error(
						chalk.yellow(`Warning: Unknown tool "${name}". Valid tools: ${Object.keys(allTools).join(", ")}`),
					);
				}
			}
			result.tools = validTools;
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				console.error(
					chalk.yellow(
						`Warning: Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
					),
				);
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--list-models") {
			// 检查下一个参数是否是搜索模式（不是标志或文件参数）
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // 移除 @ 前缀
		} else if (arg.startsWith("--") && extensionFlags) {
			// 检查它是否是扩展注册的标志
			const flagName = arg.slice(2);
			const extFlag = extensionFlags.get(flagName);
			if (extFlag) {
				if (extFlag.type === "boolean") {
					result.unknownFlags.set(flagName, true);
				} else if (extFlag.type === "string" && i + 1 < args.length) {
					result.unknownFlags.set(flagName, args[++i]);
				}
			}
			// 没有 extensionFlags 的未知标志将被静默忽略（第一遍）
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(): void {
	console.log(`${chalk.bold(APP_NAME)} - 具有读取、bash、编辑、写入工具的 AI 编码助手

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]    安装扩展源并添加到设置中
  ${APP_NAME} remove <source> [-l]     从设置中移除扩展源
  ${APP_NAME} update [source]          更新已安装的扩展（跳过固定源）
  ${APP_NAME} list                     列出设置中已安装的扩展
  ${APP_NAME} config                   打开 TUI 以启用/禁用包资源
  ${APP_NAME} <command> --help         显示 install/remove/update/list 的帮助信息

${chalk.bold("Options:")}
  --provider <name>              提供商名称 (默认: google)
  --model <id>                   模型 ID (默认: gemini-2.5-flash)
  --api-key <key>                API 密钥 (默认为环境变量)
  --system-prompt <text>         系统提示词 (默认: 编码助手提示词)
  --append-system-prompt <text>  将文本或文件内容追加到系统提示词
  --mode <mode>                  输出模式: text (默认), json, 或 rpc
  --print, -p                    非交互式模式: 处理提示词并退出
  --continue, -c                 继续上一个会话
  --resume, -r                   选择要恢复的会话
  --session <path>               使用特定的会话文件
  --session-dir <dir>            会话存储和查找目录
  --no-session                   不保存会话 (临时)
  --models <patterns>            用于 Ctrl+P 循环的逗号分隔模型模式
                                 支持 glob (anthropic/*, *sonnet*) 和模糊匹配
  --no-tools                     禁用所有内置工具
  --tools <tools>                要启用的逗号分隔工具列表 (默认: read,bash,edit,write)
                                 可用: read, bash, edit, write, grep, find, ls
  --thinking <level>             设置思考级别: off, minimal, low, medium, high, xhigh
  --extension, -e <path>         加载扩展文件 (可多次使用)
  --no-extensions, -ne           禁用扩展发现 (显式 -e 路径仍然有效)
  --skill <path>                 加载技能文件或目录 (可多次使用)
  --no-skills, -ns               禁用技能发现和加载
  --prompt-template <path>       加载提示模板文件或目录 (可多次使用)
  --no-prompt-templates, -np     禁用提示模板发现和加载
  --theme <path>                 加载主题文件或目录 (可多次使用)
  --no-themes                    禁用主题发现和加载
  --export <file>                将会话文件导出为 HTML 并退出
  --list-models [search]         列出可用模型 (可选模糊搜索)
  --verbose                      强制详细启动 (覆盖 quietStartup 设置)
  --help, -h                     显示此帮助信息
  --version, -v                  显示版本号

扩展可以注册额外的标志 (例如 plan-mode 扩展的 --plan)。

${chalk.bold("Examples:")}
  # 交互式模式
  ${APP_NAME}

  # 带有初始提示词的交互式模式
  ${APP_NAME} "List all .ts files in src/"

  # 在初始消息中包含文件
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # 非交互式模式 (处理并退出)
  ${APP_NAME} -p "List all .ts files in src/"

  # 多条消息 (交互式)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # 继续上一个会话
  ${APP_NAME} --continue "What did we discuss?"

  # 使用不同的模型
  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # 将模型循环限制为特定模型
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

  # 使用 glob 模式限制为特定提供商
  ${APP_NAME} --models "github-copilot/*"

  # 循环使用具有固定思考级别的模型
  ${APP_NAME} --models sonnet:high,haiku:low

  # 以特定思考级别开始
  ${APP_NAME} --thinking high "Solve this complex problem"

  # 只读模式 (无法修改文件)
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

  # 将会话文件导出为 HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  OPENAI_API_KEY                   - OpenAI GPT API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI base URL (https://{resource}.openai.azure.com/openai/v1)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI API key
  MISTRAL_API_KEY                  - Mistral API key
  MINIMAX_API_KEY                  - MiniMax API key
  KIMI_API_KEY                     - Kimi For Coding API key
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - 会话存储目录 (默认: ~/${CONFIG_DIR_NAME}/agent)
  PI_PACKAGE_DIR                   - 覆盖包目录 (用于 Nix/Guix 存储路径)
  PI_SHARE_VIEWER_URL              - /share 命令的基础 URL (默认: https://pi.dev/session/)
  PI_AI_ANTIGRAVITY_VERSION        - 覆盖 Antigravity User-Agent 版本 (例如 1.23.0)

${chalk.bold("Available Tools (default: read, bash, edit, write):")}
  read   - 读取文件内容
  bash   - 执行 bash 命令
  edit   - 使用查找/替换编辑文件
  write  - 写入文件 (创建/覆盖)
  grep   - 搜索文件内容 (只读，默认关闭)
  find   - 按 glob 模式查找文件 (只读，默认关闭)
  ls     - 列出目录内容 (只读，默认关闭)
`);
}

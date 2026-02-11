import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getPromptsDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

/**
 * 表示从 markdown 文件加载的提示词模板
 */
export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	source: string; // "user", "project", or "path"
	filePath: string; // Absolute path to the template file
}

/**
 * 解析命令参数，支持带引号的字符串（bash 风格）
 * 返回参数数组
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

/**
 * 替换模板内容中的参数占位符
 * 支持：
 * - $1, $2, ... 用于位置参数
 * - $@ 和 $ARGUMENTS 用于所有参数
 * - ${@:N} 用于从第 N 个开始的参数（bash 风格切片）
 * - ${@:N:L} 用于从第 N 个开始的 L 个参数
 *
 * 注意：仅在模板字符串上进行替换。包含 $1、$@ 或 $ARGUMENTS 等模式的参数值不会被递归替换。
 */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	// 首先替换 $1, $2 等位置参数（在通配符之前）
	// 这可以防止包含 $<digit> 模式的通配符替换值被重新替换
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	// 替换 ${@:start} 或 ${@:start:length} 为切片参数（bash 风格）
	// 在简单的 $@ 之前处理以避免冲突
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1; // Convert to 0-indexed (user provides 1-indexed)
		// Treat 0 as 1 (bash convention: args start at 1)
		if (start < 0) start = 0;

		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});

	// 预先计算所有连接的参数（优化）
	const allArgs = args.join(" ");

	// 将 $ARGUMENTS 替换为所有连接的参数（新语法，与 Claude、Codex、OpenCode 一致）
	result = result.replace(/\$ARGUMENTS/g, allArgs);

	// 将 $@ 替换为所有连接的参数（现有语法）
	result = result.replace(/\$@/g, allArgs);

	return result;
}

function loadTemplateFromFile(filePath: string, source: string, sourceLabel: string): PromptTemplate | null {
	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent);

		const name = basename(filePath).replace(/\.md$/, "");

		// 从 frontmatter 或第一个非空行获取描述
		let description = frontmatter.description || "";
		if (!description) {
			const firstLine = body.split("\n").find((line) => line.trim());
			if (firstLine) {
				// 如果太长则截断
				description = firstLine.slice(0, 60);
				if (firstLine.length > 60) description += "...";
			}
		}

		// 将来源附加到描述
		description = description ? `${description} ${sourceLabel}` : sourceLabel;

		return {
			name,
			description,
			content: body,
			source,
			filePath,
		};
	} catch {
		return null;
	}
}

/**
 * 扫描目录以查找 .md 文件（非递归）并将它们加载为提示词模板。
 */
function loadTemplatesFromDir(dir: string, source: string, sourceLabel: string): PromptTemplate[] {
	const templates: PromptTemplate[] = [];

	if (!existsSync(dir)) {
		return templates;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			// 对于符号链接，检查它们是否指向文件
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
				} catch {
					// 损坏的符号链接，跳过它
					continue;
				}
			}

			if (isFile && entry.name.endsWith(".md")) {
				const template = loadTemplateFromFile(fullPath, source, sourceLabel);
				if (template) {
					templates.push(template);
				}
			}
		}
	} catch {
		return templates;
	}

	return templates;
}

export interface LoadPromptTemplatesOptions {
	/** 项目本地模板的工作目录。默认值：process.cwd() */
	cwd?: string;
	/** 全局模板的代理配置目录。默认值：来自 getPromptsDir() */
	agentDir?: string;
	/** 显式提示词模板路径（文件或目录） */
	promptPaths?: string[];
	/** 包含默认提示词目录。默认值：true */
	includeDefaults?: boolean;
}

function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	return trimmed;
}

function resolvePromptPath(p: string, cwd: string): string {
	const normalized = normalizePath(p);
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

function buildPathSourceLabel(p: string): string {
	const base = basename(p).replace(/\.md$/, "") || "path";
	return `(path:${base})`;
}

/**
 * 加载所有提示词模板：
 * 1. 全局：agentDir/prompts/
 * 2. 项目：cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. 显式提示词路径
 */
export function loadPromptTemplates(options: LoadPromptTemplatesOptions = {}): PromptTemplate[] {
	const resolvedCwd = options.cwd ?? process.cwd();
	const resolvedAgentDir = options.agentDir ?? getPromptsDir();
	const promptPaths = options.promptPaths ?? [];
	const includeDefaults = options.includeDefaults ?? true;

	const templates: PromptTemplate[] = [];

	if (includeDefaults) {
		// 1. 从 agentDir/prompts/ 加载全局模板
		// 注意：如果提供了 agentDir，它应该是 agent 目录，而不是 prompts 目录
		const globalPromptsDir = options.agentDir ? join(options.agentDir, "prompts") : resolvedAgentDir;
		templates.push(...loadTemplatesFromDir(globalPromptsDir, "user", "(user)"));

		// 2. 从 cwd/{CONFIG_DIR_NAME}/prompts/ 加载项目模板
		const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");
		templates.push(...loadTemplatesFromDir(projectPromptsDir, "project", "(project)"));
	}

	const userPromptsDir = options.agentDir ? join(options.agentDir, "prompts") : resolvedAgentDir;
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSourceInfo = (resolvedPath: string): { source: string; label: string } => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userPromptsDir)) {
				return { source: "user", label: "(user)" };
			}
			if (isUnderPath(resolvedPath, projectPromptsDir)) {
				return { source: "project", label: "(project)" };
			}
		}
		return { source: "path", label: buildPathSourceLabel(resolvedPath) };
	};

	// 3. 加载显式提示词路径
	for (const rawPath of promptPaths) {
		const resolvedPath = resolvePromptPath(rawPath, resolvedCwd);
		if (!existsSync(resolvedPath)) {
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const { source, label } = getSourceInfo(resolvedPath);
			if (stats.isDirectory()) {
				templates.push(...loadTemplatesFromDir(resolvedPath, source, label));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const template = loadTemplateFromFile(resolvedPath, source, label);
				if (template) {
					templates.push(template);
				}
			}
		} catch {
			// 忽略读取失败
		}
	}

	return templates;
}

/**
 * 如果提示词模板匹配模板名称，则展开它。
 * 返回展开的内容，如果不是模板则返回原始文本。
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const template = templates.find((t) => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		return substituteArgs(template.content, args);
	}

	return text;
}

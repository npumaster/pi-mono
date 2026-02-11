import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// 包检测
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 检测我们是否作为 Bun 编译的二进制文件运行。
 * Bun 二进制文件的 import.meta.url 包含 "$bunfs"、"~BUN" 或 "%7EBUN"（Bun 的虚拟文件系统路径）
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** 检测 Bun 是否为运行时（编译的二进制文件或 bun run） */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// 安装方法检测
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase();

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/") || resolvedPath.includes("\\pnpm\\")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/") || resolvedPath.includes("\\yarn\\")) {
		return "yarn";
	}
	if (isBunRuntime) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\npm\\")) {
		return "npm";
	}

	return "unknown";
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	switch (method) {
		case "bun-binary":
			return `Download from: https://github.com/badlogic/pi-mono/releases/latest`;
		case "pnpm":
			return `Run: pnpm install -g ${packageName}`;
		case "yarn":
			return `Run: yarn global add ${packageName}`;
		case "bun":
			return `Run: bun install -g ${packageName}`;
		case "npm":
			return `Run: npm install -g ${packageName}`;
		default:
			return `Run: npm install -g ${packageName}`;
	}
}

// =============================================================================
// 包资产路径（随可执行文件发布）
// =============================================================================

/**
 * 获取用于解析包资产（主题、package.json、README.md、CHANGELOG.md）的基本目录。
 * - 对于 Bun 二进制文件：返回包含可执行文件的目录
 * - 对于 Node.js (dist/)：返回 __dirname (dist/ 目录)
 * - 对于 tsx (src/)：返回父目录（包根目录）
 */
export function getPackageDir(): string {
	// 允许通过环境变量覆盖（对于存储路径分词效果不佳的 Nix/Guix 很有用）
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		// Bun 二进制文件：process.execPath 指向编译后的可执行文件
		return dirname(process.execPath);
	}
	// Node.js：从 __dirname 向上遍历直到找到 package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// 回退（不应发生）
	return __dirname;
}

/**
 * 获取内置主题目录的路径（随包发布）
 * - 对于 Bun 二进制文件：可执行文件旁边的 theme/
 * - 对于 Node.js (dist/)：dist/modes/interactive/theme/
 * - 对于 tsx (src/)：src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "theme");
	}
	// 主题位于相对于 src/ 或 dist/ 的 modes/interactive/theme/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * 获取 HTML 导出模板目录的路径（随包发布）
 * - 对于 Bun 二进制文件：可执行文件旁边的 export-html/
 * - 对于 Node.js (dist/)：dist/core/export-html/
 * - 对于 tsx (src/)：src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** 获取 package.json 的路径 */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** 获取 README.md 的路径 */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** 获取 docs 目录的路径 */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** 获取 examples 目录的路径 */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** 获取 CHANGELOG.md 的路径 */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

// =============================================================================
// 应用配置（来自 package.json piConfig）
// =============================================================================

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));

export const APP_NAME: string = pkg.piConfig?.name || "pi";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
export const VERSION: string = pkg.version;

// 例如：PI_CODING_AGENT_DIR 或 TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** 获取 gist ID 的分享查看器 URL */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// 用户配置路径 (~/.pi/agent/*)
// =============================================================================

/** 获取代理配置目录（例如：~/.pi/agent/） */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		// 将波浪号扩展为主目录
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** 获取用户自定义主题目录的路径 */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** 获取 models.json 的路径 */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** 获取 auth.json 的路径 */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** 获取 settings.json 的路径 */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** 获取 tools 目录的路径 */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** 获取托管二进制文件目录（fd, rg）的路径 */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** 获取提示词模板目录的路径 */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** 获取 sessions 目录的路径 */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** 获取调试日志文件的路径 */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}

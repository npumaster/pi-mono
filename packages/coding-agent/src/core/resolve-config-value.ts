/**
 * 解析可能是 shell 命令、环境变量或字面量的配置值。
 * 由 auth-storage.ts 和 model-registry.ts 使用。
 */

import { execSync } from "child_process";

// Shell 命令结果的缓存（在进程生命周期内持久存在）
const commandResultCache = new Map<string, string | undefined>();

/**
 * 将配置值（API 密钥、标头值等）解析为实际值。
 * - 如果以 "!" 开头，则将剩余部分作为 shell 命令执行并使用 stdout（缓存）
 * - 否则首先检查环境变量，然后视为字面量（不缓存）
 */
export function resolveConfigValue(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommand(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const command = commandConfig.slice(1);
	let result: string | undefined;
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		result = output.trim() || undefined;
	} catch {
		result = undefined;
	}

	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * 使用与 API 密钥相同的解析逻辑解析所有标头值。
 */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** 清除配置值命令缓存。导出用于测试。 */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}

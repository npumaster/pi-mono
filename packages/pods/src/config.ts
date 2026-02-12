import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Config, Pod } from "./types.js";

// 从环境变量获取配置目录或使用默认值
const getConfigDir = (): string => {
	const configDir = process.env.PI_CONFIG_DIR || join(homedir(), ".pi");
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}
	return configDir;
};

const getConfigPath = (): string => {
	return join(getConfigDir(), "pods.json");
};

export const loadConfig = (): Config => {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) {
		// 如果文件不存在，返回空配置
		return { pods: {} };
	}
	try {
		const data = readFileSync(configPath, "utf-8");
		return JSON.parse(data);
	} catch (e) {
		console.error(`Error reading config: ${e}`);
		return { pods: {} };
	}
};

export const saveConfig = (config: Config): void => {
	const configPath = getConfigPath();
	try {
		writeFileSync(configPath, JSON.stringify(config, null, 2));
	} catch (e) {
		console.error(`Error saving config: ${e}`);
		process.exit(1);
	}
};

export const getActivePod = (): { name: string; pod: Pod } | null => {
	const config = loadConfig();
	if (!config.active || !config.pods[config.active]) {
		return null;
	}
	return { name: config.active, pod: config.pods[config.active] };
};

export const addPod = (name: string, pod: Pod): void => {
	const config = loadConfig();
	config.pods[name] = pod;
	// 如果没有激活的 pod，将此 pod 设为激活状态
	if (!config.active) {
		config.active = name;
	}
	saveConfig(config);
};

export const removePod = (name: string): void => {
	const config = loadConfig();
	delete config.pods[name];
	// 如果这是激活的 pod，则清除激活状态
	if (config.active === name) {
		config.active = undefined;
	}
	saveConfig(config);
};

export const setActivePod = (name: string): void => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(`Pod '${name}' not found`);
		process.exit(1);
	}
	config.active = name;
	saveConfig(config);
};

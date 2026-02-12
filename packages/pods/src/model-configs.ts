import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { GPU } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ModelConfig {
	gpuCount: number;
	gpuTypes?: string[];
	args: string[];
	env?: Record<string, string>;
	notes?: string;
}

interface ModelInfo {
	name: string;
	configs: ModelConfig[];
	notes?: string;
}

interface ModelsData {
	models: Record<string, ModelInfo>;
}

// 加载模型配置 - 相对于此文件解析
const modelsJsonPath = join(__dirname, "models.json");
const modelsData: ModelsData = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));

/**
 * 根据可用 GPU 获取模型的最佳配置
 */
export const getModelConfig = (
	modelId: string,
	gpus: GPU[],
	requestedGpuCount: number,
): { args: string[]; env?: Record<string, string>; notes?: string } | null => {
	const modelInfo = modelsData.models[modelId];
	if (!modelInfo) {
		// 未知模型，无默认配置
		return null;
	}

	// 从第一个 GPU 名称中提取 GPU 类型（例如 "NVIDIA H200" -> "H200"）
	const gpuType = gpus[0]?.name?.replace("NVIDIA", "")?.trim()?.split(" ")[0] || "";

	// 寻找最佳匹配配置
	let bestConfig: ModelConfig | null = null;

	for (const config of modelInfo.configs) {
		// 检查 GPU 数量
		if (config.gpuCount !== requestedGpuCount) {
			continue;
		}

		// 如果指定了 GPU 类型，则进行检查
		if (config.gpuTypes && config.gpuTypes.length > 0) {
			const typeMatches = config.gpuTypes.some((type) => gpuType.includes(type) || type.includes(gpuType));
			if (!typeMatches) {
				continue;
			}
		}

		// 此配置匹配
		bestConfig = config;
		break;
	}

	// 如果没有精确匹配，尝试寻找一个 GPU 数量正确的配置
	if (!bestConfig) {
		for (const config of modelInfo.configs) {
			if (config.gpuCount === requestedGpuCount) {
				bestConfig = config;
				break;
			}
		}
	}

	if (!bestConfig) {
		// 未找到合适的配置
		return null;
	}

	return {
		args: [...bestConfig.args],
		env: bestConfig.env ? { ...bestConfig.env } : undefined,
		notes: bestConfig.notes || modelInfo.notes,
	};
};

/**
 * 检查模型是否已知
 */
export const isKnownModel = (modelId: string): boolean => {
	return modelId in modelsData.models;
};

/**
 * 获取所有已知模型
 */
export const getKnownModels = (): string[] => {
	return Object.keys(modelsData.models);
};

/**
 * 获取模型显示名称
 */
export const getModelName = (modelId: string): string => {
	return modelsData.models[modelId]?.name || modelId;
};

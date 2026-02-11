import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

// 处理默认和命名导出
const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

import type { Tool, ToolCall } from "../types.js";

// 检测我们是否处于具有严格 CSP 的浏览器扩展环境中
// 具有 Manifest V3 的 Chrome 扩展不允许使用 eval/Function 构造函数
const isBrowserExtension = typeof globalThis !== "undefined" && (globalThis as any).chrome?.runtime?.id !== undefined;

// 创建带有格式的单例 AJV 实例（仅当不在浏览器扩展中时）
// AJV 需要 'unsafe-eval' CSP，这在 Manifest V3 中是不允许的
let ajv: any = null;
if (!isBrowserExtension) {
	try {
		ajv = new Ajv({
			allErrors: true,
			strict: false,
			coerceTypes: true,
		});
		addFormats(ajv);
	} catch (_e) {
		// AJV 初始化失败（可能是 CSP 限制）
		console.warn("AJV validation disabled due to CSP restrictions");
	}
}

/**
 * 按名称查找工具并根据其 TypeBox 模式验证工具调用参数
 * @param tools 工具定义数组
 * @param toolCall 来自 LLM 的工具调用
 * @returns 经过验证的参数
 * @throws 如果找不到工具或验证失败则抛出 Error
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * 根据工具的 TypeBox 模式验证工具调用参数
 * @param tool 带有 TypeBox 模式的工具定义
 * @param toolCall 来自 LLM 的工具调用
 * @returns 经过验证（并可能强制转换）的参数
 * @throws 如果验证失败则抛出带有格式化消息的 Error
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	// 在浏览器扩展环境中跳过验证（CSP 限制阻止 AJV 工作）
	if (!ajv || isBrowserExtension) {
		// 无需验证即可信任 LLM 的输出
		// 由于 Manifest V3 CSP 限制，浏览器扩展无法使用 AJV
		return toolCall.arguments;
	}

	// 编译模式
	const validate = ajv.compile(tool.parameters);

	// 克隆参数，以便 AJV 可以安全地进行类型强制转换
	const args = structuredClone(toolCall.arguments);

	// 验证参数（AJV 会就地修改 args 以进行类型强制转换）
	if (validate(args)) {
		return args;
	}

	// 很好地格式化验证错误
	const errors =
		validate.errors
			?.map((err: any) => {
				const path = err.instancePath ? err.instancePath.substring(1) : err.params.missingProperty || "root";
				return `  - ${path}: ${err.message}`;
			})
			.join("\n") || "Unknown validation error";

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}

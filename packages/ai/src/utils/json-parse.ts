import { parse as partialParse } from "partial-json";

/**
 * 尝试解析流式传输期间可能不完整的 JSON。
 * 即使 JSON 不完整，也始终返回有效的对象。
 *
 * @param partialJson 来自流式传输的部分 JSON 字符串
 * @returns 解析的对象，如果解析失败则为空对象
 */
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	// 首先尝试标准解析（对于完整 JSON 最快）
	try {
		return JSON.parse(partialJson) as T;
	} catch {
		// 尝试 partial-json 解析不完整的 JSON
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			// 如果所有解析都失败，则返回空对象
			return {} as T;
		}
	}
}

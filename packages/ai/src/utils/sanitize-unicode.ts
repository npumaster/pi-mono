/**
 * 从字符串中移除不成对的 Unicode 代理字符。
 *
 * 不成对的代理（没有匹配低代理 0xDC00-0xDFFF 的高代理 0xD800-0xDBFF，
 * 或反之亦然）会导致许多 API 提供商的 JSON 序列化错误。
 *
 * 基本多语言平面之外的有效表情符号和其他字符使用正确配对的
 * 代理，并且不会受到此函数的影响。
 *
 * @param text - 要清理的文本
 * @returns 移除了不成对代理的清理后的文本
 *
 * @example
 * // Valid emoji (properly paired surrogates) are preserved
 * sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"
 *
 * // Unpaired high surrogate is removed
 * const unpaired = String.fromCharCode(0xD83D); // high surrogate without low
 * sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"
 */
export function sanitizeSurrogates(text: string): string {
	// 替换不成对的高代理（0xD800-0xDBFF 后面没有低代理）
	// 替换不成对的低代理（0xDC00-0xDFFF 前面没有高代理）
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

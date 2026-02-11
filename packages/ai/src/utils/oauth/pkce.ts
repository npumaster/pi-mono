/**
 * 使用 Web Crypto API 的 PKCE 实用程序。
 * 适用于 Node.js 20+ 和浏览器。
 */

/**
 * 将字节编码为 base64url 字符串。
 */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * 生成 PKCE 代码验证器和挑战。
 * 使用 Web Crypto API 以实现跨平台兼容性。
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// Generate random verifier
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// Compute SHA-256 challenge
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}

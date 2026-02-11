/**
 * AI 提供商的 OAuth 凭据管理。
 *
 * 此模块处理基于 OAuth 的提供商的登录、令牌刷新和凭据存储：
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 * - Google Cloud Code Assist (Gemini CLI)
 * - Antigravity (Gemini 3, Claude, GPT-OSS via Google Cloud)
 */

// 为 fetch() 调用设置 HTTP 代理（遵循 HTTP_PROXY, HTTPS_PROXY 环境变量）
import "../http-proxy.js";

// Anthropic
export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.js";
// GitHub Copilot
export {
	getGitHubCopilotBaseUrl,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.js";
// Google Antigravity
export { antigravityOAuthProvider, loginAntigravity, refreshAntigravityToken } from "./google-antigravity.js";
// Google Gemini CLI
export { geminiCliOAuthProvider, loginGeminiCli, refreshGoogleCloudToken } from "./google-gemini-cli.js";
// OpenAI Codex (ChatGPT OAuth)
export { loginOpenAICodex, openaiCodexOAuthProvider, refreshOpenAICodexToken } from "./openai-codex.js";

export * from "./types.js";

// ============================================================================
// 提供商注册表
// ============================================================================

import { anthropicOAuthProvider } from "./anthropic.js";
import { githubCopilotOAuthProvider } from "./github-copilot.js";
import { antigravityOAuthProvider } from "./google-antigravity.js";
import { geminiCliOAuthProvider } from "./google-gemini-cli.js";
import { openaiCodexOAuthProvider } from "./openai-codex.js";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.js";

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>([
	[anthropicOAuthProvider.id, anthropicOAuthProvider],
	[githubCopilotOAuthProvider.id, githubCopilotOAuthProvider],
	[geminiCliOAuthProvider.id, geminiCliOAuthProvider],
	[antigravityOAuthProvider.id, antigravityOAuthProvider],
	[openaiCodexOAuthProvider.id, openaiCodexOAuthProvider],
]);

/**
 * 通过 ID 获取 OAuth 提供商
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

/**
 * 注册自定义 OAuth 提供商
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

/**
 * 获取所有注册的 OAuth 提供商
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

/**
 * @deprecated 使用返回 OAuthProviderInterface[] 的 getOAuthProviders()
 */
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
	return getOAuthProviders().map((p) => ({
		id: p.id,
		name: p.name,
		available: true,
	}));
}

// ============================================================================
// 高级 API（使用提供商注册表）
// ============================================================================

/**
 * 刷新任何 OAuth 提供商的令牌。
 * @deprecated 请改用 getOAuthProvider(id).refreshToken()
 */
export async function refreshOAuthToken(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}
	return provider.refreshToken(credentials);
}

/**
 * 从 OAuth 凭据中获取提供商的 API 密钥。
 * 自动刷新过期的令牌。
 *
 * @returns API 密钥字符串和更新后的凭据，如果没有凭据则为 null
 * @throws 如果刷新失败则抛出 Error
 */
export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	// 如果已过期则刷新
	if (Date.now() >= creds.expires) {
		try {
			creds = await provider.refreshToken(creds);
		} catch (_error) {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}

/**
 * Anthropic OAuth 流程 (Claude Pro/Max)
 */

import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

/**
 * 使用 Anthropic OAuth 登录（设备代码流程）
 *
 * @param onAuthUrl - 处理授权 URL 的回调（例如，打开浏览器）
 * @param onPromptCode - 提示用户输入授权代码的回调
 */
export async function loginAnthropic(
	onAuthUrl: (url: string) => void,
	onPromptCode: () => Promise<string>,
): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	// 构建授权 URL
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});

	const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;

	// 通知调用者打开 URL
	onAuthUrl(authUrl);

	// 等待用户粘贴授权代码（格式：code#state）
	const authCode = await onPromptCode();
	const splits = authCode.split("#");
	const code = splits[0];
	const state = splits[1];

	// 用代码交换令牌
	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: code,
			state: state,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
	});

	if (!tokenResponse.ok) {
		const error = await tokenResponse.text();
		throw new Error(`Token exchange failed: ${error}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	// 计算过期时间（当前时间 + expires_in 秒 - 5 分钟缓冲）
	const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

	// 保存凭据
	return {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: expiresAt,
	};
}

/**
 * 刷新 Anthropic OAuth 令牌
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Anthropic token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAnthropic(
			(url) => callbacks.onAuth({ url }),
			() => callbacks.onPrompt({ message: "Paste the authorization code:" }),
		);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshAnthropicToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};

/**
 * Antigravity OAuth 流程 (Gemini 3, Claude, GPT-OSS via Google Cloud)
 * 使用与 google-gemini-cli 不同的 OAuth 凭据以访问其他模型。
 *
 * 注意：此模块使用 Node.js http.createServer 进行 OAuth 回调。
 * 它仅用于 CLI 使用，不适用于浏览器环境。
 */

import type { Server } from "node:http";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

type AntigravityCredentials = OAuthCredentials & {
	projectId: string;
};

let _createServer: typeof import("node:http").createServer | null = null;
let _httpImportPromise: Promise<void> | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	_httpImportPromise = import("node:http").then((m) => {
		_createServer = m.createServer;
	});
}

// Antigravity OAuth 凭据（与 Gemini CLI 不同）
const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const REDIRECT_URI = "http://localhost:51121/oauth-callback";

// Antigravity 需要额外的范围
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// 发现失败时的回退项目 ID
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

type CallbackServerInfo = {
	server: Server;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

/**
 * 启动本地 HTTP 服务器以接收 OAuth 回调
 */
async function getNodeCreateServer(): Promise<typeof import("node:http").createServer> {
	if (_createServer) return _createServer;
	if (_httpImportPromise) {
		await _httpImportPromise;
	}
	if (_createServer) return _createServer;
	throw new Error("Antigravity OAuth is only available in Node.js environments");
}

async function startCallbackServer(): Promise<CallbackServerInfo> {
	const createServer = await getNodeCreateServer();

	return new Promise((resolve, reject) => {
		let result: { code: string; state: string } | null = null;
		let cancelled = false;

		const server = createServer((req, res) => {
			const url = new URL(req.url || "", `http://localhost:51121`);

			if (url.pathname === "/oauth-callback") {
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						`<html><body><h1>Authentication Failed</h1><p>Error: ${error}</p><p>You can close this window.</p></body></html>`,
					);
					return;
				}

				if (code && state) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						`<html><body><h1>Authentication Successful</h1><p>You can close this window and return to the terminal.</p></body></html>`,
					);
					result = { code, state };
				} else {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						`<html><body><h1>Authentication Failed</h1><p>Missing code or state parameter.</p></body></html>`,
					);
				}
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(51121, "127.0.0.1", () => {
			resolve({
				server,
				cancelWait: () => {
					cancelled = true;
				},
				waitForCode: async () => {
					const sleep = () => new Promise((r) => setTimeout(r, 100));
					while (!result && !cancelled) {
						await sleep();
					}
					return result;
				},
			});
		});
	});
}

/**
 * 解析重定向 URL 以提取代码和状态
 */
function parseRedirectUrl(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// 不是 URL，返回空
		return {};
	}
}

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

/**
 * 为用户发现或配置项目
 */
async function discoverProject(accessToken: string, onProgress?: (message: string) => void): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		}),
	};

	// 按顺序尝试端点：首先是 prod，然后是 sandbox
	const endpoints = ["https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.sandbox.googleapis.com"];

	onProgress?.("Checking for existing project...");

	for (const endpoint of endpoints) {
		try {
			const loadResponse = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					metadata: {
						ideType: "IDE_UNSPECIFIED",
						platform: "PLATFORM_UNSPECIFIED",
						pluginType: "GEMINI",
					},
				}),
			});

			if (loadResponse.ok) {
				const data = (await loadResponse.json()) as LoadCodeAssistPayload;

				// 处理字符串和对象格式
				if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
					return data.cloudaicompanionProject;
				}
				if (
					data.cloudaicompanionProject &&
					typeof data.cloudaicompanionProject === "object" &&
					data.cloudaicompanionProject.id
				) {
					return data.cloudaicompanionProject.id;
				}
			}
		} catch {
			// 尝试下一个端点
		}
	}

	// 使用回退项目 ID
	onProgress?.("Using default project...");
	return DEFAULT_PROJECT_ID;
}

/**
 * 从访问令牌中获取用户电子邮件
 */
async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
	} catch {
		// 忽略错误，电子邮件是可选的
	}
	return undefined;
}

/**
 * 刷新 Antigravity 令牌
 */
export async function refreshAntigravityToken(refreshToken: string, projectId: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Antigravity token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	};

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
	};
}

/**
 * 使用 Antigravity OAuth 登录
 *
 * @param onAuth - 带有 URL 和可选说明的回调
 * @param onProgress - 可选的进度回调
 * @param onManualCodeInput - 可选的 Promise，解析为用户粘贴的重定向 URL。
 *                            与浏览器回调竞争 - 无论哪个先完成都会获胜。
 */
export async function loginAntigravity(
	onAuth: (info: { url: string; instructions?: string }) => void,
	onProgress?: (message: string) => void,
	onManualCodeInput?: () => Promise<string>,
): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	// 启动本地服务器进行回调
	onProgress?.("Starting local server for OAuth callback...");
	const server = await startCallbackServer();

	let code: string | undefined;

	try {
		// 构建授权 URL
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});

		const authUrl = `${AUTH_URL}?${authParams.toString()}`;

		// 通知调用者打开 URL
		onAuth({
			url: authUrl,
			instructions: "Complete the sign-in in your browser.",
		});

		// 等待回调，如果提供则与手动输入竞争
		onProgress?.("Waiting for OAuth callback...");

		if (onManualCodeInput) {
			// 浏览器回调和手动输入之间的竞争
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			// 如果手动输入被取消，则抛出该错误
			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				// 浏览器回调获胜 - 验证状态
				if (result.state !== verifier) {
					throw new Error("OAuth state mismatch - possible CSRF attack");
				}
				code = result.code;
			} else if (manualInput) {
				// 手动输入获胜
				const parsed = parseRedirectUrl(manualInput);
				if (parsed.state && parsed.state !== verifier) {
					throw new Error("OAuth state mismatch - possible CSRF attack");
				}
				code = parsed.code;
			}

			// 如果仍然没有代码，等待手动 Promise 并尝试
			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualInput) {
					const parsed = parseRedirectUrl(manualInput);
					if (parsed.state && parsed.state !== verifier) {
						throw new Error("OAuth state mismatch - possible CSRF attack");
					}
					code = parsed.code;
				}
			}
		} else {
			// 原始流程：仅等待回调
			const result = await server.waitForCode();
			if (result?.code) {
				if (result.state !== verifier) {
					throw new Error("OAuth state mismatch - possible CSRF attack");
				}
				code = result.code;
			}
		}

		if (!code) {
			throw new Error("No authorization code received");
		}

		// 用代码交换令牌
		onProgress?.("Exchanging authorization code for tokens...");
		const tokenResponse = await fetch(TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				code,
				grant_type: "authorization_code",
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

		if (!tokenData.refresh_token) {
			throw new Error("No refresh token received. Please try again.");
		}

		// 获取用户信息
		onProgress?.("Getting user info...");
		const email = await getUserEmail(tokenData.access_token);

		// 发现项目
		const projectId = await discoverProject(tokenData.access_token, onProgress);

		// 计算过期时间（当前时间 + expires_in 秒 - 5 分钟缓冲）
		const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

		const credentials: OAuthCredentials = {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: expiresAt,
			projectId,
			email,
		};

		return credentials;
	} finally {
		server.server.close();
	}
}

export const antigravityOAuthProvider: OAuthProviderInterface = {
	id: "google-antigravity",
	name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAntigravity(callbacks.onAuth, callbacks.onProgress, callbacks.onManualCodeInput);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as AntigravityCredentials;
		if (!creds.projectId) {
			throw new Error("Antigravity credentials missing projectId");
		}
		return refreshAntigravityToken(creds.refresh, creds.projectId);
	},

	getApiKey(credentials: OAuthCredentials): string {
		const creds = credentials as AntigravityCredentials;
		return JSON.stringify({ token: creds.access, projectId: creds.projectId });
	},
};

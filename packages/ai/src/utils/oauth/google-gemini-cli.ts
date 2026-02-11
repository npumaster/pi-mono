/**
 * Gemini CLI OAuth 流程 (Google Cloud Code Assist)
 * 仅标准 Gemini 模型 (gemini-2.0-flash, gemini-2.5-*)
 *
 * 注意：此模块使用 Node.js http.createServer 进行 OAuth 回调。
 * 它仅用于 CLI 使用，不适用于浏览器环境。
 */

import type { Server } from "node:http";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

type GeminiCredentials = OAuthCredentials & {
	projectId: string;
};

let _createServer: typeof import("node:http").createServer | null = null;
let _httpImportPromise: Promise<void> | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	_httpImportPromise = import("node:http").then((m) => {
		_createServer = m.createServer;
	});
}

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t",
);
const CLIENT_SECRET = decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=");
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

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
	throw new Error("Gemini CLI OAuth is only available in Node.js environments");
}

async function startCallbackServer(): Promise<CallbackServerInfo> {
	const createServer = await getNodeCreateServer();

	return new Promise((resolve, reject) => {
		let result: { code: string; state: string } | null = null;
		let cancelled = false;

		const server = createServer((req, res) => {
			const url = new URL(req.url || "", `http://localhost:8085`);

			if (url.pathname === "/oauth2callback") {
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

		server.listen(8085, "127.0.0.1", () => {
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
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

/**
 * 来自 onboardUser 的长时间运行操作响应
 */
interface LongRunningOperationResponse {
	name?: string;
	done?: boolean;
	response?: {
		cloudaicompanionProject?: { id?: string };
	};
}

// Cloud Code API 使用的层级 ID
const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";

interface GoogleRpcErrorResponse {
	error?: {
		details?: Array<{ reason?: string }>;
	};
}

/**
 * 载入重试的等待助手
 */
function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从允许的层级中获取默认层级
 */
function getDefaultTier(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): { id?: string } {
	if (!allowedTiers || allowedTiers.length === 0) return { id: TIER_LEGACY };
	const defaultTier = allowedTiers.find((t) => t.isDefault);
	return defaultTier ?? { id: TIER_LEGACY };
}

function isVpcScAffectedUser(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	if (!("error" in payload)) return false;
	const error = (payload as GoogleRpcErrorResponse).error;
	if (!error?.details || !Array.isArray(error.details)) return false;
	return error.details.some((detail) => detail.reason === "SECURITY_POLICY_VIOLATED");
}

/**
 * 轮询长时间运行的操作直到完成
 */
async function pollOperation(
	operationName: string,
	headers: Record<string, string>,
	onProgress?: (message: string) => void,
): Promise<LongRunningOperationResponse> {
	let attempt = 0;
	while (true) {
		if (attempt > 0) {
			onProgress?.(`Waiting for project provisioning (attempt ${attempt + 1})...`);
			await wait(5000);
		}

		const response = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, {
			method: "GET",
			headers,
		});

		if (!response.ok) {
			throw new Error(`Failed to poll operation: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as LongRunningOperationResponse;
		if (data.done) {
			return data;
		}

		attempt += 1;
	}
}

/**
 * 为用户发现或配置 Google Cloud 项目
 */
async function discoverProject(accessToken: string, onProgress?: (message: string) => void): Promise<string> {
	// 通过环境变量检查用户提供的项目 ID
	const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;

	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};

	// 尝试通过 loadCodeAssist 加载现有项目
	onProgress?.("Checking for existing Cloud Code Assist project...");
	const loadResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			cloudaicompanionProject: envProjectId,
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
				duetProject: envProjectId,
			},
		}),
	});

	let data: LoadCodeAssistPayload;

	if (!loadResponse.ok) {
		let errorPayload: unknown;
		try {
			errorPayload = await loadResponse.clone().json();
		} catch {
			errorPayload = undefined;
		}

		if (isVpcScAffectedUser(errorPayload)) {
			data = { currentTier: { id: TIER_STANDARD } };
		} else {
			const errorText = await loadResponse.text();
			throw new Error(`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`);
		}
	} else {
		data = (await loadResponse.json()) as LoadCodeAssistPayload;
	}

	// 如果用户已有当前层级和项目，则使用它
	if (data.currentTier) {
		if (data.cloudaicompanionProject) {
			return data.cloudaicompanionProject;
		}
		// 用户有层级但没有托管项目 - 他们需要通过环境变量提供一个
		if (envProjectId) {
			return envProjectId;
		}
		throw new Error(
			"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
				"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
		);
	}

	// 用户需要进行载入 - 获取默认层级
	const tier = getDefaultTier(data.allowedTiers);
	const tierId = tier?.id ?? TIER_FREE;

	if (tierId !== TIER_FREE && !envProjectId) {
		throw new Error(
			"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
				"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
		);
	}

	onProgress?.("Provisioning Cloud Code Assist project (this may take a moment)...");

	// 构建载入请求 - 对于免费层级，不包含项目 ID（Google 会配置一个）
	// 对于其他层级，如果可用，包含用户的项目 ID
	const onboardBody: Record<string, unknown> = {
		tierId,
		metadata: {
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		},
	};

	if (tierId !== TIER_FREE && envProjectId) {
		onboardBody.cloudaicompanionProject = envProjectId;
		(onboardBody.metadata as Record<string, unknown>).duetProject = envProjectId;
	}

	// 开始载入 - 这会返回一个长时间运行的操作
	const onboardResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		body: JSON.stringify(onboardBody),
	});

	if (!onboardResponse.ok) {
		const errorText = await onboardResponse.text();
		throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`);
	}

	let lroData = (await onboardResponse.json()) as LongRunningOperationResponse;

	// 如果操作尚未完成，轮询直到完成
	if (!lroData.done && lroData.name) {
		lroData = await pollOperation(lroData.name, headers, onProgress);
	}

	// 尝试从响应中获取项目 ID
	const projectId = lroData.response?.cloudaicompanionProject?.id;
	if (projectId) {
		return projectId;
	}

	// 如果载入没有返回项目 ID，回退到环境变量
	if (envProjectId) {
		return envProjectId;
	}

	throw new Error(
		"Could not discover or provision a Google Cloud project. " +
			"Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
			"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
	);
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
 * 刷新 Google Cloud Code Assist 令牌
 */
export async function refreshGoogleCloudToken(refreshToken: string, projectId: string): Promise<OAuthCredentials> {
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
		throw new Error(`Google Cloud token refresh failed: ${error}`);
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
 * 使用 Gemini CLI (Google Cloud Code Assist) OAuth 登录
 *
 * @param onAuth - 带有 URL 和可选说明的回调
 * @param onProgress - 可选的进度回调
 * @param onManualCodeInput - 可选的 Promise，解析为用户粘贴的重定向 URL。
 *                            与浏览器回调竞争 - 无论哪个先完成都会获胜。
 */
export async function loginGeminiCli(
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

export const geminiCliOAuthProvider: OAuthProviderInterface = {
	id: "google-gemini-cli",
	name: "Google Cloud Code Assist (Gemini CLI)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGeminiCli(callbacks.onAuth, callbacks.onProgress, callbacks.onManualCodeInput);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as GeminiCredentials;
		if (!creds.projectId) {
			throw new Error("Google Cloud credentials missing projectId");
		}
		return refreshGoogleCloudToken(creds.refresh, creds.projectId);
	},

	getApiKey(credentials: OAuthCredentials): string {
		const creds = credentials as GeminiCredentials;
		return JSON.stringify({ token: creds.access, projectId: creds.projectId });
	},
};

/**
 * API 密钥和 OAuth 令牌的凭据存储。
 * 处理从 auth.json 加载、保存和刷新凭据。
 *
 * 使用文件锁定以防止多个 pi 实例
 * 尝试同时刷新令牌时的竞争条件。
 */

import {
	getEnvApiKey,
	getOAuthApiKey,
	getOAuthProvider,
	getOAuthProviders,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@mariozechner/pi-ai";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.js";
import { resolveConfigValue } from "./resolve-config-value.js";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

/**
 * 由 JSON 文件支持的凭据存储。
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;

	constructor(private authPath: string = join(getAgentDir(), "auth.json")) {
		this.reload();
	}

	/**
	 * 设置运行时 API 密钥覆盖（不持久化到磁盘）。
	 * 用于 CLI --api-key 标志。
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * 移除运行时 API 密钥覆盖。
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * 设置用于在 auth.json 或环境变量中找不到的 API 密钥的回退解析器。
	 * 用于 models.json 中的自定义提供商密钥。
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	/**
	 * 从磁盘重新加载凭据。
	 */
	reload(): void {
		if (!existsSync(this.authPath)) {
			this.data = {};
			return;
		}
		try {
			this.data = JSON.parse(readFileSync(this.authPath, "utf-8"));
		} catch {
			this.data = {};
		}
	}

	/**
	 * 将凭据保存到磁盘。
	 */
	private save(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		writeFileSync(this.authPath, JSON.stringify(this.data, null, 2), "utf-8");
		chmodSync(this.authPath, 0o600);
	}

	/**
	 * 获取提供商的凭据。
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * 设置提供商的凭据。
	 */
	set(provider: string, credential: AuthCredential): void {
		this.data[provider] = credential;
		this.save();
	}

	/**
	 * 移除提供商的凭据。
	 */
	remove(provider: string): void {
		delete this.data[provider];
		this.save();
	}

	/**
	 * 列出所有具有凭据的提供商。
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * 检查 auth.json 中是否存在提供商的凭据。
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * 检查是否为提供商配置了任何形式的身份验证。
	 * 与 getApiKey() 不同，这不会刷新 OAuth 令牌。
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * 获取所有凭据（用于传递给 getOAuthApiKey）。
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	/**
	 * 登录到 OAuth 提供商。
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * 登出提供商。
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * 使用文件锁定刷新 OAuth 令牌以防止竞争条件。
	 * 当令牌过期时，多个 pi 实例可能会尝试同时刷新。
	 * 这确保只有一个实例刷新，而其他实例等待并使用结果。
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		// 确保 auth 文件存在以便锁定
		if (!existsSync(this.authPath)) {
			const dir = dirname(this.authPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
			}
			writeFileSync(this.authPath, "{}", "utf-8");
			chmodSync(this.authPath, 0o600);
		}

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfLockCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("OAuth refresh lock was compromised");
			}
		};

		try {
			// 获取排他锁，带重试和超时
			// 使用慷慨的重试窗口来处理慢速令牌端点
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000, // 30 秒后认为锁已过时
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfLockCompromised();

			// 获取锁后重新读取文件 - 另一个实例可能已经刷新
			this.reload();

			const cred = this.data[providerId];
			if (cred?.type !== "oauth") {
				return null;
			}

			// 检查重新读取后令牌是否仍然过期
			// （另一个实例可能已经刷新了它）
			if (Date.now() < cred.expires) {
				// 令牌现在有效 - 另一个实例刷新了它
				throwIfLockCompromised();
				const apiKey = provider.getApiKey(cred);
				return { apiKey, newCredentials: cred };
			}

			// 令牌仍然过期，我们需要刷新
			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(this.data)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const result = await getOAuthApiKey(providerId, oauthCreds);
			if (result) {
				throwIfLockCompromised();
				this.data[providerId] = { type: "oauth", ...result.newCredentials };
				this.save();
				throwIfLockCompromised();
				return result;
			}

			throwIfLockCompromised();
			return null;
		} finally {
			// 始终释放锁
			if (release) {
				try {
					await release();
				} catch {
					// 忽略解锁错误（锁可能已受损）
				}
			}
		}
	}

	/**
	 * 获取提供商的 API 密钥。
	 * 优先级：
	 * 1. 运行时覆盖 (CLI --api-key)
	 * 2. 来自 auth.json 的 API 密钥
	 * 3. 来自 auth.json 的 OAuth 令牌（带锁自动刷新）
	 * 4. 环境变量
	 * 5. 回退解析器（models.json 自定义提供商）
	 */
	async getApiKey(providerId: string): Promise<string | undefined> {
		// 运行时覆盖具有最高优先级
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			return resolveConfigValue(cred.key);
		}

		if (cred?.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) {
				// 未知的 OAuth 提供商，无法获取 API 密钥
				return undefined;
			}

			// 检查令牌是否需要刷新
			const needsRefresh = Date.now() >= cred.expires;

			if (needsRefresh) {
				// 使用锁定刷新以防止竞争条件
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId);
					if (result) {
						return result.apiKey;
					}
				} catch {
					// 刷新失败 - 重新读取文件以检查另一个实例是否成功
					this.reload();
					const updatedCred = this.data[providerId];

					if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
						// 另一个实例刷新成功，使用这些凭据
						return provider.getApiKey(updatedCred);
					}

					// 刷新确实失败 - 返回 undefined 以便模型发现跳过此提供商
					// 用户可以 /login 以重新验证（保留凭据以重试）
					return undefined;
				}
			} else {
				// 令牌未过期，使用当前访问令牌
				return provider.getApiKey(cred);
			}
		}

		// 回退到环境变量
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		// 回退到自定义解析器（例如，models.json 自定义提供商）
		return this.fallbackResolver?.(providerId) ?? undefined;
	}

	/**
	 * 获取所有注册的 OAuth 提供商
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}

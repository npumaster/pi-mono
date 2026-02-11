import type { Api, Model } from "../../types.js";

export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
};

export type OAuthProviderId = string;

/** @deprecated 请改用 OAuthProviderId */
export type OAuthProvider = OAuthProviderId;

export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};

export type OAuthAuthInfo = {
	url: string;
	instructions?: string;
};

export interface OAuthLoginCallbacks {
	onAuth: (info: OAuthAuthInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	signal?: AbortSignal;
}

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;

	/** 运行登录流程，返回凭据以持久保存 */
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;

	/** 登录是否使用本地回调服务器并支持手动输入代码。 */
	usesCallbackServer?: boolean;

	/** 刷新过期的凭据，返回更新后的凭据以持久保存 */
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;

	/** 将凭据转换为提供商的 API 密钥字符串 */
	getApiKey(credentials: OAuthCredentials): string;

	/** 可选：修改此提供商的模型（例如，更新 baseUrl） */
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

/** @deprecated 请改用 OAuthProviderInterface */
export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
}

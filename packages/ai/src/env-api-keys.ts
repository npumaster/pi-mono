// 切勿转换为顶层导入 - 会破坏浏览器/Vite 构建 (web-ui)
let _existsSync: typeof import("node:fs").existsSync | null = null;
let _homedir: typeof import("node:os").homedir | null = null;
let _join: typeof import("node:path").join | null = null;

// 仅在 Node.js/Bun 环境中急切加载
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:fs").then((m) => {
		_existsSync = m.existsSync;
	});
	import("node:os").then((m) => {
		_homedir = m.homedir;
	});
	import("node:path").then((m) => {
		_join = m.join;
	});
}

import type { KnownProvider } from "./types.js";

let cachedVertexAdcCredentialsExists: boolean | null = null;

function hasVertexAdcCredentials(): boolean {
	if (cachedVertexAdcCredentialsExists === null) {
		// 在浏览器中或如果 node 模块尚未加载，返回 false
		if (!_existsSync || !_homedir || !_join) {
			cachedVertexAdcCredentialsExists = false;
			return false;
		}

		// 首先检查 GOOGLE_APPLICATION_CREDENTIALS 环境变量（标准方式）
		const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
		if (gacPath) {
			cachedVertexAdcCredentialsExists = _existsSync(gacPath);
		} else {
			// 回退到默认 ADC 路径（延迟评估）
			cachedVertexAdcCredentialsExists = _existsSync(
				_join(_homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

/**
 * 从已知环境变量中获取提供商的 API 密钥，例如 OPENAI_API_KEY。
 *
 * 不会返回需要 OAuth 令牌的提供商的 API 密钥。
 */
export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(provider: any): string | undefined {
	// 回退到环境变量
	if (provider === "github-copilot") {
		return process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	}

	// ANTHROPIC_OAUTH_TOKEN 优先于 ANTHROPIC_API_KEY
	if (provider === "anthropic") {
		return process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
	}

	// Vertex AI 使用应用程序默认凭据，而不是 API 密钥。
	// 身份验证通过 `gcloud auth application-default login` 配置。
	if (provider === "google-vertex") {
		const hasCredentials = hasVertexAdcCredentials();
		const hasProject = !!(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT);
		const hasLocation = !!process.env.GOOGLE_CLOUD_LOCATION;

		if (hasCredentials && hasProject && hasLocation) {
			return "<authenticated>";
		}
	}

	if (provider === "amazon-bedrock") {
		// Amazon Bedrock 支持多种凭据来源：
		// 1. AWS_PROFILE - ~/.aws/credentials 中的命名配置文件
		// 2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY - 标准 IAM 密钥
		// 3. AWS_BEARER_TOKEN_BEDROCK - Bedrock API 密钥（承载令牌）
		// 4. AWS_CONTAINER_CREDENTIALS_RELATIVE_URI - ECS 任务角色
		// 5. AWS_CONTAINER_CREDENTIALS_FULL_URI - ECS 任务角色（完整 URI）
		// 6. AWS_WEB_IDENTITY_TOKEN_FILE - IRSA (IAM Roles for Service Accounts)
		if (
			process.env.AWS_PROFILE ||
			(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
			process.env.AWS_BEARER_TOKEN_BEDROCK ||
			process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
			process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
			process.env.AWS_WEB_IDENTITY_TOKEN_FILE
		) {
			return "<authenticated>";
		}
	}

	const envMap: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		"azure-openai-responses": "AZURE_OPENAI_API_KEY",
		google: "GEMINI_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
		zai: "ZAI_API_KEY",
		mistral: "MISTRAL_API_KEY",
		minimax: "MINIMAX_API_KEY",
		"minimax-cn": "MINIMAX_CN_API_KEY",
		huggingface: "HF_TOKEN",
		opencode: "OPENCODE_API_KEY",
		"kimi-coding": "KIMI_API_KEY",
	};

	const envVar = envMap[provider];
	return envVar ? process.env[envVar] : undefined;
}

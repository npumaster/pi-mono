import chalk from "chalk";
import { getActivePod, loadConfig } from "../config.js";

// ────────────────────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────────────────────

interface PromptOptions {
	pod?: string;
	apiKey?: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// 主提示函数
// ────────────────────────────────────────────────────────────────────────────────

export async function promptModel(modelName: string, userArgs: string[], opts: PromptOptions = {}) {
	// 获取 pod 和模型配置
	const activePod = opts.pod ? { name: opts.pod, pod: loadConfig().pods[opts.pod] } : getActivePod();

	if (!activePod) {
		console.error(chalk.red("没有激活的 pod。请使用 'pi pods active <name>' 设置一个。"));
		process.exit(1);
	}

	const { name: podName, pod } = activePod;
	const modelConfig = pod.models[modelName];

	if (!modelConfig) {
		console.error(chalk.red(`在 pod '${podName}' 上未找到模型 '${modelName}'`));
		process.exit(1);
	}

	// 从 SSH 字符串中提取主机名
	const host =
		pod.ssh
			.split(" ")
			.find((p) => p.includes("@"))
			?.split("@")[1] ?? "localhost";

	// 为代码导航构建系统提示词
	const systemPrompt = `您帮助用户理解和导航当前工作目录中的代码库。

您可以通过相应的工具读取文件、列出目录和执行 shell 命令。

除非被要求，否则不要直接输出您通过 read_file 工具读取的文件内容。

不要在您的回复中输出 markdown 表格。

保持您的回答简洁且与用户的请求相关。

您输出的文件路径必须尽可能包含行号，例如 "src/index.ts:10-20" 表示 src/index.ts 的第 10 到 20 行。

当前工作目录: ${process.cwd()}`;

	// 为 agent 主函数构建参数
	const args: string[] = [];

	// 添加我们控制的基础配置
	args.push(
		"--base-url",
		`http://${host}:${modelConfig.port}/v1`,
		"--model",
		modelConfig.model,
		"--api-key",
		opts.apiKey || process.env.PI_API_KEY || "dummy",
		"--api",
		modelConfig.model.toLowerCase().includes("gpt-oss") ? "responses" : "completions",
		"--system-prompt",
		systemPrompt,
	);

	// 透传所有用户提供的参数
	// 这包括消息、--continue、--json 等
	args.push(...userArgs);

	// 直接调用 agent 主函数
	try {
		throw new Error("尚未实现");
	} catch (err: any) {
		console.error(chalk.red(`Agent 错误: ${err.message}`));
		process.exit(1);
	}
}

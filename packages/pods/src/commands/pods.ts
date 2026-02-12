import chalk from "chalk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { addPod, loadConfig, removePod, setActivePod } from "../config.js";
import { scpFile, sshExec, sshExecStream } from "../ssh.js";
import type { GPU, Pod } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 列出所有 pod
 */
export const listPods = () => {
	const config = loadConfig();
	const podNames = Object.keys(config.pods);

	if (podNames.length === 0) {
		console.log("未配置 pod。使用 'pi pods setup' 添加 pod。");
		return;
	}

	console.log("已配置的 pod:");
	for (const name of podNames) {
		const pod = config.pods[name];
		const isActive = config.active === name;
		const marker = isActive ? chalk.green("*") : " ";
		const gpuCount = pod.gpus?.length || 0;
		const gpuInfo = gpuCount > 0 ? `${gpuCount}x ${pod.gpus[0].name}` : "未检测到 GPU";
		const vllmInfo = pod.vllmVersion ? ` (vLLM: ${pod.vllmVersion})` : "";
		console.log(`${marker} ${chalk.bold(name)} - ${gpuInfo}${vllmInfo} - ${pod.ssh}`);
		if (pod.modelsPath) {
			console.log(`    模型路径: ${pod.modelsPath}`);
		}
		if (pod.vllmVersion === "gpt-oss") {
			console.log(chalk.yellow(`    ⚠️  GPT-OSS 版本 - 仅适用于 GPT-OSS 模型`));
		}
	}
};

/**
 * 设置一个新 pod
 */
export const setupPod = async (
	name: string,
	sshCmd: string,
	options: { mount?: string; modelsPath?: string; vllm?: "release" | "nightly" | "gpt-oss" },
) => {
	// 验证环境变量
	const hfToken = process.env.HF_TOKEN;
	const vllmApiKey = process.env.PI_API_KEY;

	if (!hfToken) {
		console.error(chalk.red("错误: 需要 HF_TOKEN 环境变量"));
		console.error("从此处获取令牌: https://huggingface.co/settings/tokens");
		console.error("然后运行: export HF_TOKEN=您的令牌");
		process.exit(1);
	}

	if (!vllmApiKey) {
		console.error(chalk.red("错误: 需要 PI_API_KEY 环境变量"));
		console.error("设置 API 密钥: export PI_API_KEY=您的密钥");
		process.exit(1);
	}

	// 确定模型路径
	let modelsPath = options.modelsPath;
	if (!modelsPath && options.mount) {
		// 如果没有明确提供，则从挂载命令中提取路径
		// 例如 "mount -t nfs ... /mnt/sfs" -> "/mnt/sfs"
		const parts = options.mount.split(" ");
		modelsPath = parts[parts.length - 1];
	}

	if (!modelsPath) {
		console.error(chalk.red("错误: 需要 --models-path (或必须能从 --mount 中提取)"));
		process.exit(1);
	}

	console.log(chalk.green(`正在设置 pod '${name}'...`));
	console.log(`SSH: ${sshCmd}`);
	console.log(`模型路径: ${modelsPath}`);
	console.log(
		`vLLM 版本: ${options.vllm || "release"} ${options.vllm === "gpt-oss" ? chalk.yellow("(GPT-OSS 特殊版本)") : ""}`,
	);
	if (options.mount) {
		console.log(`挂载命令: ${options.mount}`);
	}
	console.log("");

	// 测试 SSH 连接
	console.log("正在测试 SSH 连接...");
	const testResult = await sshExec(sshCmd, "echo 'SSH OK'");
	if (testResult.exitCode !== 0) {
		console.error(chalk.red("SSH 连接失败"));
		console.error(testResult.stderr);
		process.exit(1);
	}
	console.log(chalk.green("✓ SSH 连接成功"));

	// 复制设置脚本
	console.log("正在复制设置脚本...");
	const scriptPath = join(__dirname, "../../scripts/pod_setup.sh");
	const success = await scpFile(sshCmd, scriptPath, "/tmp/pod_setup.sh");
	if (!success) {
		console.error(chalk.red("复制设置脚本失败"));
		process.exit(1);
	}
	console.log(chalk.green("✓ 设置脚本已复制"));

	// 构建设置命令
	let setupCmd = `bash /tmp/pod_setup.sh --models-path '${modelsPath}' --hf-token '${hfToken}' --vllm-api-key '${vllmApiKey}'`;
	if (options.mount) {
		setupCmd += ` --mount '${options.mount}'`;
	}
	// 添加 vLLM 版本标志
	const vllmVersion = options.vllm || "release";
	setupCmd += ` --vllm '${vllmVersion}'`;

	// 运行设置脚本
	console.log("");
	console.log(chalk.yellow("正在运行设置 (大约需要 2-5 分钟)..."));
	console.log("");

	// 使用 forceTTY 以保留来自 apt, pip 等命令的颜色
	const exitCode = await sshExecStream(sshCmd, setupCmd, { forceTTY: true });
	if (exitCode !== 0) {
		console.error(chalk.red("\n设置失败。请检查上方输出中的错误。"));
		process.exit(1);
	}

	// 从设置输出中解析 GPU 信息
	console.log("");
	console.log("正在检测 GPU 配置...");
	const gpuResult = await sshExec(sshCmd, "nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader");

	const gpus: GPU[] = [];
	if (gpuResult.exitCode === 0 && gpuResult.stdout) {
		const lines = gpuResult.stdout.trim().split("\n");
		for (const line of lines) {
			const [id, name, memory] = line.split(",").map((s) => s.trim());
			if (id !== undefined) {
				gpus.push({
					id: parseInt(id, 10),
					name: name || "未知",
					memory: memory || "未知",
				});
			}
		}
	}

	console.log(chalk.green(`✓ 检测到 ${gpus.length} 个 GPU`));
	for (const gpu of gpus) {
		console.log(`  GPU ${gpu.id}: ${gpu.name} (${gpu.memory})`);
	}

	// 保存 pod 配置
	const pod: Pod = {
		ssh: sshCmd,
		gpus,
		models: {},
		modelsPath,
		vllmVersion: options.vllm || "release",
	};

	addPod(name, pod);
	console.log("");
	console.log(chalk.green(`✓ Pod '${name}' 设置完成并设为激活状态`));
	console.log("");
	console.log("您现在可以使用以下命令部署模型:");
	console.log(chalk.cyan(`  pi start <model> --name <name>`));
};

/**
 * 切换激活的 pod
 */
export const switchActivePod = (name: string) => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(chalk.red(`未找到 Pod '${name}'`));
		console.log("\n可用 pod:");
		for (const podName of Object.keys(config.pods)) {
			console.log(`  ${podName}`);
		}
		process.exit(1);
	}

	setActivePod(name);
	console.log(chalk.green(`✓ 已将激活 pod 切换为 '${name}'`));
};

/**
 * 从配置中移除一个 pod
 */
export const removePodCommand = (name: string) => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(chalk.red(`未找到 Pod '${name}'`));
		process.exit(1);
	}

	removePod(name);
	console.log(chalk.green(`✓ 已从配置中移除 pod '${name}'`));
	console.log(chalk.yellow("注意: 这仅移除本地配置。远程 pod 不受影响。"));
};

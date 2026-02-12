import chalk from "chalk";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getActivePod, loadConfig, saveConfig } from "../config.js";
import { getModelConfig, getModelName, isKnownModel } from "../model-configs.js";
import { sshExec } from "../ssh.js";
import type { Pod } from "../types.js";

/**
 * 获取要使用的 pod（激活的或覆盖的）
 */
const getPod = (podOverride?: string): { name: string; pod: Pod } => {
	if (podOverride) {
		const config = loadConfig();
		const pod = config.pods[podOverride];
		if (!pod) {
			console.error(chalk.red(`未找到 Pod '${podOverride}'`));
			process.exit(1);
		}
		return { name: podOverride, pod };
	}

	const active = getActivePod();
	if (!active) {
		console.error(chalk.red("没有激活的 pod。请使用 'pi pods active <name>' 设置一个。"));
		process.exit(1);
	}
	return active;
};

/**
 * 寻找从 8001 开始的下一个可用端口
 */
const getNextPort = (pod: Pod): number => {
	const usedPorts = Object.values(pod.models).map((m) => m.port);
	let port = 8001;
	while (usedPorts.includes(port)) {
		port++;
	}
	return port;
};

/**
 * 为模型部署选择 GPU（轮询方式）
 */
const selectGPUs = (pod: Pod, count: number = 1): number[] => {
	if (count === pod.gpus.length) {
		// 使用所有 GPU
		return pod.gpus.map((g) => g.id);
	}

	// 统计所有模型中的 GPU 使用情况
	const gpuUsage = new Map<number, number>();
	for (const gpu of pod.gpus) {
		gpuUsage.set(gpu.id, 0);
	}

	for (const model of Object.values(pod.models)) {
		for (const gpuId of model.gpu) {
			gpuUsage.set(gpuId, (gpuUsage.get(gpuId) || 0) + 1);
		}
	}

	// 按使用情况排序（使用最少的排在前面）
	const sortedGPUs = Array.from(gpuUsage.entries())
		.sort((a, b) => a[1] - b[1])
		.map((entry) => entry[0]);

	// 返回使用最少的 GPU
	return sortedGPUs.slice(0, count);
};

/**
 * 启动一个模型
 */
export const startModel = async (
	modelId: string,
	name: string,
	options: {
		pod?: string;
		vllmArgs?: string[];
		memory?: string;
		context?: string;
		gpus?: number;
	},
) => {
	const { name: podName, pod } = getPod(options.pod);

	// 验证
	if (!pod.modelsPath) {
		console.error(chalk.red("Pod 未配置模型路径"));
		process.exit(1);
	}
	if (pod.models[name]) {
		console.error(chalk.red(`模型 '${name}' 已存在于 pod '${podName}' 上`));
		process.exit(1);
	}

	const port = getNextPort(pod);

	// 确定 GPU 分配和 vLLM 参数
	let gpus: number[] = [];
	let vllmArgs: string[] = [];
	let modelConfig = null;

	if (options.vllmArgs?.length) {
		// 自定义参数覆盖所有设置
		vllmArgs = options.vllmArgs;
		console.log(chalk.gray("使用自定义 vLLM 参数，GPU 分配由 vLLM 管理"));
	} else if (isKnownModel(modelId)) {
		// 处理已知模型的 --gpus 参数
		if (options.gpus) {
			// 验证 GPU 数量
			if (options.gpus > pod.gpus.length) {
				console.error(chalk.red(`错误：请求了 ${options.gpus} 个 GPU，但 pod 只有 ${pod.gpus.length} 个`));
				process.exit(1);
			}

			// 尝试查找所请求 GPU 数量的配置
			modelConfig = getModelConfig(modelId, pod.gpus, options.gpus);
			if (modelConfig) {
				gpus = selectGPUs(pod, options.gpus);
				vllmArgs = [...(modelConfig.args || [])];
			} else {
				console.error(
					chalk.red(`模型 '${getModelName(modelId)}' 没有针对 ${options.gpus} 个 GPU 的配置`),
				);
				console.error(chalk.yellow("可用配置："));

				// 显示可用配置
				for (let gpuCount = 1; gpuCount <= pod.gpus.length; gpuCount++) {
					const config = getModelConfig(modelId, pod.gpus, gpuCount);
					if (config) {
						console.error(chalk.gray(`  - ${gpuCount} 个 GPU`));
					}
				}
				process.exit(1);
			}
		} else {
			// 为此硬件寻找最佳配置（原始行为）
			for (let gpuCount = pod.gpus.length; gpuCount >= 1; gpuCount--) {
				modelConfig = getModelConfig(modelId, pod.gpus, gpuCount);
				if (modelConfig) {
					gpus = selectGPUs(pod, gpuCount);
					vllmArgs = [...(modelConfig.args || [])];
					break;
				}
			}
			if (!modelConfig) {
				console.error(chalk.red(`模型 '${getModelName(modelId)}' 与此 pod 的 GPU 不兼容`));
				process.exit(1);
			}
		}
	} else {
		// 未知模型
		if (options.gpus) {
			console.error(chalk.red("错误：--gpus 只能用于预定义模型"));
			console.error(chalk.yellow("对于自定义模型，请使用 --vllm 并配合 tensor-parallel-size 或类似参数"));
			process.exit(1);
		}
		// 默认单 GPU
		gpus = selectGPUs(pod, 1);
		console.log(chalk.gray("未知模型，默认为单 GPU"));
	}

	// 应用内存/上下文覆盖
	if (!options.vllmArgs?.length) {
		if (options.memory) {
			const fraction = parseFloat(options.memory.replace("%", "")) / 100;
			vllmArgs = vllmArgs.filter((arg) => !arg.includes("gpu-memory-utilization"));
			vllmArgs.push("--gpu-memory-utilization", String(fraction));
		}
		if (options.context) {
			const contextSizes: Record<string, number> = {
				"4k": 4096,
				"8k": 8192,
				"16k": 16384,
				"32k": 32768,
				"64k": 65536,
				"128k": 131072,
			};
			const maxTokens = contextSizes[options.context.toLowerCase()] || parseInt(options.context, 10);
			vllmArgs = vllmArgs.filter((arg) => !arg.includes("max-model-len"));
			vllmArgs.push("--max-model-len", String(maxTokens));
		}
	}

	// 显示操作内容
	console.log(chalk.green(`正在 pod '${podName}' 上启动模型 '${name}'...`));
	console.log(`模型: ${modelId}`);
	console.log(`端口: ${port}`);
	console.log(`GPU: ${gpus.length ? gpus.join(", ") : "由 vLLM 管理"}`);
	if (modelConfig?.notes) console.log(chalk.yellow(`备注: ${modelConfig.notes}`));
	console.log("");

	// 读取并根据我们的值自定义 model_run.sh 脚本
	const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/model_run.sh");
	let scriptContent = readFileSync(scriptPath, "utf-8");

	// 替换占位符 - 不需要转义，带有 'EOF' 的 heredoc 是字面量
	scriptContent = scriptContent
		.replace("{{MODEL_ID}}", modelId)
		.replace("{{NAME}}", name)
		.replace("{{PORT}}", String(port))
		.replace("{{VLLM_ARGS}}", vllmArgs.join(" "));

	// 上传自定义脚本
	await sshExec(
		pod.ssh,
		`cat > /tmp/model_run_${name}.sh << 'EOF'
${scriptContent}
EOF
chmod +x /tmp/model_run_${name}.sh`,
	);

	// 准备环境
	const env = [
		`HF_TOKEN='${process.env.HF_TOKEN}'`,
		`PI_API_KEY='${process.env.PI_API_KEY}'`,
		`HF_HUB_ENABLE_HF_TRANSFER=1`,
		`VLLM_NO_USAGE_STATS=1`,
		`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`,
		`FORCE_COLOR=1`,
		`TERM=xterm-256color`,
		...(gpus.length === 1 ? [`CUDA_VISIBLE_DEVICES=${gpus[0]}`] : []),
		...Object.entries(modelConfig?.env || {}).map(([k, v]) => `${k}='${v}'`),
	]
		.map((e) => `export ${e}`)
		.join("\n");

	// 使用伪终端（保留颜色）的脚本命令启动模型运行器
	// 注意：我们使用 script 命令来保留颜色并创建一个日志文件
	// setsid 创建一个新会话，以便在 SSH 断开连接后继续运行
	const startCmd = `
		${env}
		mkdir -p ~/.vllm_logs
		# 创建一个监控脚本命令的包装器
		cat > /tmp/model_wrapper_${name}.sh << 'WRAPPER'
#!/bin/bash
script -q -f -c "/tmp/model_run_${name}.sh" ~/.vllm_logs/${name}.log
exit_code=$?
echo "脚本退出，代码为 $exit_code" >> ~/.vllm_logs/${name}.log
exit $exit_code
WRAPPER
		chmod +x /tmp/model_wrapper_${name}.sh
		setsid /tmp/model_wrapper_${name}.sh </dev/null >/dev/null 2>&1 &
		echo $!
		exit 0
	`;

	const pidResult = await sshExec(pod.ssh, startCmd);
	const pid = parseInt(pidResult.stdout.trim(), 10);
	if (!pid) {
		console.error(chalk.red("启动模型运行器失败"));
		process.exit(1);
	}

	// 保存到配置
	const config = loadConfig();
	config.pods[podName].models[name] = { model: modelId, port, gpu: gpus, pid };
	saveConfig(config);

	console.log(`模型运行器已启动，PID 为: ${pid}`);
	console.log("正在流式传输日志...（等待启动）\n");

	// 稍作延迟以确保日志文件已创建
	await new Promise((resolve) => setTimeout(resolve, 500));

	// 支持颜色的流式传输日志，观察启动是否完成
	const sshParts = pod.ssh.split(" ");
	const sshCommand = sshParts[0]; // "ssh"
	const sshArgs = sshParts.slice(1); // ["root@86.38.238.55"]
	const host = sshArgs[0].split("@")[1] || "localhost";
	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;

	// 为 spawn 构建完整的参数数组
	const fullArgs = [...sshArgs, tailCmd];

	const logProcess = spawn(sshCommand, fullArgs, {
		stdio: ["inherit", "pipe", "pipe"], // 捕获标准输出和标准错误
		env: { ...process.env, FORCE_COLOR: "1" },
	});

	let interrupted = false;
	let startupComplete = false;
	let startupFailed = false;
	let failureReason = "";

	// 处理 Ctrl+C
	const sigintHandler = () => {
		interrupted = true;
		logProcess.kill();
	};
	process.on("SIGINT", sigintHandler);

	// 逐行处理日志输出
	const processOutput = (data: Buffer) => {
		const lines = data.toString().split("\n");
		for (const line of lines) {
			if (line) {
				console.log(line); // 将行回显到控制台

				// 检查启动完成消息
				if (line.includes("Application startup complete")) {
					startupComplete = true;
					logProcess.kill(); // 停止追踪日志
				}

				// 检查失败指示器
				if (line.includes("Model runner exiting with code") && !line.includes("code 0")) {
					startupFailed = true;
					failureReason = "模型运行器启动失败";
					logProcess.kill();
				}
				if (line.includes("Script exited with code") && !line.includes("code 0")) {
					startupFailed = true;
					failureReason = "脚本执行失败";
					logProcess.kill();
				}
				if (line.includes("torch.OutOfMemoryError") || line.includes("CUDA out of memory")) {
					startupFailed = true;
					failureReason = "GPU 显存不足 (OOM)";
					// 不要立即终止 - 让它显示更多错误上下文
				}
				if (line.includes("RuntimeError: Engine core initialization failed")) {
					startupFailed = true;
					failureReason = "vLLM 引擎初始化失败";
					logProcess.kill();
				}
			}
		}
	};

	logProcess.stdout?.on("data", processOutput);
	logProcess.stderr?.on("data", processOutput);

	await new Promise<void>((resolve) => logProcess.on("exit", resolve));
	process.removeListener("SIGINT", sigintHandler);

	if (startupFailed) {
		// 模型启动失败 - 清理并报告错误
		console.log(`\n${chalk.red(`✗ 模型启动失败: ${failureReason}`)}`);

		// 从配置中移除失败的模型
		const config = loadConfig();
		delete config.pods[podName].models[name];
		saveConfig(config);

		console.log(chalk.yellow("\n模型已从配置中移除。"));

		// 根据失败原因提供有用的建议
		if (failureReason.includes("OOM") || failureReason.includes("memory")) {
			console.log(`\n${chalk.bold("建议:")}`);
			console.log("  • 尝试降低 GPU 显存利用率: --memory 50%");
			console.log("  • 使用较小的上下文窗口: --context 4k");
			console.log("  • 使用模型的量化版本 (例如 FP8)");
			console.log("  • 通过张量并行使用更多 GPU");
			console.log("  • 尝试较小的模型变体");
		}

		console.log(`\n${chalk.cyan(`查看完整日志: pi ssh "tail -100 ~/.vllm_logs/${name}.log"`)}`);
		process.exit(1);
	} else if (startupComplete) {
		// 模型启动成功 - 输出连接详情
		console.log(`\n${chalk.green("✓ 模型启动成功！")}`);
		console.log(`\n${chalk.bold("连接详情:")}`);
		console.log(chalk.cyan("─".repeat(50)));
		console.log(chalk.white("Base URL:    ") + chalk.yellow(`http://${host}:${port}/v1`));
		console.log(chalk.white("Model:       ") + chalk.yellow(modelId));
		console.log(chalk.white("API Key:     ") + chalk.yellow(process.env.PI_API_KEY || "(未设置)"));
		console.log(chalk.cyan("─".repeat(50)));

		console.log(`\n${chalk.bold("导出到 shell:")}`);
		console.log(chalk.gray(`export OPENAI_BASE_URL="http://${host}:${port}/v1"`));
		console.log(chalk.gray(`export OPENAI_API_KEY="${process.env.PI_API_KEY || "your-api-key"}"`));
		console.log(chalk.gray(`export OPENAI_MODEL="${modelId}"`));

		console.log(`\n${chalk.bold("使用示例:")}`);
		console.log(
			chalk.gray(`
  # Python
  from openai import OpenAI
  client = OpenAI()  # 使用环境变量
  response = client.chat.completions.create(
      model="${modelId}",
      messages=[{"role": "user", "content": "Hello!"}]
  )

  # CLI
  curl $OPENAI_BASE_URL/chat/completions \\
    -H "Authorization: Bearer $OPENAI_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hi"}]}'`),
		);
		console.log("");
		console.log(chalk.cyan(`与模型对话:    pi agent ${name} "您的消息"`));
		console.log(chalk.cyan(`交互模式:      pi agent ${name} -i`));
		console.log(chalk.cyan(`监控日志:      pi logs ${name}`));
		console.log(chalk.cyan(`停止模型:      pi stop ${name}`));
	} else if (interrupted) {
		console.log(chalk.yellow("\n\n已停止监控。模型部署在后台继续进行。"));
		console.log(chalk.cyan(`与模型对话:    pi agent ${name} "您的消息"`));
		console.log(chalk.cyan(`检查状态:      pi logs ${name}`));
		console.log(chalk.cyan(`停止模型:      pi stop ${name}`));
	} else {
		console.log(chalk.yellow("\n\n日志流已结束。模型可能仍在运行。"));
		console.log(chalk.cyan(`与模型对话:    pi agent ${name} "您的消息"`));
		console.log(chalk.cyan(`检查状态:      pi logs ${name}`));
		console.log(chalk.cyan(`停止模型:      pi stop ${name}`));
	}
};

/**
 * 停止一个模型
 */
export const stopModel = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`在 pod '${podName}' 上未找到模型 '${name}'`));
		process.exit(1);
	}

	console.log(chalk.yellow(`正在停止 pod '${podName}' 上的模型 '${name}'...`));

	// 杀死脚本进程及其所有子进程
	// 使用 pkill 杀死进程及所有子进程
	const killCmd = `
		# 杀死脚本进程及其所有子进程
		pkill -TERM -P ${model.pid} 2>/dev/null || true
		kill ${model.pid} 2>/dev/null || true
	`;
	await sshExec(pod.ssh, killCmd);

	// 从配置中移除
	const config = loadConfig();
	delete config.pods[podName].models[name];
	saveConfig(config);

	console.log(chalk.green(`✓ 模型 '${name}' 已停止`));
};

/**
 * 停止 pod 上的所有模型
 */
export const stopAllModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`pod '${podName}' 上没有正在运行的模型`);
		return;
	}

	console.log(chalk.yellow(`正在停止 pod '${podName}' 上的 ${modelNames.length} 个模型...`));

	// 杀死所有脚本进程及其子进程
	const pids = Object.values(pod.models).map((m) => m.pid);
	const killCmd = `
		for PID in ${pids.join(" ")}; do
			pkill -TERM -P $PID 2>/dev/null || true
			kill $PID 2>/dev/null || true
		done
	`;
	await sshExec(pod.ssh, killCmd);

	// 从配置中清除所有模型
	const config = loadConfig();
	config.pods[podName].models = {};
	saveConfig(config);

	console.log(chalk.green(`✓ 已停止所有模型: ${modelNames.join(", ")}`));
};

/**
 * 列出所有模型
 */
export const listModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`pod '${podName}' 上没有正在运行的模型`);
		return;
	}

	// 获取用于 URL 显示的 pod SSH 主机
	const sshParts = pod.ssh.split(" ");
	const host = sshParts.find((p) => p.includes("@"))?.split("@")[1] || "unknown";

	console.log(`pod '${chalk.bold(podName)}' 上的模型:`);
	for (const name of modelNames) {
		const model = pod.models[name];
		const gpuStr =
			model.gpu.length > 1
				? `GPU ${model.gpu.join(",")}`
				: model.gpu.length === 1
					? `GPU ${model.gpu[0]}`
					: "GPU 未知";
		console.log(`  ${chalk.green(name)} - 端口 ${model.port} - ${gpuStr} - PID ${model.pid}`);
		console.log(`    模型: ${chalk.gray(model.model)}`);
		console.log(`    URL: ${chalk.cyan(`http://${host}:${model.port}/v1`)}`);
	}

	// 可选地验证进程是否仍在运行
	console.log("");
	console.log("正在验证进程...");
	let anyDead = false;
	for (const name of modelNames) {
		const model = pod.models[name];
		// 检查包装进程是否存在以及 vLLM 是否有响应
		const checkCmd = `
			# 检查包装进程是否存在
			if ps -p ${model.pid} > /dev/null 2>&1; then
				# 进程存在，现在检查 vLLM 是否有响应
				if curl -s -f http://localhost:${model.port}/health > /dev/null 2>&1; then
					echo "running"
				else
					# 检查是否仍在启动中
					if tail -n 20 ~/.vllm_logs/${name}.log 2>/dev/null | grep -q "ERROR\\|Failed\\|Cuda error\\|died"; then
						echo "crashed"
					else
						echo "starting"
					fi
				fi
			else
				echo "dead"
			fi
		`;
		const result = await sshExec(pod.ssh, checkCmd);
		const status = result.stdout.trim();
		if (status === "dead") {
			console.log(chalk.red(`  ${name}: 进程 ${model.pid} 未运行`));
			anyDead = true;
		} else if (status === "crashed") {
			console.log(chalk.red(`  ${name}: vLLM 已崩溃 (请通过 'pi logs ${name}' 检查日志)`));
			anyDead = true;
		} else if (status === "starting") {
			console.log(chalk.yellow(`  ${name}: 仍在启动中...`));
		}
	}

	if (anyDead) {
		console.log("");
		console.log(chalk.yellow("某些模型未运行。请通过以下命令清理:"));
		console.log(chalk.cyan("  pi stop <name>"));
	} else {
		console.log(chalk.green("✓ 所有进程已验证"));
	}
};

/**
 * 查看模型日志
 */
export const viewLogs = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`在 pod '${podName}' 上未找到模型 '${name}'`));
		process.exit(1);
	}

	console.log(chalk.green(`正在流式传输 pod '${podName}' 上 '${name}' 的日志...`));
	console.log(chalk.gray("按 Ctrl+C 停止"));
	console.log("");

	// 保留颜色的流式传输日志
	const sshParts = pod.ssh.split(" ");
	const sshCommand = sshParts[0]; // "ssh"
	const sshArgs = sshParts.slice(1); // ["root@86.38.238.55"]
	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;

	const logProcess = spawn(sshCommand, [...sshArgs, tailCmd], {
		stdio: "inherit",
		env: {
			...process.env,
			FORCE_COLOR: "1",
		},
	});

	// 等待进程退出
	await new Promise<void>((resolve) => {
		logProcess.on("exit", () => resolve());
	});
};

/**
 * 显示已知模型及其硬件要求
 */
export const showKnownModels = async () => {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const modelsJsonPath = join(__dirname, "..", "models.json");
	const modelsJson = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
	const models = modelsJson.models;

	// 获取激活的 pod 信息（如果有）
	const activePod = getActivePod();
	let podGpuCount = 0;
	let podGpuType = "";

	if (activePod) {
		podGpuCount = activePod.pod.gpus.length;
		// 从名称中提取 GPU 类型 (例如 "NVIDIA H200" -> "H200")
		podGpuType = activePod.pod.gpus[0]?.name?.replace("NVIDIA", "")?.trim()?.split(" ")[0] || "";

		console.log(chalk.bold(`适用于 ${activePod.name} (${podGpuCount}x ${podGpuType || "GPU"}) 的已知模型:\n`));
	} else {
		console.log(chalk.bold("已知模型:\n"));
		console.log(chalk.yellow("没有激活的 pod。使用 'pi pods active <name>' 来过滤兼容的模型。\n"));
	}

	console.log("用法: pi start <model> --name <name> [options]\n");

	// 按兼容性和系列对模型进行分组
	const compatible: Record<string, Array<{ id: string; name: string; config: string; notes?: string }>> = {};
	const incompatible: Record<string, Array<{ id: string; name: string; minGpu: string; notes?: string }>> = {};

	for (const [modelId, info] of Object.entries(models)) {
		const modelInfo = info as any;
		const family = modelInfo.name.split("-")[0] || "其他";

		let isCompatible = false;
		let compatibleConfig = "";
		let minGpu = "未知";
		let minNotes: string | undefined;

		if (modelInfo.configs && modelInfo.configs.length > 0) {
			// 按 GPU 数量对配置进行排序以找到最低要求
			const sortedConfigs = [...modelInfo.configs].sort((a: any, b: any) => (a.gpuCount || 1) - (b.gpuCount || 1));

			// 找到最低要求
			const minConfig = sortedConfigs[0];
			const minGpuCount = minConfig.gpuCount || 1;
			const gpuTypes = minConfig.gpuTypes?.join("/") || "H100/H200";

			if (minGpuCount === 1) {
				minGpu = `1x ${gpuTypes}`;
			} else {
				minGpu = `${minGpuCount}x ${gpuTypes}`;
			}

			minNotes = minConfig.notes || modelInfo.notes;

			// 检查与激活 pod 的兼容性
			if (activePod && podGpuCount > 0) {
				// 为此 pod 寻找最佳匹配配置
				for (const config of sortedConfigs) {
					const configGpuCount = config.gpuCount || 1;
					const configGpuTypes = config.gpuTypes || [];

					// 检查是否有足够的 GPU
					if (configGpuCount <= podGpuCount) {
						// 检查 GPU 类型是否匹配 (如果已指定)
						if (
							configGpuTypes.length === 0 ||
							configGpuTypes.some((type: string) => podGpuType.includes(type) || type.includes(podGpuType))
						) {
							isCompatible = true;
							if (configGpuCount === 1) {
								compatibleConfig = `1x ${podGpuType}`;
							} else {
								compatibleConfig = `${configGpuCount}x ${podGpuType}`;
							}
							minNotes = config.notes || modelInfo.notes;
							break;
						}
					}
				}
			}
		}

		const modelEntry = {
			id: modelId,
			name: modelInfo.name,
			notes: minNotes,
		};

		if (activePod && isCompatible) {
			if (!compatible[family]) {
				compatible[family] = [];
			}
			compatible[family].push({ ...modelEntry, config: compatibleConfig });
		} else {
			if (!incompatible[family]) {
				incompatible[family] = [];
			}
			incompatible[family].push({ ...modelEntry, minGpu });
		}
	}

	// 首先显示兼容的模型
	if (activePod && Object.keys(compatible).length > 0) {
		console.log(chalk.green.bold("✓ 兼容的模型:\n"));

		const sortedFamilies = Object.keys(compatible).sort();
		for (const family of sortedFamilies) {
			console.log(chalk.cyan(`${family} 模型:`));

			const modelList = compatible[family].sort((a, b) => a.name.localeCompare(b.name));

			for (const model of modelList) {
				console.log(`  ${chalk.green(model.id)}`);
				console.log(`    名称: ${model.name}`);
				console.log(`    配置: ${model.config}`);
				if (model.notes) {
					console.log(chalk.gray(`    备注: ${model.notes}`));
				}
				console.log("");
			}
		}
	}

	// 显示不兼容的模型
	if (Object.keys(incompatible).length > 0) {
		if (activePod && Object.keys(compatible).length > 0) {
			console.log(chalk.red.bold("✗ 不兼容的模型 (需要更多/不同的 GPU):\n"));
		}

		const sortedFamilies = Object.keys(incompatible).sort();
		for (const family of sortedFamilies) {
			if (!activePod) {
				console.log(chalk.cyan(`${family} 模型:`));
			} else {
				console.log(chalk.gray(`${family} 模型:`));
			}

			const modelList = incompatible[family].sort((a, b) => a.name.localeCompare(b.name));

			for (const model of modelList) {
				const color = activePod ? chalk.gray : chalk.green;
				console.log(`  ${color(model.id)}`);
				console.log(chalk.gray(`    名称: ${model.name}`));
				console.log(chalk.gray(`    最低硬件要求: ${model.minGpu}`));
				if (model.notes && !activePod) {
					console.log(chalk.gray(`    备注: ${model.notes}`));
				}
				if (activePod) {
					console.log(""); // 过滤后对不兼容模型显示较少的信息
				} else {
					console.log("");
				}
			}
		}
	}

	console.log(chalk.gray("\n对于未知模型，默认为单 GPU 部署。"));
	console.log(chalk.gray("使用 --vllm 向 vLLM 传递自定义参数。"));
};

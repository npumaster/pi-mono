import { type SpawnOptions, spawn } from "child_process";

export interface SSHResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * 执行 SSH 命令并返回结果
 */
export const sshExec = async (
	sshCmd: string,
	command: string,
	options?: { keepAlive?: boolean },
): Promise<SSHResult> => {
	return new Promise((resolve) => {
		// 解析 SSH 命令（例如 "ssh root@1.2.3.4" 或 "ssh -p 22 root@1.2.3.4"）
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];
		let sshArgs = [...sshParts.slice(1)];

		// 为长时间运行的命令添加 SSH 保持连接选项
		if (options?.keepAlive) {
			// ServerAliveInterval=30 每 30 秒发送一次保持连接信号
			// ServerAliveCountMax=120 允许最多 120 次失败（共 60 分钟）
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		sshArgs.push(command);

		const proc = spawn(sshBinary, sshArgs, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({
				stdout,
				stderr,
				exitCode: code || 0,
			});
		});

		proc.on("error", (err) => {
			resolve({
				stdout,
				stderr: err.message,
				exitCode: 1,
			});
		});
	});
};

/**
 * 执行 SSH 命令并将输出流式传输到控制台
 */
export const sshExecStream = async (
	sshCmd: string,
	command: string,
	options?: { silent?: boolean; forceTTY?: boolean; keepAlive?: boolean },
): Promise<number> => {
	return new Promise((resolve) => {
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];

		// 构建 SSH 参数
		let sshArgs = [...sshParts.slice(1)];

		// 如果有要求且尚未存在，则添加 -t 标志
		if (options?.forceTTY && !sshParts.includes("-t")) {
			sshArgs = ["-t", ...sshArgs];
		}

		// 为长时间运行的命令添加 SSH 保持连接选项
		if (options?.keepAlive) {
			// ServerAliveInterval=30 每 30 秒发送一次保持连接信号
			// ServerAliveCountMax=120 允许最多 120 次失败（共 60 分钟）
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		sshArgs.push(command);

		const spawnOptions: SpawnOptions = options?.silent
			? { stdio: ["ignore", "ignore", "ignore"] }
			: { stdio: "inherit" };

		const proc = spawn(sshBinary, sshArgs, spawnOptions);

		proc.on("close", (code) => {
			resolve(code || 0);
		});

		proc.on("error", () => {
			resolve(1);
		});
	});
};

/**
 * 通过 SCP 将文件复制到远程
 */
export const scpFile = async (sshCmd: string, localPath: string, remotePath: string): Promise<boolean> => {
	// 从 SSH 命令中提取主机名
	const sshParts = sshCmd.split(" ").filter((p) => p);
	let host = "";
	let port = "22";
	let i = 1; // 跳过 'ssh'

	while (i < sshParts.length) {
		if (sshParts[i] === "-p" && i + 1 < sshParts.length) {
			port = sshParts[i + 1];
			i += 2;
		} else if (!sshParts[i].startsWith("-")) {
			host = sshParts[i];
			break;
		} else {
			i++;
		}
	}

	if (!host) {
		console.error("Could not parse host from SSH command");
		return false;
	}

	// 构建 SCP 命令
	const scpArgs = ["-P", port, localPath, `${host}:${remotePath}`];

	return new Promise((resolve) => {
		const proc = spawn("scp", scpArgs, { stdio: "inherit" });

		proc.on("close", (code) => {
			resolve(code === 0);
		});

		proc.on("error", () => {
			resolve(false);
		});
	});
};

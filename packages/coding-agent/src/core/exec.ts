/**
 * 扩展和自定义工具的共享命令执行实用程序。
 */

import { spawn } from "node:child_process";

/**
 * 执行 shell 命令的选项。
 */
export interface ExecOptions {
	/** 取消命令的 AbortSignal */
	signal?: AbortSignal;
	/** 以毫秒为单位的超时时间 */
	timeout?: number;
	/** 工作目录 */
	cwd?: string;
}

/**
 * 执行 shell 命令的结果。
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * 执行 shell 命令并返回 stdout/stderr/code。
 * 支持超时和中止信号。
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// 如果 SIGTERM 不起作用，则在 5 秒后强制终止
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// 处理中止信号
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// 处理超时
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (timeoutId) clearTimeout(timeoutId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
			resolve({ stdout, stderr, code: code ?? 0, killed });
		});

		proc.on("error", (_err) => {
			if (timeoutId) clearTimeout(timeoutId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
			// 对于生成错误，如果它没有被终止，我们将解析为一个错误代码
			resolve({ stdout, stderr, code: 1, killed });
		});
	});
}

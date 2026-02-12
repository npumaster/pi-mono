import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile, writeFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";

export interface Attachment {
	original: string; // 上传者的原始文件名
	local: string; // 相对于工作目录的路径（例如："C12345/attachments/1732531234567_file.png"）
}

export interface LoggedMessage {
	date: string; // ISO 8601 日期（例如："2025-11-26T10:44:00.000Z"），便于使用 grep 搜索
	ts: string; // Slack 时间戳或纪元毫秒数
	user: string; // 用户 ID（对于机器人回复则为 "bot"）
	userName?: string; // 用户名（例如："mario"）
	displayName?: string; // 显示名称（例如："Mario Zechner"）
	text: string;
	attachments: Attachment[];
	isBot: boolean;
}

export interface ChannelStoreConfig {
	workingDir: string;
	botToken: string; // 用于经过身份验证的文件下载
}

interface PendingDownload {
	channelId: string;
	localPath: string; // 相对路径
	url: string;
}

export class ChannelStore {
	private workingDir: string;
	private botToken: string;
	private pendingDownloads: PendingDownload[] = [];
	private isDownloading = false;
	// 跟踪最近记录的消息时间戳以防止重复
	// 键："channelId:ts"，60 秒后自动清除
	private recentlyLogged = new Map<string, number>();

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;

		// 确保工作目录存在
		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	/**
	 * 获取或创建频道/私聊的目录
	 */
	getChannelDir(channelId: string): string {
		const dir = join(this.workingDir, channelId);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	/**
	 * 为附件生成唯一的本地文件名
	 */
	generateLocalFilename(originalName: string, timestamp: string): string {
		// 将 Slack 时间戳 (1234567890.123456) 转换为毫秒
		const ts = Math.floor(parseFloat(timestamp) * 1000);
		// 清理原始文件名（移除有问题的内容）
		const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${ts}_${sanitized}`;
	}

	/**
	 * 处理来自 Slack 消息事件的附件
	 * 返回附件元数据并排队下载
	 */
	processAttachments(
		channelId: string,
		files: Array<{ name?: string; url_private_download?: string; url_private?: string }>,
		timestamp: string,
	): Attachment[] {
		const attachments: Attachment[] = [];

		for (const file of files) {
			const url = file.url_private_download || file.url_private;
			if (!url) continue;
			if (!file.name) {
				log.logWarning("Attachment missing name, skipping", url);
				continue;
			}

			const filename = this.generateLocalFilename(file.name, timestamp);
			const localPath = `${channelId}/attachments/${filename}`;

			attachments.push({
				original: file.name,
				local: localPath,
			});

			// 排入后台下载队列
			this.pendingDownloads.push({ channelId, localPath, url });
		}

		// 触发后台下载
		this.processDownloadQueue();

		return attachments;
	}

	/**
	 * 将消息记录到频道的 log.jsonl 文件中
	 * 如果消息已记录（重复），则返回 false
	 */
	async logMessage(channelId: string, message: LoggedMessage): Promise<boolean> {
		// 检查重复（相同频道 + 时间戳）
		const dedupeKey = `${channelId}:${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false; // 已记录
		}

		// 标记为已记录并安排在 60 秒后清除
		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);

		const logPath = join(this.getChannelDir(channelId), "log.jsonl");

		// 确保消息具有日期字段
		if (!message.date) {
			// 解析时间戳以获取日期
			let date: Date;
			if (message.ts.includes(".")) {
				// Slack 时间戳格式 (1234567890.123456)
				date = new Date(parseFloat(message.ts) * 1000);
			} else {
				// 纪元毫秒数
				date = new Date(parseInt(message.ts, 10));
			}
			message.date = date.toISOString();
		}

		const line = `${JSON.stringify(message)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	/**
	 * 记录机器人回复
	 */
	async logBotResponse(channelId: string, text: string, ts: string): Promise<void> {
		await this.logMessage(channelId, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	/**
	 * 获取频道最后一条记录消息的时间戳
	 * 如果日志不存在，则返回 null
	 */
	getLastTimestamp(channelId: string): string | null {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		if (!existsSync(logPath)) {
			return null;
		}

		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			if (lines.length === 0 || lines[0] === "") {
				return null;
			}
			const lastLine = lines[lines.length - 1];
			const message = JSON.parse(lastLine) as LoggedMessage;
			return message.ts;
		} catch {
			return null;
		}
	}

	/**
	 * 在后台处理下载队列
	 */
	private async processDownloadQueue(): Promise<void> {
		if (this.isDownloading || this.pendingDownloads.length === 0) return;

		this.isDownloading = true;

		while (this.pendingDownloads.length > 0) {
			const item = this.pendingDownloads.shift();
			if (!item) break;

			try {
				await this.downloadAttachment(item.localPath, item.url);
				// 成功 - 如果有上下文，可以在此处添加成功日志
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				log.logWarning(`Failed to download attachment`, `${item.localPath}: ${errorMsg}`);
			}
		}

		this.isDownloading = false;
	}

	/**
	 * Download a single attachment
	 */
	private async downloadAttachment(localPath: string, url: string): Promise<void> {
		const filePath = join(this.workingDir, localPath);

		// Ensure directory exists
		const dir = join(this.workingDir, localPath.substring(0, localPath.lastIndexOf("/")));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${this.botToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const buffer = await response.arrayBuffer();
		await writeFile(filePath, Buffer.from(buffer));
	}
}

export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string; // 技能名称，命令/工具/标志名称，提示词名称，主题名称
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // 例如，"npm:foo", "git:...", "local"
	loserSource?: string;
}

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: ResourceCollision;
}

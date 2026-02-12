// pi 的核心类型定义

export interface GPU {
	id: number;
	name: string;
	memory: string;
}

export interface Model {
	model: string;
	port: number;
	gpu: number[]; // 用于多 GPU 部署的 GPU ID 数组
	pid: number;
}

export interface Pod {
	ssh: string;
	gpus: GPU[];
	models: Record<string, Model>;
	modelsPath?: string;
	vllmVersion?: "release" | "nightly" | "gpt-oss"; // 跟踪已安装的 vLLM 版本
}

export interface Config {
	pods: Record<string, Pod>;
	active?: string;
}

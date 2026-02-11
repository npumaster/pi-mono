# Pi

Pi 自动化了在 DataCrunch, Vast.ai, Prime Intellect, RunPod（或任何带有 NVIDIA GPU 的 Ubuntu 机器）上的 vLLM 部署。它通过单独的 vLLM 实例管理多个并发模型部署，每个实例都可以通过带有 API 密钥认证的 OpenAI API 协议访问。

Pods 被视为临时的 - 需要时启动，用完时拆除。为了避免重新下载模型（100GB+ 模型需要 30+ 分钟），pi 使用持久性网络卷进行模型存储，可以在同一提供商的 pod 之间共享。这最大限度地减少了成本（仅为活动计算付费）和设置时间（模型已缓存）。

## 用法

### Pods
```bash
pi pods setup dc1 "ssh root@1.2.3.4" --mount "mount -t nfs..."  # 设置 pod（需要 HF_TOKEN, PI_API_KEY 环境变量）
pi pods                              # 列出所有 pods（* = 活动）
pi pods active dc2                   # 切换活动 pod
pi pods remove dc1                   # 移除 pod
```

### 模型
```bash
pi start Qwen/Qwen2.5-72B-Instruct --name qwen72b          # 已知模型 - pi 处理 vLLM 参数
pi start some/unknown-model --name mymodel --vllm --tensor-parallel-size 4 --max-model-len 32768  # 自定义 vLLM 参数
pi list                              # 列出运行中的模型及其端口
pi stop qwen72b                      # 停止模型
pi logs qwen72b                      # 查看模型日志
```

对于已知模型，pi 会根据 pod 的硬件从模型文档中自动配置适当的 vLLM 参数。对于未知模型或自定义配置，请在 `--vllm` 之后传递 vLLM 参数。

## Pod 管理

Pi 将来自不同提供商（DataCrunch, Vast.ai, Prime Intellect, RunPod）的 GPU pod 管理为临时计算资源。用户通过提供商仪表板手动创建 pod，然后向 pi 注册以进行自动设置和管理。

主要功能：
- **Pod 设置**：在约 2 分钟内将裸 Ubuntu/Debian 机器转换为 vLLM 就绪环境
- **模型缓存**：可选的持久存储，由 pod 共享，以避免重新下载 100GB+ 模型
- **多 Pod 管理**：注册多个 pod，在它们之间切换，维护不同的环境

### Pod 设置

当用户在提供商上创建一个新的 pod 时，他们使用来自提供商的 SSH 命令向 pi 注册它：

```bash
pi pods setup dc1 "ssh root@1.2.3.4" --mount "mount -t nfs..."
```

这会复制并执行 `pod_setup.sh`，它会：
1. 通过 `nvidia-smi` 检测 GPU 并将数量/内存存储在本地配置中
2. 安装与驱动程序版本匹配的 CUDA 工具包
3. 创建 Python 环境
   - 安装 uv 和 Python 3.12
   - 在 ~/venv 创建 venv，带有 PyTorch (--torch-backend=auto)
   - 安装 vLLM（需要时安装特定于模型的版本）
   - 安装 FlashInfer（如果需要，从源构建）
   - 安装 huggingface-hub（用于模型下载）
   - 安装 hf-transfer（用于加速下载）
4. 如果提供，则挂载持久存储
   - 符号链接到 ~/.cache/huggingface 以进行模型缓存
5. 持久配置环境变量

必需的环境变量：
- `HF_TOKEN`: 用于模型下载的 HuggingFace 令牌
- `PI_API_KEY`: 用于保护 vLLM 端点的 API 密钥

### 模型缓存

模型可能超过 100GB，下载需要 30+ 分钟。`--mount` 标志启用持久模型缓存：

- **DataCrunch**: NFS 共享文件系统，可在同一区域的多个运行 pod 之间挂载
- **RunPod**: 网络卷独立持久化，但不能在运行的 pod 之间共享
- **Vast.ai**: 卷锁定到特定机器 - 无法共享
- **Prime Intellect**: 未记录持久存储

如果没有 `--mount`，模型将下载到 pod 本地存储，并在终止时丢失。

### 多 Pod 管理

用户可以注册多个 pod 并在它们之间切换：

```bash
pi pods                    # 列出所有 pods（* = 活动）
pi pods active dc2         # 切换活动 pod
pi pods remove dc1         # 从本地配置中移除 pod，但不会远程销毁 pod。
```

所有模型命令（`pi start`, `pi stop` 等）都针对活动 pod，除非给出了 `--pod <podname>`，这会覆盖该命令的活动 pod。

## 模型部署

Pi 使用直接 SSH 命令来管理 pod 上的 vLLM 实例。不需要远程管理器组件 - 一切都从本地 pi CLI 控制。

### 架构
pi CLI 将所有状态保存在本地 `~/.pi/pods.json`：
```json
{
  "pods": {
    "dc1": {
      "ssh": "ssh root@1.2.3.4",
      "gpus": [
        {"id": 0, "name": "H100", "memory": "80GB"},
        {"id": 1, "name": "H100", "memory": "80GB"}
      ],
      "models": {
        "qwen": {
          "model": "Qwen/Qwen2.5-72B",
          "port": 8001,
          "gpu": "0",
          "pid": 12345
        }
      }
    }
  },
  "active": "dc1"
}
```

pi 配置目录的位置也可以通过 `PI_CONFIG_DIR` 环境变量指定，例如用于测试。

Pods 被假定为完全由 pi 管理 - 没有其他进程争夺端口或 GPU。

### 启动模型
当用户运行 `pi start Qwen/Qwen2.5-72B --name qwen`：
1. CLI 确定下一个可用端口（从 8001 开始）
2. 选择 GPU（基于存储的 GPU 信息轮询）
3. 如果未缓存，则下载模型：
   - 设置 `HF_HUB_ENABLE_HF_TRANSFER=1` 以进行快速下载
   - 通过 SSH 运行，输出管道传输到本地终端
   - Ctrl+C 取消下载并返回控制权
4. 构建带有适当参数和 PI_API_KEY 的 vLLM 命令
5. 通过 SSH 执行：`ssh pod "nohup vllm serve ... > ~/.vllm_logs/qwen.log 2>&1 & echo $!"`
6. 等待 vLLM 准备就绪（检查健康端点）
7. 成功时：将端口、GPU、PID 存储在本地状态
8. 失败时：显示 vLLM 日志中的确切错误，不保存到配置

### 管理模型
- **List**: 从本地状态显示模型，可选地验证 PID 是否仍在运行
- **Stop**: SSH 通过 PID 杀死进程
- **Logs**: SSH tail -f 日志文件（Ctrl+C 停止 tail，不杀死 vLLM）

### 错误处理
- **SSH 故障**: 提示用户检查连接或从配置中移除 pod
- **陈旧状态**: 失败并显示“进程未找到”的命令会自动清理本地状态
- **设置故障**: 设置期间的 Ctrl+C 杀死远程脚本并干净地退出

### 测试模型
`pi prompt` 命令提供了一种测试已部署模型的快速方法：
```bash
pi prompt qwen "What is 2+2?"                    # 简单提示
pi prompt qwen "Read file.txt and summarize"     # 使用内置工具
```

用于代理测试的内置工具：
- `ls(path, ignore?)`: 列出路径处的文件和目录，带有可选的忽略模式
- `read(file_path, offset?, limit?)`: 读取文件内容，带有可选的行偏移/限制
- `glob(pattern, path?)`: 查找匹配 glob 模式的文件（例如 "**/*.py", "src/**/*.ts"）
- `rg(args)`: 使用任何参数运行 ripgrep（例如 "pattern -t py -C 3", "TODO --type-not test"）

提供的提示将增加有关当前本地工作目录的信息。文件工具需要绝对路径。

这允许在没有外部工具配置的情况下测试基本的代理能力。

`prompt` 使用用于 NodeJS 的最新 OpenAI SDK 实现。它输出思考内容、工具调用和结果以及正常的助手消息。

## 模型
我们希望专门支持这些模型，替代模型被标记为“可能工作”。此列表将定期更新新模型。选中的框表示“支持”。

请参阅 [models.md](./models.md) 以获取模型列表、它们的硬件要求、vLLM 参数和说明，我们希望通过简单的 `pi start <model-name> --name <local-name>` 开箱即用地支持它们。

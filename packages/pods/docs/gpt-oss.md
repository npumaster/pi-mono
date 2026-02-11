# `gpt-oss` vLLM 使用指南

`gpt-oss-20b` 和 `gpt-oss-120b` 是 OpenAI 开源的强大推理模型。
在 vLLM 中，你可以在 NVIDIA H100、H200、B200 以及 MI300x、MI325x、MI355x 和 Radeon AI PRO R9700 上运行它。
我们正在积极努力确保此模型可以在 Ampere、Ada Lovelace 和 RTX 5090 上运行。
具体来说，vLLM 针对 `gpt-oss` 系列模型进行了优化，包括：

* **灵活的并行选项**：模型可以分片到 2、4、8 个 GPU 上，从而扩展吞吐量。
* **高性能注意力机制和 MoE 内核**：注意力内核专门针对注意力汇（attention sinks）机制和滑动窗口形状进行了优化。
* **异步调度**：通过重叠 CPU 操作与 GPU 操作，优化最大利用率和高吞吐量。

这是一份动态文档，我们欢迎贡献、更正和创建新的配方！

## 快速入门

### 安装

我们强烈建议使用新的虚拟环境，因为发布的第一次迭代需要来自各种依赖项的尖端内核，这些内核可能无法与其他模型一起工作。特别是，我们将安装：vLLM 的预发布版本、PyTorch nightly、Triton nightly、FlashInfer 预发布版本、HuggingFace 预发布版本、Harmony 和 gpt-oss 库工具。

```
uv venv
source .venv/bin/activate

uv pip install --pre vllm==0.10.1+gptoss \
    --extra-index-url https://wheels.vllm.ai/gpt-oss/ \
    --extra-index-url https://download.pytorch.org/whl/nightly/cu128 \
    --index-strategy unsafe-best-match
```

我们还提供了一个内置所有依赖项的 docker 容器

```
docker run --gpus all \
    -p 8000:8000 \
    --ipc=host \
    vllm/vllm-openai:gptoss \
    --model openai/gpt-oss-20b
```

### H100 & H200

你可以使用默认参数为模型提供服务：

* `--async-scheduling` 可以启用以获得更高的性能。目前它与结构化输出不兼容。
* 我们建议对于 H100 和 H200，使用 TP=2 作为最佳性能权衡点。

```
# openai/gpt-oss-20b 应该在单 GPU 上运行
vllm serve openai/gpt-oss-20b --async-scheduling

# gpt-oss-120b 可以适应单个 H100/H200，但将其扩展到更高的 TP 大小有助于提高吞吐量
vllm serve openai/gpt-oss-120b --async-scheduling
vllm serve openai/gpt-oss-120b --tensor-parallel-size 2 --async-scheduling
vllm serve openai/gpt-oss-120b --tensor-parallel-size 4 --async-scheduling
```

### B200

NVIDIA Blackwell 需要安装 FlashInfer 库和几个环境来启用必要的内核。我们建议使用 TP=1 作为高性能选项的起点。我们正在积极致力于 vLLM 在 Blackwell 上的性能。

```
# 这 3 个都是必需的
export VLLM_USE_TRTLLM_ATTENTION=1
export VLLM_USE_TRTLLM_DECODE_ATTENTION=1
export VLLM_USE_TRTLLM_CONTEXT_ATTENTION=1

# 只能选其中一个。
# mxfp8 激活用于 MoE。更快，但准确性风险更高。
export VLLM_USE_FLASHINFER_MXFP4_MOE=1
# bf16 激活用于 MoE。匹配参考精度。
export VLLM_USE_FLASHINFER_MXFP4_BF16_MOE=1

# openai/gpt-oss-20b
vllm serve openai/gpt-oss-20b --async-scheduling

# gpt-oss-120b
vllm serve openai/gpt-oss-120b --async-scheduling
vllm serve openai/gpt-oss-120b --tensor-parallel-size 2 --async-scheduling
vllm serve openai/gpt-oss-120b --tensor-parallel-size 4 --async-scheduling
```

### AMD

ROCm 在这 3 种不同的 GPU 上支持 OpenAI gpt-oss-120b 或 gpt-oss-20b 模型，以及预构建的 docker 容器：

* gfx950: MI350x 系列, `rocm/vllm-dev:open-mi355-08052025`
* gfx942: MI300x/MI325 系列, `rocm/vllm-dev:open-mi300-08052025`
* gfx1201: Radeon AI PRO R9700, `rocm/vllm-dev:open-r9700-08052025`

运行容器：

```
alias drun='sudo docker run -it --network=host --device=/dev/kfd --device=/dev/dri --group-add=video --ipc=host --cap-add=SYS_PTRACE --security-opt seccomp=unconfined --shm-size 32G -v /data:/data -v $HOME:/myhome -w /myhome'

drun rocm/vllm-dev:open-mi300-08052025
```

对于 MI300x 和 R9700：

```
export VLLM_ROCM_USE_AITER=1
export VLLM_USE_AITER_UNIFIED_ATTENTION=1
export VLLM_ROCM_USE_AITER_MHA=0

vllm serve openai/gpt-oss-120b --compilation-config '{"full_cuda_graph": true}'
```

对于 MI355x：

```
# MoE 预洗牌、融合和 Triton GEMM 标志
export VLLM_USE_AITER_TRITON_FUSED_SPLIT_QKV_ROPE=1
export VLLM_USE_AITER_TRITON_FUSED_ADD_RMSNORM_PAD=1
export VLLM_USE_AITER_TRITON_GEMM=1
export VLLM_ROCM_USE_AITER=1
export VLLM_USE_AITER_UNIFIED_ATTENTION=1
export VLLM_ROCM_USE_AITER_MHA=0
export TRITON_HIP_PRESHUFFLE_SCALES=1

vllm serve openai/gpt-oss-120b --compilation-config '{"compile_sizes": [1, 2, 4, 8, 16, 24, 32, 64, 128, 256, 4096, 8192], "full_cuda_graph": true}' --block-size 64
```

## 用法

一旦 `vllm serve` 运行并且显示 `INFO: Application startup complete`，你可以使用 HTTP 请求或 OpenAI SDK 向以下端点发送请求：

* `/v1/responses` 端点可以在思维链之间执行工具使用（浏览、python、mcp）并提供最终响应。此端点利用 `openai-harmony` 库进行输入渲染和输出解析。有状态操作和完整的流式 API 正在开发中。OpenAI 推荐 Responses API 作为与此模型交互的方式。
* `/v1/chat/completions` 端点为此模型提供了一个熟悉的接口。不会调用任何工具，但会结构化地返回推理和最终文本输出。函数调用正在开发中。你也可以在请求参数中设置 `include_reasoning: false` 参数以跳过作为输出一部分的 CoT。
* `/v1/completions` 端点是一个简单的输入输出接口的端点，没有任何形式的模板渲染。

所有端点都接受 `stream: true` 作为操作的一部分，以启用增量令牌流式传输。请注意，vLLM 目前并未涵盖 responses API 的全部范围，有关更多详细信息，请参阅下面的限制部分。

### 工具使用

gpt-oss 的一个主要特性是能够直接调用工具，称为“内置工具”。在 vLLM 中，我们提供几个选项：

* 默认情况下，我们集成了参考库的浏览器（使用 `ExaBackend`）和通过 docker 容器的演示 Python 解释器。为了使用搜索后端，你需要获得 [exa.ai](http://exa.ai) 的访问权限并将 `EXA_API_KEY=` 作为环境变量。对于 Python，要么有可用的 docker，要么设置 `PYTHON_EXECUTION_BACKEND=UV` 以危险地允许模型生成的代码片段在同一台机器上执行。

```
uv pip install gpt-oss

vllm serve ... --tool-server demo
```

* 请注意，默认选项仅用于演示目的。对于生产用途，vLLM 本身可以作为多个服务的 MCP 客户端。
这是一个 [示例工具服务器](https://github.com/openai/gpt-oss/tree/main/gpt-oss-mcp-server)，vLLM 可以与之配合使用，它们包装了演示工具：

```
mcp run -t sse browser_server.py:mcp
mcp run -t sse python_server.py:mcp

vllm serve ... --tool-server ip-1:port-1,ip-2:port-2
```

URL 应该是实现了服务器信息中的 `instructions` 和文档完善的工具的 MCP SSE 服务器。这些工具将被注入到模型的系统提示中以启用它们。

## 准确性评估面板

OpenAI 建议使用 gpt-oss 参考库来执行评估。例如，

```
python -m gpt_oss.evals --model 120b-low --eval gpqa --n-threads 128
python -m gpt_oss.evals --model 120b --eval gpqa --n-threads 128
python -m gpt_oss.evals --model 120b-high --eval gpqa --n-threads 128
```
要在 AIME2025 上评估，请将 `gpqa` 更改为 `aime25`。
部署 vLLM 后：

```
# 在 8xH100 上部署的示例
vllm serve openai/gpt-oss-120b \
  --tensor_parallel_size 8 \
  --max-model-len 131072 \
  --max-num-batched-tokens 10240 \
  --max-num-seqs 128 \
  --gpu-memory-utilization 0.85 \
  --no-enable-prefix-caching
```

这是我们在没有使用工具的情况下能够重现的分数，我们也鼓励你也尝试重现它！
我们观察到这些数字在不同的运行中可能会略有不同，所以请随意运行评估多次以了解方差。
为了快速进行正确性检查，我们建议从低推理工作量设置（120b-low）开始，这应该在几分钟内完成。

模型: 120B

| 推理工作量 | GPQA | AIME25 |
| :---- | :---- | :---- |
| 低  | 65.3 | 51.2 |
| 中  | 72.4 | 79.6 |
| 高  | 79.4 | 93.0 |

模型: 20B

| 推理工作量 | GPQA | AIME25 |
| :---- | :---- | :---- |
| 低  | 56.8 | 38.8 |
| 中  | 67.5 | 75.0 |
| 高  | 70.9 | 85.8  |

## 已知限制

* 在 H100 上使用张量并行大小 1，默认 gpu 内存利用率和批处理令牌会导致 CUDA 内存不足。当运行 tp1 时，请增加你的 gpu 内存利用率或降低批处理令牌

```
vllm serve openai/gpt-oss-120b --gpu-memory-utilization 0.95 --max-num-batched-tokens 1024
```

* 当在 H100 上运行 TP2 时，将你的 gpu 内存利用率设置在 0.95 以下，因为这也可能会导致 OOM
* Responses API 目前有几个限制；我们强烈欢迎在 vLLM 中贡献和维护此服务
* 使用量核算目前已损坏，仅返回全零。
* 不支持注释（引用搜索结果中的 URL）。
* 通过 `max_tokens` 截断可能无法保留部分块。
* 目前流式传输相当基础，例如：
  * 项目 ID 和索引需要更多工作
  * 工具调用和输出没有正确地流式传输，而是批处理的。
  * 缺少正确的错误处理。

## 故障排除

- Blackwell 上的注意力汇 dtype 错误：

```
  ERROR 08-05 07:31:10 [multiproc_executor.py:559]     assert sinks.dtype == torch.float32, "Sinks must be of type float32"
  **(VllmWorker TP0 pid=174579)** ERROR 08-05 07:31:10 [multiproc_executor.py:559]            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  **(VllmWorker TP0 pid=174579)** ERROR 08-05 07:31:10 [multiproc_executor.py:559] AssertionError: Sinks must be of type float32
```

**解决方案：请参阅 Blackwell 部分以检查是否添加了相关的环境变量。**

- 与 `tl.language` 未定义相关的 Triton 问题：

**解决方案：确保你的环境中没有安装其他 triton（pytorch-triton 等）。**

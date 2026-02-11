# GLM-4.5

[中文阅读](./README_zh.md)

<div align="center">
<img src=resources/logo.svg width="15%"/>
</div>
<p align="center">
    👋 加入我们的 <a href="resources/WECHAT.md" target="_blank">微信</a> 或 <a href="https://discord.gg/QR7SARHRxK" target="_blank">Discord</a> 社区。
    <br>
    📖 查看 GLM-4.5 <a href="https://z.ai/blog/glm-4.5" target="_blank">技术博客</a>。
    <br>
    📍 在 <a href="https://docs.z.ai/guides/llm/glm-4.5">Z.ai API 平台 (全球)</a> 或 <br> <a href="https://docs.bigmodel.cn/cn/guide/models/text/glm-4.5">智谱 AI 开放平台 (中国大陆)</a> 上使用 GLM-4.5 API 服务。
    <br>
    👉 一键直达 <a href="https://chat.z.ai">GLM-4.5</a>。
</p>

## 模型介绍

**GLM-4.5** 系列模型是为智能体设计的基础模型。GLM-4.5 总共有 **355** 亿参数，其中 **32** 亿激活参数，而 GLM-4.5-Air 采用更紧凑的设计，总共有 **106** 亿参数，其中 **12** 亿激活参数。GLM-4.5 模型统一了推理、编码和智能体能力，以满足智能体应用的复杂需求。

GLM-4.5 和 GLM-4.5-Air 都是混合推理模型，提供两种模式：用于复杂推理和工具使用的思考模式，以及用于立即响应的非思考模式。

我们已经开源了 GLM-4.5 和 GLM-4.5-Air 的基础模型、混合推理模型以及混合推理模型的 FP8 版本。它们在 MIT 开源许可证下发布，可以进行商业使用和二次开发。

正如我们在 12 个行业标准基准测试中的综合评估所示，GLM-4.5 取得了 **63.2** 的优异成绩，在所有专有和开源模型中排名 **第 3**。值得注意的是，GLM-4.5-Air 在保持卓越效率的同时，也提供了极具竞争力的结果，得分为 **59.8**。

![bench](resources/bench.png)

有关更多评估结果、展示案例和技术细节，请访问我们的 [技术博客](https://z.ai/blog/glm-4.5)。技术报告即将发布。

模型代码、工具解析器和推理解析器可以在 [transformers](https://github.com/huggingface/transformers/tree/main/src/transformers/models/glm4_moe)、[vLLM](https://github.com/vllm-project/vllm/blob/main/vllm/model_executor/models/glm4_moe_mtp.py) 和 [SGLang](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/models/glm4_moe.py) 的实现中找到。

## 模型下载

你可以直接在 [Hugging Face](https://huggingface.co/spaces/zai-org/GLM-4.5-Space) 或 [ModelScope](https://modelscope.cn/studios/ZhipuAI/GLM-4.5-Demo) 上体验该模型，或者通过以下链接下载模型。

| 模型 | 下载链接 | 模型大小 | 精度 |
|---|---|---|---|
| GLM-4.5 | [🤗 Hugging Face](https://huggingface.co/zai-org/GLM-4.5)<br> [🤖 ModelScope](https://modelscope.cn/models/ZhipuAI/GLM-4.5) | 355B-A32B | BF16 |
| GLM-4.5-Air | [🤗 Hugging Face](https://huggingface.co/zai-org/GLM-4.5-Air)<br> [🤖 ModelScope](https://modelscope.cn/models/ZhipuAI/GLM-4.5-Air) | 106B-A12B | BF16 |
| GLM-4.5-FP8 | [🤗 Hugging Face](https://huggingface.co/zai-org/GLM-4.5-FP8)<br> [🤖 ModelScope](https://modelscope.cn/models/ZhipuAI/GLM-4.5-FP8) | 355B-A32B | FP8 |
| GLM-4.5-Air-FP8 | [🤗 Hugging Face](https://huggingface.co/zai-org/GLM-4.5-Air-FP8)<br> [🤖 ModelScope](https://modelscope.cn/models/ZhipuAI/GLM-4.5-Air-FP8) | 106B-A12B | FP8 |
| GLM-4.5-Base | [🤗 Hugging Face](https://huggingface.co/zai-org/GLM-4.5-Base)<br> [🤖 ModelScope](https://modelscope.cn/models/ZhipuAI/GLM-4.5-Base) | 355B-A32B | BF16 |
| GLM-4.5-Air-Base | [🤗 Hugging Face](https://huggingface.co/zai-org/GLM-4.5-Air-Base)<br> [🤖 ModelScope](https://modelscope.cn/models/ZhipuAI/GLM-4.5-Air-Base) | 106B-A12B | BF16 |

## 系统要求

### 推理

我们为“全功能”模型推理提供最低和推荐配置。下表中的数据基于以下条件：

1. 所有模型使用 MTP 层并指定 `--speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4` 以确保具有竞争力的推理速度。
2. 不使用 `cpu-offload` 参数。
3. 推理批处理大小不超过 `8`。
4. 全部在原生支持 FP8 推理的设备上执行，确保权重和缓存均为 FP8 格式。
5. 服务器内存必须超过 `1T` 以确保模型正常加载和运行。

模型可以在下表中的配置下运行：

| 模型 | 精度 | GPU 类型和数量 | 测试框架 |
|---|---|---|---|
| GLM-4.5 | BF16 | H100 x 16 / H200 x 8 | sglang |
| GLM-4.5 | FP8 | H100 x 8 / H200 x 4 | sglang |
| GLM-4.5-Air | BF16 | H100 x 4 / H200 x 2 | sglang |
| GLM-4.5-Air | FP8 | H100 x 2 / H200 x 1 | sglang |

在下表中的配置下，模型可以利用其完整的 128K 上下文长度：

| 模型 | 精度 | GPU 类型和数量 | 测试框架 |
|---|---|---|---|
| GLM-4.5 | BF16 | H100 x 32 / H200 x 16 | sglang |
| GLM-4.5 | FP8 | H100 x 16 / H200 x 8 | sglang |
| GLM-4.5-Air | BF16 | H100 x 8 / H200 x 4 | sglang |
| GLM-4.5-Air | FP8 | H100 x 4 / H200 x 2 | sglang |

### 微调

代码可以在下表中的配置下使用 [Llama Factory](https://github.com/hiyouga/LLaMA-Factory) 运行：

| 模型 | GPU 类型和数量 | 策略 | 批处理大小 (每个 GPU) |
|---|---|---|---|
| GLM-4.5 | H100 x 16 | Lora | 1 |
| GLM-4.5-Air | H100 x 4 | Lora | 1 |

代码可以在下表中的配置下使用 [Swift](https://github.com/modelscope/ms-swift) 运行：

| 模型 | GPU 类型和数量 | 策略 | 批处理大小 (每个 GPU) |
|---|---|---|---|
| GLM-4.5 | H20 (96GiB) x 16 | Lora | 1 |
| GLM-4.5-Air | H20 (96GiB) x 4 | Lora | 1 |
| GLM-4.5 | H20 (96GiB) x 128 | SFT | 1 |
| GLM-4.5-Air | H20 (96GiB) x 32 | SFT | 1 |
| GLM-4.5 | H20 (96GiB) x 128 | RL | 1 |
| GLM-4.5-Air | H20 (96GiB) x 32 | RL | 1 |

## 快速开始

请根据 `requirements.txt` 安装所需的包。

```shell
pip install -r requirements.txt
```

### transformers

请参考 `inference` 文件夹中的 `trans_infer_cli.py` 代码。

### vLLM

+ BF16 和 FP8 都可以使用以下代码启动：

```shell
vllm serve zai-org/GLM-4.5-Air \
    --tensor-parallel-size 8 \
    --tool-call-parser glm45 \
    --reasoning-parser glm45 \
    --enable-auto-tool-choice \
    --served-model-name glm-4.5-air
```

如果你使用的是 8x H100 GPU 并在运行 GLM-4.5 模型时遇到内存不足，你将需要 `--cpu-offload-gb 16`（仅适用于 vLLM）。

如果你遇到 `flash infer` 问题，请使用 `VLLM_ATTENTION_BACKEND=XFORMERS` 作为临时替换。你也可以指定 `TORCH_CUDA_ARCH_LIST='9.0+PTX'` 来使用 `flash infer`（不同的 GPU 有不同的 TORCH_CUDA_ARCH_LIST 值，请相应检查）。

### SGLang

+ BF16

```shell
python3 -m sglang.launch_server \
  --model-path zai-org/GLM-4.5-Air \
  --tp-size 8 \
  --tool-call-parser glm45  \
  --reasoning-parser glm45 \
  --speculative-algorithm EAGLE \
  --speculative-num-steps 3 \
  --speculative-eagle-topk 1 \
  --speculative-num-draft-tokens 4 \
  --mem-fraction-static 0.7 \
  --served-model-name glm-4.5-air \
  --host 0.0.0.0 \
  --port 8000
```

+ FP8

```shell
python3 -m sglang.launch_server \
  --model-path zai-org/GLM-4.5-Air-FP8 \
  --tp-size 4 \
  --tool-call-parser glm45  \
  --reasoning-parser glm45  \
  --speculative-algorithm EAGLE \
  --speculative-num-steps 3  \
  --speculative-eagle-topk 1  \
  --speculative-num-draft-tokens 4 \
  --mem-fraction-static 0.7 \
  --disable-shared-experts-fusion \
  --served-model-name glm-4.5-air-fp8 \
  --host 0.0.0.0 \
  --port 8000
```

### 请求参数说明

+ 当使用 `vLLM` 和 `SGLang` 时，发送请求时默认启用思考模式。如果你想禁用思考开关，你需要添加 `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` 参数。
+ 两者都支持工具调用。请使用 OpenAI 风格的工具描述格式进行调用。
+ 具体代码，请参考 `inference` 文件夹中的 `api_request.py`。

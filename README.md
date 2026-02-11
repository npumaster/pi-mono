# 🏖️ 版本说明

**这是一个与pi-mono官方主线代码同步的中文版仓库，文档和代码注释都翻译成了简体中文，以方便中文社区使用。**

---

<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="pi logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由以下机构慷慨捐赠：
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

# Pi 单体仓库 (Pi Monorepo)

> **正在寻找 pi 编码代理？** 请参阅 **[packages/coding-agent](packages/coding-agent)** 以了解安装和用法。

用于构建 AI 代理和管理 LLM 部署的工具。

## 包 (Packages)

| 包 | 描述 |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | 统一的多提供商 LLM API（OpenAI, Anthropic, Google 等） |
| **[@mariozechner/pi-agent-core](packages/agent)** | 具有工具调用和状态管理的代理运行时 |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | 交互式编码代理 CLI |
| **[@mariozechner/pi-mom](packages/mom)** | 将消息委托给 pi 编码代理的 Slack 机器人 |
| **[@mariozechner/pi-tui](packages/tui)** | 具有差异渲染的终端 UI 库 |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | 用于 AI 聊天界面的 Web 组件 |
| **[@mariozechner/pi-pods](packages/pods)** | 用于管理 GPU Pod 上 vLLM 部署的 CLI |

## 贡献 (Contributing)

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解贡献指南，以及 [AGENTS.md](AGENTS.md) 了解项目特定规则（适用于人类和代理）。

## 开发 (Development)

```bash
npm install          # 安装所有依赖项
npm run build        # 构建所有包
npm run check        # Lint、格式化和类型检查
./test.sh            # 运行测试（没有 API 密钥时跳过依赖 LLM 的测试）
./pi-test.sh         # 从源码运行 pi（必须从仓库根目录运行）
```

> **注意：** `npm run check` 需要先运行 `npm run build`。web-ui 包使用 `tsc`，需要依赖项中编译好的 `.d.ts` 文件。

## 许可证 (License)

MIT

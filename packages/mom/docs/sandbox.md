# Mom Docker 沙箱

## 概览

Mom 可以直接在主机上运行工具，也可以在 Docker 容器内运行以实现隔离。

## 为什么使用 Docker？

当 Mom 在你的机器上运行并可通过 Slack 访问时，工作区中的任何人都有可能：
- 在你的机器上执行任意命令
- 访问你的文件、凭据等
- 通过提示词注入造成损害

Docker 沙箱将 Mom 的工具隔离在一个容器中，她只能访问你显式挂载的内容。

## 快速开始

```bash
# 1. 创建并启动容器
cd packages/mom
./docker.sh create ./data

# 2. 使用 Docker 沙箱运行 mom
mom --sandbox=docker:mom-sandbox ./data
```

## 工作原理

```
┌─────────────────────────────────────────────────────┐
│  Host (主机)                                         │
│                                                     │
│  mom process (Node.js 进程)                          │
│  ├── Slack connection (Slack 连接)                   │
│  ├── LLM API calls (LLM API 调用)                    │
│  └── Tool execution (工具执行) ──────┐                │
│                           ▼                         │
│              ┌─────────────────────────┐            │
│              │  Docker Container       │            │
│              │  ├── bash, git, gh, etc │            │
│              │  └── /workspace (挂载)   │            │
│              └─────────────────────────┘            │
│                                                     │
└─────────────────────────────────────────────────────┘
```

- Mom 进程在主机上运行（处理 Slack、LLM 调用）
- 所有工具执行（`bash`、`read`、`write`、`edit`）都在容器内发生
- 只有 `/workspace`（你的数据目录）可被容器访问

## 容器设置

使用提供的脚本：

```bash
./docker.sh create <data-dir>   # 创建并启动容器
./docker.sh start               # 启动现有容器
./docker.sh stop                # 停止容器
./docker.sh remove              # 删除容器
./docker.sh status              # 检查是否运行中
./docker.sh shell               # 在容器中打开 shell
```

或者手动操作：

```bash
docker run -d --name mom-sandbox \
  -v /path/to/mom-data:/workspace \
  alpine:latest tail -f /dev/null
```

## Mom 管理她自己的电脑

容器被视为 Mom 的个人电脑。她可以：

- 安装工具：`apk add github-cli git curl`
- 配置凭据：`gh auth login`
- 创建文件和目录
- 跨重启持久化状态

当 Mom 需要工具时，她会安装它。当她需要凭据时，她会询问你。

### 示例流程

```
User: "@mom check the spine-runtimes repo"
Mom:  "I need gh CLI. Installing..."
      (runs: apk add github-cli)
Mom:  "I need a GitHub token. Please provide one."
User: "ghp_xxxx..."
Mom:  (runs: echo "ghp_xxxx" | gh auth login --with-token)
Mom:  "Done. Checking repo..."
```

## 持久化

容器在以下情况下保持持久化：
- `docker stop` / `docker start`
- 主机重启

安装的工具和配置会一直保留，直到你 `docker rm` 该容器。

要重新开始：`./docker.sh remove && ./docker.sh create ./data`

## CLI 选项

```bash
# 在主机上运行（默认，无隔离）
mom ./data

# 使用 Docker 沙箱运行
mom --sandbox=docker:mom-sandbox ./data

# 显式主机模式
mom --sandbox=host ./data
```

## 安全注意事项

**容器可以做什么：**
- 读/写 `/workspace`（你的数据目录）中的文件
- 发起网络请求（用于 git、gh、curl 等）
- 安装包
- 运行任何命令

**容器不能做什么：**
- 访问 `/workspace` 以外的文件
- 访问主机的凭据
- 影响你的主机系统

**为了最大程度的安全性：**
1. 创建一个具有有限仓库访问权限的专用 GitHub 机器人账户
2. 仅与 Mom 共享该机器人的令牌
3. 不要挂载敏感目录

## 故障排除

### 容器未运行
```bash
./docker.sh status  # 检查状态
./docker.sh start   # 启动它
```

### 重置容器
```bash
./docker.sh remove
./docker.sh create ./data
```

### 缺少工具
让 Mom 安装它们，或者手动安装：
```bash
docker exec mom-sandbox apk add <package>
```

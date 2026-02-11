# Termux (Android) 设置

Pi 通过 [Termux](https://termux.dev/) 在 Android 上运行，Termux 是一个 Android 终端模拟器和 Linux 环境。

## 先决条件

1. 从 GitHub 或 F-Droid 安装 [Termux](https://github.com/termux/termux-app#installation)（不要从 Google Play 安装，该版本已弃用）
2. 从 GitHub 或 F-Droid 安装 [Termux:API](https://github.com/termux/termux-api#installation) 以支持剪贴板和其他设备集成

## 安装

```bash
# Update packages
pkg update && pkg upgrade

# Install dependencies
pkg install nodejs termux-api git

# Install pi
npm install -g @mariozechner/pi-coding-agent

# Create config directory
mkdir -p ~/.pi/agent

# Run pi
pi
```

## 剪贴板支持

在 Termux 中运行时，剪贴板操作使用 `termux-clipboard-set` 和 `termux-clipboard-get`。必须安装 Termux:API 应用才能使这些功能正常工作。

Termux 不支持图像剪贴板（`ctrl+v` 图像粘贴功能将无法工作）。

## Termux 的 AGENTS.md 示例

创建 `~/.pi/agent/AGENTS.md` 以帮助 agent 理解 Termux 环境：

```markdown
# Agent Environment: Termux on Android

## Location
- **OS**: Android (Termux terminal emulator)
- **Home**: `/data/data/com.termux/files/home`
- **Prefix**: `/data/data/com.termux/files/usr`
- **Shared storage**: `/storage/emulated/0` (Downloads, Documents, etc.)

## Opening URLs
```bash
termux-open-url "https://example.com"
```

## Opening Files
```bash
termux-open file.pdf          # Opens with default app
termux-open -c image.jpg      # Choose app
```

## Clipboard
```bash
termux-clipboard-set "text"   # Copy
termux-clipboard-get          # Paste
```

## Notifications
```bash
termux-notification -t "Title" -c "Content"
```

## Device Info
```bash
termux-battery-status         # Battery info
termux-wifi-connectioninfo    # WiFi info
termux-telephony-deviceinfo   # Device info
```

## Sharing
```bash
termux-share -a send file.txt # Share file
```

## Other Useful Commands
```bash
termux-toast "message"        # Quick toast popup
termux-vibrate                # Vibrate device
termux-tts-speak "hello"      # Text to speech
termux-camera-photo out.jpg   # Take photo
```

## Notes
- Termux:API app must be installed for `termux-*` commands
- Use `pkg install termux-api` for the command-line tools
- Storage permission needed for `/storage/emulated/0` access
```

## 限制

- **无图像剪贴板**：Termux 剪贴板 API 仅支持文本
- **无原生二进制文件**：一些可选的原生依赖项（如剪贴板模块）在 Android ARM64 上不可用，并在安装过程中被跳过
- **存储访问**：要访问 `/storage/emulated/0`（下载等）中的文件，请运行一次 `termux-setup-storage` 以授予权限

## 故障排除

### 剪贴板不工作

确保两个应用都已安装：
1. Termux (来自 GitHub 或 F-Droid)
2. Termux:API (来自 GitHub 或 F-Droid)

然后安装 CLI 工具：
```bash
pkg install termux-api
```

### 共享存储权限被拒绝

运行一次以授予存储权限：
```bash
termux-setup-storage
```

### Node.js 安装问题

如果 npm 失败，尝试清除缓存：
```bash
npm cache clean --force
```

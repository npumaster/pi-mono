> pi 可以创建主题。让它为你的设置构建一个。

# 主题

主题是定义 TUI 颜色的 JSON 文件。

## 目录

- [位置](#位置)
- [选择主题](#选择主题)
- [创建自定义主题](#创建自定义主题)
- [主题格式](#主题格式)
- [颜色标记](#颜色标记)
- [颜色值](#颜色值)
- [提示](#提示)

## 位置

Pi 从以下位置加载主题：

- 内置：`dark`, `light`
- 全局：`~/.pi/agent/themes/*.json`
- 项目：`.pi/themes/*.json`
- 包：`package.json` 中的 `themes/` 目录或 `pi.themes` 条目
- 设置：包含文件或目录的 `themes` 数组
- CLI：`--theme <path>`（可重复）

使用 `--no-themes` 禁用发现。

## 选择主题

通过 `/settings` 或在 `settings.json` 中选择主题：

```json
{
  "theme": "my-theme"
}
```

首次运行时，pi 会检测你的终端背景并默认为 `dark` 或 `light`。

## 创建自定义主题

1. 创建主题文件：

```bash
mkdir -p ~/.pi/agent/themes
vim ~/.pi/agent/themes/my-theme.json
```

2. 定义包含所有必需颜色的主题（参见 [颜色标记](#颜色标记)）：

```json
{
  "$schema": "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "#2d2d30",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "bashMode": "#ffaa00"
  }
}
```

3. 通过 `/settings` 选择主题。

**热重载：** 当你编辑当前活动的自定义主题文件时，pi 会自动重新加载它以获得即时视觉反馈。

## 主题格式

```json
{
  "$schema": "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  }
}
```

- `name` 是必需的，必须唯一。
- `vars` 是可选的。在此定义可重用的颜色，然后在 `colors` 中引用它们。
- `colors` 必须定义所有 51 个必需的标记。

`$schema` 字段启用编辑器自动完成和验证。

## 颜色标记

每个主题必须定义所有 51 个颜色标记。没有可选颜色。

### 核心 UI (11 种颜色)

| 标记 | 用途 |
|-------|---------|
| `accent` | 主要强调色（徽标、选中项、光标） |
| `border` | 正常边框 |
| `borderAccent` | 高亮边框 |
| `borderMuted` | 微妙边框（编辑器） |
| `success` | 成功状态 |
| `error` | 错误状态 |
| `warning` | 警告状态 |
| `muted` | 次要文本 |
| `dim` | 第三级文本 |
| `text` | 默认文本（通常为 `""`） |
| `thinkingText` | 思考块文本 |

### 背景与内容 (11 种颜色)

| 标记 | 用途 |
|-------|---------|
| `selectedBg` | 选中行背景 |
| `userMessageBg` | 用户消息背景 |
| `userMessageText` | 用户消息文本 |
| `customMessageBg` | 扩展消息背景 |
| `customMessageText` | 扩展消息文本 |
| `customMessageLabel` | 扩展消息标签 |
| `toolPendingBg` | 工具箱（待处理） |
| `toolSuccessBg` | 工具箱（成功） |
| `toolErrorBg` | 工具箱（错误） |
| `toolTitle` | 工具标题 |
| `toolOutput` | 工具输出文本 |

### Markdown (10 种颜色)

| 标记 | 用途 |
|-------|---------|
| `mdHeading` | 标题 |
| `mdLink` | 链接文本 |
| `mdLinkUrl` | 链接 URL |
| `mdCode` | 内联代码 |
| `mdCodeBlock` | 代码块内容 |
| `mdCodeBlockBorder` | 代码块栅栏 |
| `mdQuote` | 引用文本 |
| `mdQuoteBorder` | 引用边框 |
| `mdHr` | 水平线 |
| `mdListBullet` | 列表符号 |

### 工具差异 (3 种颜色)

| 标记 | 用途 |
|-------|---------|
| `toolDiffAdded` | 添加的行 |
| `toolDiffRemoved` | 删除的行 |
| `toolDiffContext` | 上下文行 |

### 语法高亮 (9 种颜色)

| 标记 | 用途 |
|-------|---------|
| `syntaxComment` | 注释 |
| `syntaxKeyword` | 关键字 |
| `syntaxFunction` | 函数名 |
| `syntaxVariable` | 变量 |
| `syntaxString` | 字符串 |
| `syntaxNumber` | 数字 |
| `syntaxType` | 类型 |
| `syntaxOperator` | 运算符 |
| `syntaxPunctuation` | 标点符号 |

### 思考等级边框 (6 种颜色)

指示思考等级的编辑器边框颜色（从微妙到突出的视觉层次）：

| 标记 | 用途 |
|-------|---------|
| `thinkingOff` | 思考关闭 |
| `thinkingMinimal` | 极少思考 |
| `thinkingLow` | 低思考 |
| `thinkingMedium` | 中等思考 |
| `thinkingHigh` | 高思考 |
| `thinkingXhigh` | 超高思考 |

### Bash 模式 (1 种颜色)

| 标记 | 用途 |
|-------|---------|
| `bashMode` | Bash 模式下的编辑器边框 (`!` 前缀) |

### HTML 导出 (可选)

`export` 部分控制 `/export` HTML 输出的颜色。如果省略，颜色源自 `userMessageBg`。

```json
{
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

## 颜色值

支持四种格式：

| 格式 | 示例 | 描述 |
|--------|---------|-------------|
| Hex | `"#ff0000"` | 6 位十六进制 RGB |
| 256-color | `39` | xterm 256 色调色板索引 (0-255) |
| Variable | `"primary"` | 对 `vars` 条目的引用 |
| Default | `""` | 终端的默认颜色 |

### 256 色调色板

- `0-15`: 基本 ANSI 颜色（取决于终端）
- `16-231`: 6×6×6 RGB 立方体 (`16 + 36×R + 6×G + B` 其中 R,G,B 为 0-5)
- `232-255`: 灰度阶梯

### 终端兼容性

Pi 使用 24 位 RGB 颜色。大多数现代终端都支持此功能（iTerm2, Kitty, WezTerm, Windows Terminal, VS Code）。对于仅支持 256 色的旧终端，pi 会回退到最接近的近似值。

检查真彩色支持：

```bash
echo $COLORTERM  # Should output "truecolor" or "24bit"
```

## 提示

**深色终端：** 使用高对比度的明亮、饱和颜色。

**浅色终端：** 使用低对比度的较暗、柔和颜色。

**色彩和谐：** 从基础调色板（Nord, Gruvbox, Tokyo Night）开始，在 `vars` 中定义它，并一致地引用。

**测试：** 使用不同的消息类型、工具状态、markdown 内容和长换行文本检查你的主题。

**VS Code：** 将 `terminal.integrated.minimumContrastRatio` 设置为 `1` 以获得准确的颜色。

## 示例

查看内置主题：
- [dark.json](../src/modes/interactive/theme/dark.json)
- [light.json](../src/modes/interactive/theme/light.json)

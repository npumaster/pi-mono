# 终端设置

Pi 使用 [Kitty 键盘协议](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) 来进行可靠的修饰键检测。大多数现代终端都支持此协议，但有些需要配置。

## Kitty, iTerm2

开箱即用。

## Ghostty

添加到你的 Ghostty 配置 (`~/.config/ghostty/config`):

```
keybind = alt+backspace=text:\x1b\x7f
keybind = shift+enter=text:\n
```

## WezTerm

创建 `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

## VS Code (集成终端)

`keybindings.json` 位置:
- macOS: `~/Library/Application Support/Code/User/keybindings.json`
- Linux: `~/.config/Code/User/keybindings.json`
- Windows: `%APPDATA%\\Code\\User\\keybindings.json`

添加到 `keybindings.json` 以启用 `Shift+Enter` 进行多行输入:

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Windows Terminal

添加到 `settings.json` (Ctrl+Shift+, 或 设置 → 打开 JSON 文件):

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    }
  ]
}
```

如果你已经有一个 `actions` 数组，请将对象添加到其中。

## IntelliJ IDEA (集成终端)

内置终端的转义序列支持有限。在 IntelliJ 的终端中，无法区分 Shift+Enter 和 Enter。

如果你希望硬件光标可见，请在运行 pi 之前设置 `PI_HARDWARE_CURSOR=1`（为了兼容性默认禁用）。

建议使用专用的终端模拟器以获得最佳体验。

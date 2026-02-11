# Windows 设置

Pi 需要在 Windows 上使用 bash shell。检查位置（按顺序）：

1. 来自 `~/.pi/agent/settings.json` 的自定义路径
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. PATH 上的 `bash.exe` (Cygwin, MSYS2, WSL)

对于大多数用户，[Git for Windows](https://git-scm.com/download/win) 就足够了。

## 自定义 Shell 路径

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

# Shell 别名

Pi 在非交互模式 (`bash -c`) 下运行 bash，默认情况下不扩展别名。

要启用你的 shell 别名，请添加到 `~/.pi/agent/settings.json`:

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\neval \"$(grep '^alias ' ~/.zshrc)\""
}
```

调整路径 (`~/.zshrc`, `~/.bashrc` 等) 以匹配你的 shell 配置。

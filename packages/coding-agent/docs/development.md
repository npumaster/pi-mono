# 开发指南

请参阅 [AGENTS.md](../../../AGENTS.md) 了解更多准则。

## 设置

```bash
git clone https://github.com/badlogic/pi-mono
cd pi-mono
npm install
npm run build
```

从源码运行：

```bash
./pi-test.sh
```

## 分叉 / 品牌重塑

通过 `package.json` 配置：

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

更改你的分叉的 `name`、`configDir` 和 `bin` 字段。这会影响 CLI 横幅、配置路径和环境变量名称。

## 路径解析

三种执行模式：npm 安装、独立二进制文件、从源码运行 tsx。

**始终使用 `src/config.ts`** 来获取包资源：

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

切勿直接使用 `__dirname` 获取包资源。

## 调试命令

`/debug`（隐藏命令）写入 `~/.pi/agent/pi-debug.log`：
- 带有 ANSI 代码的渲染 TUI 行
- 发送给 LLM 的最后一条消息

## 测试

```bash
./test.sh                         # 运行非 LLM 测试（无需 API 密钥）
npm test                          # 运行所有测试
npm test -- test/specific.test.ts # 运行特定测试
```

## 项目结构

```
packages/
  ai/           # LLM 提供商抽象
  agent/        # 代理循环和消息类型  
  tui/          # 终端 UI 组件
  coding-agent/ # CLI 和交互模式
```

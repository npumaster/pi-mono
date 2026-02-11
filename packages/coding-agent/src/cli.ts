#!/usr/bin/env node
/**
 * 重构后的编码代理 CLI 入口点。
 * 使用 main.ts，结合 AgentSession 和新的模式模块。
 *
 * 测试命令：npx tsx src/cli-new.ts [args...]
 */
process.title = "pi";

import { main } from "./main.js";

main(process.argv.slice(2));

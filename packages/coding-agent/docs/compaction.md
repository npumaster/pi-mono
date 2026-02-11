# 上下文压缩与分支摘要

LLM 的上下文窗口是有限的。当对话变得太长时，`pi` 使用压缩技术在保留近期工作的同时总结旧内容。本页涵盖了自动压缩和分支摘要。

**源文件** ([pi-mono](https://github.com/badlogic/pi-mono)):
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) - 自动压缩逻辑
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) - 分支摘要
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/utils.ts) - 共享实用程序（文件跟踪、序列化）
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) - 条目类型 (`CompactionEntry`, `BranchSummaryEntry`)
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts) - 扩展事件类型

要在你的项目中查看 TypeScript 定义，请检查 `node_modules/@mariozechner/pi-coding-agent/dist/`。

## 概览

Pi 有两种摘要机制：

| 机制 | 触发条件 | 目的 |
|-----------|---------|---------|
| 压缩 (Compaction) | 上下文超过阈值，或 `/compact` | 总结旧消息以释放上下文空间 |
| 分支摘要 (Branch summarization) | `/tree` 导航 | 在切换分支时保留上下文 |

两者都使用相同的结构化摘要格式，并累积跟踪文件操作。

## 压缩 (Compaction)

### 触发时机

自动压缩在以下情况下触发：

```
contextTokens > contextWindow - reserveTokens
```

默认情况下，`reserveTokens` 为 16384 token（可在 `~/.pi/agent/settings.json` 或 `<project-dir>/.pi/settings.json` 中配置）。这为 LLM 的响应留出了空间。

你也可以使用 `/compact [instructions]` 手动触发，其中可选的指令用于聚焦摘要内容。

### 工作原理

1. **寻找切入点**: 从最新消息向后遍历，累积 token 估算值，直到达到 `keepRecentTokens`（默认 20k，可在 `~/.pi/agent/settings.json` 或 `<project-dir>/.pi/settings.json` 中配置）
2. **提取消息**: 收集从上次压缩（或开始）到切入点的消息
3. **生成摘要**: 调用 LLM 使用结构化格式进行总结
4. **追加条目**: 保存包含摘要和 `firstKeptEntryId` 的 `CompactionEntry`
5. **重新加载**: 会话重新加载，使用摘要 + 从 `firstKeptEntryId` 开始的消息

```
压缩前:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               需要总结的消息                 保留的消息
                                   ↑
                          firstKeptEntryId (entry 4)

压缩后 (追加了新条目):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 不发送给 LLM                        发送给 LLM
                                                         ↑
                                              从 firstKeptEntryId 开始

LLM 看到的内容:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
     提示词     来自 cmp         来自 firstKeptEntryId 的消息
```

### 分割回合 (Split Turns)

一个“回合 (turn)”以用户消息开始，包括所有助手响应和工具调用，直到下一条用户消息。通常，压缩在回合边界处切割。

当单个回合超过 `keepRecentTokens` 时，切入点会落在回合中间的助手消息处。这就是“分割回合”：

```
分割回合 (一个巨大的回合超过了预算):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (之前没有完整的回合)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

对于分割回合，pi 生成两个摘要并合并它们：
1. **历史摘要**: 之前的上下文（如果有）
2. **回合前缀摘要**: 分割回合的早期部分

### 切入点规则

有效的切入点包括：
- 用户消息 (User messages)
- 助手消息 (Assistant messages)
- Bash 执行消息 (BashExecution messages)
- 自定义消息 (custom_message, branch_summary)

切勿在工具结果处切割（它们必须与其工具调用保持在一起）。

### CompactionEntry 结构

定义在 [`session-manager.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) 中：

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  fromHook?: boolean;  // 如果由扩展提供则为 true (旧字段名)
  details?: T;         // 实现特定的数据
}

// 默认压缩使用此结构作为 details (来自 compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

扩展可以在 `details` 中存储任何 JSON 可序列化的数据。默认压缩跟踪文件操作，但自定义扩展实现可以使用它们自己的结构。

请参阅 [`prepareCompaction()`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) 和 [`compact()`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) 了解实现细节。

## 分支摘要 (Branch Summarization)

### 触发时机

当你使用 `/tree` 导航到不同的分支时，pi 会提议总结你即将离开的工作。这将把左侧分支的上下文注入到新分支中。

### 工作原理

1. **寻找共同祖先**: 旧位置和新位置共享的最深层节点
2. **收集条目**: 从旧叶子节点回溯到共同祖先
3. **准备预算**: 包含直到 token 预算的消息（最新的优先）
4. **生成摘要**: 调用 LLM 使用结构化格式进行总结
5. **追加条目**: 在导航点保存 `BranchSummaryEntry`

```
导航前的树:

         ┌─ B ─ C ─ D (旧叶子, 即将被遗弃)
    A ───┤
         └─ E ─ F (目标)

共同祖先: A
需要总结的条目: B, C, D

带有摘要导航后:

         ┌─ B ─ C ─ D ─ [B,C,D 的摘要]
    A ───┤
         └─ E ─ F (新叶子)
```

### 累积文件跟踪

压缩和分支摘要都累积地跟踪文件。在生成摘要时，pi 从以下来源提取文件操作：
- 被总结的消息中的工具调用
- 之前的压缩或分支摘要 `details`（如果有）

这意味着文件跟踪跨越多次压缩或嵌套的分支摘要进行累积，保留了读取和修改文件的完整历史记录。

### BranchSummaryEntry 结构

定义在 [`session-manager.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) 中：

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // 我们从哪个条目导航而来
  fromHook?: boolean;  // 如果由扩展提供则为 true (旧字段名)
  details?: T;         // 实现特定的数据
}

// 默认分支摘要使用此结构作为 details (来自 branch-summarization.ts):
```

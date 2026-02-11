# 会话树导航

`/tree` 命令提供基于树的会话历史导航。

## 概述

会话存储为树结构，其中每个条目都有一个 `id` 和 `parentId`。"leaf" 指针跟踪当前位置。`/tree` 允许你导航到任何点，并可选择摘要你离开的分支。

### 与 `/fork` 的比较

| 特性 | `/fork` | `/tree` |
|---------|---------|---------|
| 视图 | 用户消息的扁平列表 | 完整的树结构 |
| 动作 | 提取路径到**新会话文件** | 更改**同一会话**中的 leaf |
| 摘要 | 从不 | 可选（提示用户） |
| 事件 | `session_before_fork` / `session_fork` | `session_before_tree` / `session_tree` |

## 树形 UI

```
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ [compaction: 12k tokens]
│     │        └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### 控制

| 按键 | 动作 |
|-----|--------|
| ↑/↓ | 导航（深度优先顺序） |
| Enter | 选择节点 |
| Escape/Ctrl+C | 取消 |
| Ctrl+U | 切换：仅用户消息 |
| Ctrl+O | 切换：显示全部（包括自定义/标签条目） |

### 显示

- 高度：终端高度的一半
- 当前 leaf 标记为 `← active`
- 标签内联显示：`[label-name]`
- 默认过滤器隐藏 `label` 和 `custom` 条目（在 Ctrl+O 模式下显示）
- 子节点按时间戳排序（最旧的在前）

## 选择行为

### 用户消息或自定义消息
1. Leaf 设置为所选节点的**父节点**（如果是根节点则为 `null`）
2. 消息文本放入**编辑器**以重新提交
3. 用户编辑并提交，创建一个新分支

### 非用户消息（assistant, compaction 等）
1. Leaf 设置为**所选节点**
2. 编辑器保持为空
3. 用户从该点继续

### 选择根用户消息
如果用户选择了第一条消息（没有父节点）：
1. Leaf 重置为 `null`（空对话）
2. 消息文本放入编辑器
3. 用户实际上是从头开始重新启动

## 分支摘要

切换分支时，用户会看到三个选项：

1. **No summary** - 立即切换而不摘要
2. **Summarize** - 使用默认提示生成摘要
3. **Summarize with custom prompt** - 打开编辑器输入额外的焦点指令，附加到默认摘要提示中

### 摘要内容

从旧 leaf 回溯到与目标的共同祖先的路径：

```
A → B → C → D → E → F  ← old leaf
        ↘ G → H        ← target
```

被放弃的路径：D → E → F（被摘要）

摘要停止于：
1. 共同祖先（总是）
2. Compaction 节点（如果先遇到）

### 摘要存储

存储为 `BranchSummaryEntry`:

```typescript
interface BranchSummaryEntry {
  type: "branch_summary";
  id: string;
  parentId: string;      // New leaf position
  timestamp: string;
  fromId: string;        // Old leaf we abandoned
  summary: string;       // LLM-generated summary
  details?: unknown;     // Optional hook data
}
```

## 实现

### AgentSession.navigateTree()

```typescript
async navigateTree(
  targetId: string,
  options?: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  }
): Promise<{ editorText?: string; cancelled: boolean }>
```

选项：
- `summarize`: 是否摘要被放弃的分支
- `customInstructions`: 摘要器的自定义指令
- `replaceInstructions`: 如果为 true，`customInstructions` 替换默认提示而不是附加
- `label`: 附加到分支摘要条目的标签（如果不摘要则附加到目标条目）

流程：
1. 验证目标，检查无操作（target === current leaf）
2. 找到旧 leaf 和目标之间的共同祖先
3. 收集要摘要的条目（如果请求）
4. 触发 `session_before_tree` 事件（钩子可以取消或提供摘要）
5. 如果需要，运行默认摘要器
6. 通过 `branch()` 或 `branchWithSummary()` 切换 leaf
7. 更新 agent: `agent.replaceMessages(sessionManager.buildSessionContext().messages)`
8. 触发 `session_tree` 事件
9. 通过 session 事件通知自定义工具
10. 如果选择了用户消息，返回带有 `editorText` 的结果

### SessionManager

- `getLeafUuid(): string | null` - 当前 leaf（如果为空则为 null）
- `resetLeaf(): void` - 将 leaf 设置为 null（用于根用户消息导航）
- `getTree(): SessionTreeNode[]` - 完整的树，子节点按时间戳排序
- `branch(id)` - 更改 leaf 指针
- `branchWithSummary(id, summary)` - 更改 leaf 并创建摘要条目

### InteractiveMode

`/tree` 命令显示 `TreeSelectorComponent`，然后：
1. 提示摘要
2. 调用 `session.navigateTree()`
3. 清除并重新渲染聊天
4. 如果适用，设置编辑器文本

## Hook 事件

### `session_before_tree`

```typescript
interface TreePreparation {
  targetId: string;
  oldLeafId: string | null;
  commonAncestorId: string | null;
  entriesToSummarize: SessionEntry[];
  userWantsSummary: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

interface SessionBeforeTreeEvent {
  type: "session_before_tree";
  preparation: TreePreparation;
  signal: AbortSignal;
}

interface SessionBeforeTreeResult {
  cancel?: boolean;
  summary?: { summary: string; details?: unknown };
  customInstructions?: string;    // Override custom instructions
  replaceInstructions?: boolean;  // Override replace mode
  label?: string;                 // Override label
}
```

扩展可以通过从 `session_before_tree` 处理程序返回它们来覆盖 `customInstructions`、`replaceInstructions` 和 `label`。

### `session_tree`

```typescript
interface SessionTreeEvent {
  type: "session_tree";
  newLeafId: string | null;
  oldLeafId: string | null;
  summaryEntry?: BranchSummaryEntry;
  fromHook?: boolean;
}
```

### 示例：自定义摘要器

```typescript
export default function(pi: HookAPI) {
  pi.on("session_before_tree", async (event, ctx) => {
    if (!event.preparation.userWantsSummary) return;
    if (event.preparation.entriesToSummarize.length === 0) return;
    
    const summary = await myCustomSummarizer(event.preparation.entriesToSummarize);
    return { summary: { summary, details: { custom: true } } };
  });
}
```

## 错误处理

- 摘要失败：取消导航，显示错误
- 用户中止 (Escape)：取消导航
- Hook 返回 `cancel: true`：静默取消导航

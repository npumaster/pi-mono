# JSON 模式与输出格式

`pi` 可以在纯 JSON 模式下运行，这对于集成到其他工具或 IDE 中非常有用。

## 启用 JSON 模式

使用 `--json` 标志启动 `pi`：

```bash
pi --json
```

或者在 SDK 中，它会自动处理。

## 输出结构

在 JSON 模式下，`pi` 的所有标准输出（stdout）都是换行符分隔的 JSON 对象（JSONL）。

### 消息类型

每个 JSON 对象都有一个 `type` 字段，指示消息的种类。

#### 1. `thought` (思考)

当模型正在进行思维链推理时。

```json
{
  "type": "thought",
  "content": "我需要检查文件是否存在..."
}
```

#### 2. `call` (工具调用)

当模型想要执行一个工具时。

```json
{
  "type": "call",
  "id": "call_123",
  "tool": "fs_read_file",
  "params": {
    "path": "/src/index.ts"
  }
}
```

#### 3. `result` (工具结果)

工具执行的结果（通常由系统发送给模型，但也可能在日志中回显）。

```json
{
  "type": "result",
  "id": "call_123",
  "content": "File content here...",
  "isError": false
}
```

#### 4. `text` (文本响应)

发送给用户的最终文本响应的一部分。这通常是流式的。

```json
{
  "type": "text",
  "content": "这是"
}
```
```json
{
  "type": "text",
  "content": "文件内容。"
}
```

#### 5. `error` (错误)

系统错误。

```json
{
  "type": "error",
  "code": "context_overflow",
  "message": "Maximum context length exceeded."
}
```

#### 6. `usage` (用量)

Token 使用统计信息。

```json
{
  "type": "usage",
  "inputTokens": 500,
  "outputTokens": 150,
  "totalTokens": 650
}
```

## 输入格式

在 JSON 模式下，你可以将 JSON 对象发送到标准输入（stdin）。

```json
{
  "role": "user",
  "content": "列出当前目录中的文件"
}
```

或者使用更复杂的结构（如果在会话上下文中）：

```json
{
  "prompt": "修复这个 bug",
  "images": ["base64..."]
}
```

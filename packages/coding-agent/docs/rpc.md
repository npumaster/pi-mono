# RPC 协议

`pi` 支持 JSON-RPC 2.0 接口，允许外部进程控制代理。这用于 IDE 插件、Web 界面和其他无头集成。

## 传输

RPC 消息通常通过标准输入/标准输出（stdio）传输，每条消息一行。

## 方法

### `initialize`

初始化会话。

**参数:**
- `root`: 工作区根目录路径。
- `options`: 配置对象。

**结果:**
- `sessionId`: 会话 ID。
- `capabilities`: 代理能力列表。

### `prompt`

向代理发送用户消息。

**参数:**
- `text`: 消息内容。
- `images`: （可选）图像数据列表。

**结果:**
- `id`: 请求 ID（用于跟踪进度）。

### `interrupt`

停止当前的执行。

**参数:** 无。

### `get_state`

获取当前会话状态。

**结果:**
- `history`: 消息历史。
- `status`: 当前状态 (`idle`, `busy`, `error`)。

## 通知 (Server -> Client)

代理会发送通知以流式传输进度。

### `text`
生成的文本块。
```json
{"method": "text", "params": {"content": "Hello"}}
```

### `thought`
思考过程块。
```json
{"method": "thought", "params": {"content": "Reading file..."}}
```

### `tool_call`
工具调用详情。
```json
{"method": "tool_call", "params": {"tool": "ls", "args": {"path": "."}}}
```

### `tool_result`
工具执行结果。
```json
{"method": "tool_result", "params": {"output": "file1.txt\nfile2.txt"}}
```

### `status_change`
当代理状态改变时（例如从 `idle` 变为 `busy`）。
```json
{"method": "status_change", "params": {"status": "busy"}}
```

## 示例流程

1. Client -> Server: `{"jsonrpc": "2.0", "method": "initialize", "params": {"root": "/projects/myapp"}, "id": 1}`
2. Server -> Client: `{"jsonrpc": "2.0", "result": {"sessionId": "abc-123"}, "id": 1}`
3. Client -> Server: `{"jsonrpc": "2.0", "method": "prompt", "params": {"text": "Create a README"}, "id": 2}`
4. Server -> Client: `{"jsonrpc": "2.0", "method": "thought", "params": {"content": "I should..."}}`
5. Server -> Client: `{"jsonrpc": "2.0", "method": "text", "params": {"content": "Here is..."}}`
6. Server -> Client: `{"jsonrpc": "2.0", "result": null, "id": 2}` (请求完成)

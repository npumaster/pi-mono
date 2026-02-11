# 提示词模板 (Prompt Templates)

`pi` 使用 Handlebars 模板来构建发送给 LLM 的系统提示和用户消息。这允许动态地包含上下文信息、规则和指令。

## 模板位置

默认模板位于 `packages/coding-agent/src/prompts/`。你可以通过配置覆盖这些模板。

主要模板包括：

- **system.hbs**: 定义代理的角色、工具和核心行为的核心系统提示。
- **user.hbs**: 包装用户输入的默认用户提示。
- **tool-result.hbs**: 格式化工具执行结果。

## 自定义模板

你可以通过在设置中指向自定义模板文件来覆盖默认值：

```json
// settings.json
{
  "prompts": {
    "system": "/path/to/my-system-prompt.hbs"
  }
}
```

## 变量

以下变量在模板中可用：

- `cwd`: 当前工作目录。
- `os`: 操作系统名称 (linux, darwin, win32)。
- `shell`: 当前使用的 Shell。
- `rules`: 适用于当前会话的一组活动规则（来自 `.pi/rules.md` 等）。
- `tools`: 可用工具定义的列表。

## 助手函数 (Helpers)

除了标准的 Handlebars 助手函数外，我们还提供：

- `{{json object}}`: 将对象序列化为 JSON 字符串。
- `{{read_file path}}`: 读取并插入文件内容（谨慎使用，避免超出上下文限制）。
- `{{execute command}}`: 执行 shell 命令并插入输出（仅在安全环境中可用）。

## 示例：添加自定义规则

如果你想在所有提示中强制执行特定于团队的编码风格，你可以修改 `system.hbs`：

```handlebars
{{! 原始系统提示内容... }}

# Team Style Guide
- Always use TypeScript.
- Prefer functional programming patterns.
- Use 'type' instead of 'interface' for definitions.

{{#if rules}}
# Project Rules
{{rules}}
{{/if}}
```

## 提示词工程技巧

1. **清晰明确**: 对代理应该做什么和不应该做什么要非常具体。
2. **示例**: 提供少量示例（few-shot prompting）通常比说明更有效。
3. **思维链**: 鼓励模型在采取行动之前“大声思考”（`pi` 默认通过 `<thinking>` 块支持这一点）。
4. **工具定义**: 确保工具描述清晰，因为模型依靠这些描述来决定何时以及如何使用工具。

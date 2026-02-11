# pi 包格式

`pi` 使用基于 zip 的包格式来分发技能（skills）和扩展（extensions）。这种格式允许将代码、资源和元数据捆绑到一个文件中。

## 结构

`.pi` 包是一个包含特定结构的 ZIP 归档文件：

```
my-package.pi
├── manifest.json       # 包元数据
├── package.json        # Node.js 包定义
├── dist/               # 编译后的 JavaScript 代码
│   └── index.js
└── assets/             # 静态资源（可选）
    ├── icon.png
    └── README.md
```

## Manifest (manifest.json)

`manifest.json` 文件定义了包的属性及其与 `pi` 的集成方式。

```json
{
  "id": "com.example.my-skill",
  "version": "1.0.0",
  "name": "My Example Skill",
  "description": "A sample skill for pi",
  "type": "skill", 
  "main": "dist/index.js",
  "permissions": [
    "fs:read",
    "network:http"
  ],
  "contributes": {
    "commands": [
      {
        "id": "my-skill.hello",
        "title": "Say Hello"
      }
    ]
  }
}
```

### 字段

- **id**: 包的唯一标识符（反向域名表示法）。
- **version**: 语义化版本字符串。
- **type**: `skill`（技能）或 `extension`（扩展）。
- **main**: 入口点脚本的相对路径。
- **permissions**: 包请求的权限列表。
- **contributes**: 此包贡献给系统的功能（命令、设置、视图等）。

## 构建包

你可以使用 `pi-pack` 工具（如果是开发套件的一部分）或任何 zip 实用程序来创建包。

### 使用 ZIP

1. 编译你的 TypeScript/JavaScript 代码。
2. 确保 `manifest.json` 和 `package.json` 正确。
3. 压缩内容（不要包含顶层文件夹，直接压缩文件）。
4. 将扩展名从 `.zip` 重命名为 `.pi`。

```bash
cd my-package-source
zip -r ../my-package.pi .
```

## 安装

用户可以通过多种方式安装包：

1. **CLI**: `pi install ./my-package.pi`
2. **设置**: 将路径添加到 `settings.json` 中的 `packages` 列表。
3. **注册表**: （计划中）从中央注册表安装。

## 运行时环境

包在受限的 Node.js 环境中运行。它们可以访问：

- 标准 Node.js API (fs, path, http 等)。
- `pi` 扩展 API (通过 `@pi-mono/api` 导入)。

它们**不能**访问：
- 未在 `manifest.json` 中声明的受保护系统资源。
- 其他包的内部状态（除非通过导出的 API）。

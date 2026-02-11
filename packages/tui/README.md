# @mariozechner/pi-tui

极简的终端 UI 框架，具有差异渲染和同步输出功能，用于构建无闪烁的交互式 CLI 应用程序。

## 特性

- **差异渲染**：三策略渲染系统，仅更新更改的内容
- **同步输出**：使用 CSI 2026 进行原子屏幕更新（无闪烁）
- **括号粘贴模式**：正确处理大量粘贴，为 >10 行的粘贴提供标记
- **基于组件**：具有 render() 方法的简单组件接口
- **主题支持**：组件接受主题接口以进行可自定义的样式设置
- **内置组件**：Text, TruncatedText, Input, Editor, Markdown, Loader, SelectList, SettingsList, Spacer, Image, Box, Container
- **内联图像**：在支持 Kitty 或 iTerm2 图形协议的终端中渲染图像
- **自动补全支持**：文件路径和斜杠命令

## 快速开始

```typescript
import { TUI, Text, Editor, ProcessTerminal } from "@mariozechner/pi-tui";

// 创建终端
const terminal = new ProcessTerminal();

// 创建 TUI
const tui = new TUI(terminal);

// 添加组件
tui.addChild(new Text("Welcome to my app!"));

const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
  console.log("Submitted:", text);
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// 启动
tui.start();
```

## 核心 API

### TUI

管理组件和渲染的主容器。

```typescript
const tui = new TUI(terminal);
tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender(); // 请求重新渲染

// 全局调试键处理程序 (Shift+Ctrl+D)
tui.onDebug = () => console.log("Debug triggered");
```

### 覆盖层 (Overlays)

覆盖层在现有内容之上渲染组件，而不替换它。适用于对话框、菜单和模态 UI。

```typescript
// 使用默认选项显示覆盖层（居中，最大 80 列）
const handle = tui.showOverlay(component);

// 使用自定义定位和大小显示覆盖层
// 值可以是数字（绝对）或百分比字符串（例如 "50%"）
const handle = tui.showOverlay(component, {
  // 大小
  width: 60,              // 固定宽度（列）
  width: "80%",           // 终端宽度的百分比
  minWidth: 40,           // 最小宽度底限
  maxHeight: 20,          // 最大高度（行）
  maxHeight: "50%",       // 终端高度的百分比

  // 基于锚点的定位（默认：'center'）
  anchor: 'bottom-right', // 相对于锚点的位置
  offsetX: 2,             // 距锚点的水平偏移
  offsetY: -1,            // 距锚点的垂直偏移

  // 基于百分比的定位（锚点的替代方案）
  row: "25%",             // 垂直位置（0%=顶部，100%=底部）
  col: "50%",             // 水平位置（0%=左侧，100%=右侧）

  // 绝对定位（覆盖锚点/百分比）
  row: 5,                 // 确切的行位置
  col: 10,                // 确切的列位置

  // 距终端边缘的边距
  margin: 2,              // 所有边
  margin: { top: 1, right: 2, bottom: 1, left: 2 },

  // 响应式可见性
  visible: (termWidth, termHeight) => termWidth >= 100  // 在窄终端上隐藏
});

// OverlayHandle 方法
handle.hide();              // 永久移除覆盖层
handle.setHidden(true);     // 暂时隐藏（可以再次显示）
handle.setHidden(false);    // 隐藏后再次显示
handle.isHidden();          // 检查是否暂时隐藏

// 隐藏最顶层的覆盖层
tui.hideOverlay();

// 检查是否有任何可见的覆盖层处于活动状态
tui.hasOverlay();
```

**锚点值**: `'center'`, `'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`, `'top-center'`, `'bottom-center'`, `'left-center'`, `'right-center'`

**解析顺序**:
1. `minWidth` 在宽度计算后作为底限应用
2. 对于位置：绝对 `row`/`col` > 百分比 `row`/`col` > `anchor`
3. `margin` 限制最终位置以保持在终端边界内
4. `visible` 回调控制是否渲染覆盖层（每帧调用）

### 组件接口

所有组件实现：

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}
```

| 方法 | 描述 |
|--------|-------------|
| `render(width)` | 返回字符串数组，每行一个。每一行**不得超过 `width`**，否则 TUI 将报错。使用 `truncateToWidth()` 或手动换行来确保这一点。 |
| `handleInput?(data)` | 当组件获得焦点并接收键盘输入时调用。`data` 字符串包含原始终端输入（可能包含 ANSI 转义序列）。 |
| `invalidate?()` | 调用以清除任何缓存的渲染状态。组件应在下一次 `render()` 调用时从头开始重新渲染。 |

TUI 在每个渲染行的末尾附加一个完整的 SGR 重置和 OSC 8 重置。样式不会跨行延续。如果你发出带有样式的多行文本，请每行重新应用样式或使用 `wrapTextWithAnsi()`，以便为每个换行保留样式。

### 可聚焦接口 (IME 支持)

显示文本光标并需要 IME（输入法编辑器）支持的组件应实现 `Focusable` 接口：

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@mariozechner/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // 当焦点改变时由 TUI 设置
  
  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    // 在假光标之前发出标记
    return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
  }
}
```

当 `Focusable` 组件获得焦点时，TUI：
1. 在组件上设置 `focused = true`
2. 扫描渲染输出以查找 `CURSOR_MARKER`（零宽 APC 转义序列）
3. 将硬件终端光标定位在该位置
4. 显示硬件光标

这使得 IME 候选窗口能够在 CJK 输入法的正确位置出现。`Editor` 和 `Input` 内置组件已经实现了此接口。

**带有嵌入式输入的容器组件：** 当容器组件（对话框、选择器等）包含 `Input` 或 `Editor` 子组件时，容器必须实现 `Focusable` 并将焦点状态传播给子组件：

```typescript
import { Container, type Focusable, Input } from "@mariozechner/pi-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // 将焦点传播给子输入组件以进行 IME 光标定位
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

如果没有这种传播，使用 IME（中文、日文、韩文等）打字时，候选窗口将显示在错误的位置。

## 内置组件

### Container

对子组件进行分组。

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

对所有子组件应用内边距和背景颜色的容器。

```typescript
const box = new Box(
  1,                              // paddingX (默认: 1)
  1,                              // paddingY (默认: 1)
  (text) => chalk.bgGray(text)   // 可选的背景函数
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text));  // 动态更改背景
```

### Text

显示带有自动换行和内边距的多行文本。

```typescript
const text = new Text(
  "Hello World",                  // 文本内容
  1,                              // paddingX (默认: 1)
  1,                              // paddingY (默认: 1)
  (text) => chalk.bgGray(text)   // 可选的背景函数
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

截断以适应视口宽度的单行文本。适用于状态行和标题。

```typescript
const truncated = new TruncatedText(
  "This is a very long line that will be truncated...",
  0,  // paddingX (默认: 0)
  0   // paddingY (默认: 0)
);
```

### Input

带有水平滚动的单行文本输入。

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

**按键绑定：**
- `Enter` - 提交
- `Ctrl+A` / `Ctrl+E` - 行首/行尾
- `Ctrl+W` 或 `Alt+Backspace` - 向后删除单词
- `Ctrl+U` - 删除到行首
- `Ctrl+K` - 删除到行尾
- `Ctrl+Left` / `Ctrl+Right` - 单词导航
- `Alt+Left` / `Alt+Right` - 单词导航
- 方向键、Backspace、Delete 按预期工作

### Editor

具有自动补全、文件补全、粘贴处理以及内容超过终端高度时垂直滚动功能的多行文本编辑器。

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
}

interface EditorOptions {
  paddingX?: number;  // 水平内边距 (默认: 0)
}

const editor = new Editor(tui, theme, options?);  // tui 是必需的，用于高度感知滚动
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // 暂时禁用提交
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // 动态更改边框
editor.setPaddingX(1); // 动态更新水平内边距
editor.getPaddingX();  // 获取当前内边距
```

**特性：**
- 带有自动换行的多行编辑
- 斜杠命令自动补全（输入 `/`）
- 文件路径自动补全（按 `Tab`）
- 大量粘贴处理（>10 行会创建 `[paste #1 +50 lines]` 标记）
- 编辑器上方/下方的水平线
- 假光标渲染（隐藏真实光标）

**按键绑定：**
- `Enter` - 提交
- `Shift+Enter`, `Ctrl+Enter`, 或 `Alt+Enter` - 换行（取决于终端，Alt+Enter 最可靠）
- `Tab` - 自动补全
- `Ctrl+K` - 删除到行尾
- `Ctrl+U` - 删除到行首
- `Ctrl+W` 或 `Alt+Backspace` - 向后删除单词
- `Alt+D` 或 `Alt+Delete` - 向前删除单词
- `Ctrl+A` / `Ctrl+E` - 行首/行尾
- `Ctrl+]` - 向前跳转到字符（等待下一个按键，然后将光标移动到第一次出现的位置）
- `Ctrl+Alt+]` - 向后跳转到字符
- 方向键、Backspace、Delete 按预期工作

### Markdown

渲染带有语法高亮和主题支持的 markdown。

```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

const md = new Markdown(
  "# Hello\n\nSome **bold** text",
  1,              // paddingX
  1,              // paddingY
  theme,          // MarkdownTheme
  defaultStyle    // 可选的 DefaultTextStyle
);
md.setText("Updated markdown");
```

**特性：**
- 标题、粗体、斜体、代码块、列表、链接、块引用
- HTML 标签渲染为纯文本
- 通过 `highlightCode` 可选的语法高亮
- 内边距支持
- 用于性能的渲染缓存

### Loader

动画加载旋转器。

```typescript
const loader = new Loader(
  tui,                              // TUI 实例用于渲染更新
  (s) => chalk.cyan(s),            // 旋转器颜色函数
  (s) => chalk.gray(s),            // 消息颜色函数
  "Loading..."                      // 消息 (默认: "Loading...")
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

扩展了 Loader，具有 Escape 键处理和用于取消异步操作的 AbortSignal。

```typescript
const loader = new CancellableLoader(
  tui,                              // TUI 实例用于渲染更新
  (s) => chalk.cyan(s),            // 旋转器颜色函数
  (s) => chalk.gray(s),            // 消息颜色函数
  "Working..."                      // 消息
);
loader.onAbort = () => done(null); // 当用户按 Escape 时调用
doAsyncWork(loader.signal).then(done);
```

**属性：**
- `signal: AbortSignal` - 当用户按 Escape 时中止
- `aborted: boolean` - 加载器是否被中止
- `onAbort?: () => void` - 当用户按 Escape 时的回调

### SelectList

带有键盘导航的交互式选择列表。

```typescript
interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

const list = new SelectList(
  [
    { value: "opt1", label: "Option 1", description: "First option" },
    { value: "opt2", label: "Option 2", description: "Second option" },
  ],
  5,      // maxVisible
  theme   // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // 过滤项目
```

**控制：**
- 方向键：导航
- Enter：选择
- Escape：取消

### SettingsList

带有值循环和子菜单的设置面板。

```typescript
interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];  // 如果提供，Enter/Space 循环这些值
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

const settings = new SettingsList(
  [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
  ],
  10,      // maxVisible
  theme,   // SettingsListTheme
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled")
);
settings.updateValue("theme", "light");
```

**控制：**
- 方向键：导航
- Enter/Space：激活（循环值或打开子菜单）
- Escape：取消

### Spacer

用于垂直间距的空行。

```typescript
const spacer = new Spacer(2); // 2 个空行 (默认: 1)
```

### Image

为支持 Kitty 图形协议 (Kitty, Ghostty, WezTerm) 或 iTerm2 内联图像的终端内联渲染图像。在不支持的终端上回退到文本占位符。

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

interface ImageOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
}

const image = new Image(
  base64Data,       // base64 编码的图像数据
  "image/png",      // MIME 类型
  theme,            // ImageTheme
  options           // 可选的 ImageOptions
);
tui.addChild(image);
```

支持的格式：PNG, JPEG, GIF, WebP。尺寸会自动从图像头中解析。

## 自动补全

### CombinedAutocompleteProvider

同时支持斜杠命令和文件路径。

```typescript
import { CombinedAutocompleteProvider } from "@mariozechner/pi-tui";

const provider = new CombinedAutocompleteProvider(
  [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear screen" },
    { name: "delete", description: "Delete last message" },
  ],
  process.cwd() // 文件补全的基路径
);

editor.setAutocompleteProvider(provider);
```

**特性：**
- 输入 `/` 查看斜杠命令
- 按 `Tab` 进行文件路径补全
- 适用于 `~/`, `./`, `../`, 和 `@` 前缀
- 对于 `@` 前缀，过滤为可附加文件

## 键检测

使用 `matchesKey()` 和 `Key` 助手进行键盘输入检测（支持 Kitty 键盘协议）：

```typescript
import { matchesKey, Key } from "@mariozechner/pi-tui";

if (matchesKey(data, Key.ctrl("c"))) {
  process.exit(0);
}

if (matchesKey(data, Key.enter)) {
  submit();
} else if (matchesKey(data, Key.escape)) {
  cancel();
} else if (matchesKey(data, Key.up)) {
  moveUp();
}
```

**键标识符**（使用 `Key.*` 进行自动补全，或字符串字面量）：
- 基本键：`Key.enter`, `Key.escape`, `Key.tab`, `Key.space`, `Key.backspace`, `Key.delete`, `Key.home`, `Key.end`
- 方向键：`Key.up`, `Key.down`, `Key.left`, `Key.right`
- 带有修饰符：`Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")`, `Key.ctrlShift("p")`
- 字符串格式也有效：`"enter"`, `"ctrl+c"`, `"shift+tab"`, `"ctrl+shift+p"`

## 差异渲染

TUI 使用三种渲染策略：

1. **首次渲染**：输出所有行而不清除回滚
2. **宽度更改或视口上方更改**：清屏并完全重新渲染
3. **正常更新**：将光标移动到第一个更改的行，清除到末尾，渲染更改的行

所有更新都包含在 **同步输出** (`\x1b[?2026h` ... `\x1b[?2026l`) 中，以实现原子的、无闪烁的渲染。

## 终端接口

TUI 适用于实现 `Terminal` 接口的任何对象：

```typescript
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
}
```

**内置实现：**
- `ProcessTerminal` - 使用 `process.stdin/stdout`
- `VirtualTerminal` - 用于测试（使用 `@xterm/headless`）

## 实用工具

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

// 获取字符串的可见宽度（忽略 ANSI 代码）
const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5

// 将字符串截断为宽度（保留 ANSI 代码，添加省略号）
const truncated = truncateToWidth("Hello World", 8); // "Hello..."

// 截断但不带省略号
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, ""); // "Hello Wo"

// 将文本换行为宽度（跨换行符保留 ANSI 代码）
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"]
```

## 创建自定义组件

创建自定义组件时，**`render()` 返回的每一行不得超过 `width` 参数**。如果任何行宽于终端，TUI 将报错。

### 处理输入

使用 `matchesKey()` 和 `Key` 助手处理键盘输入：

```typescript
import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";

class MyInteractiveComponent implements Component {
  private selectedIndex = 0;
  private items = ["Option 1", "Option 2", "Option 3"];
  
  public onSelect?: (index: number) => void;
  public onCancel?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    return this.items.map((item, i) => {
      const prefix = i === this.selectedIndex ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
  }
}
```

### 处理行宽

使用提供的实用工具确保行适合：

```typescript
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";

class MyComponent implements Component {
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    // 选项 1：截断长行
    return [truncateToWidth(this.text, width)];

    // 选项 2：检查并填充到确切宽度
    const line = this.text;
    const visible = visibleWidth(line);
    if (visible > width) {
      return [truncateToWidth(line, width)];
    }
    // 填充到确切宽度（可选，用于背景）
    return [line + " ".repeat(width - visible)];
  }
}
```

### ANSI 代码注意事项

`visibleWidth()` 和 `truncateToWidth()` 都能正确处理 ANSI 转义代码：

- `visibleWidth()` 在计算宽度时忽略 ANSI 代码
- `truncateToWidth()` 保留 ANSI 代码并在截断时正确关闭它们

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11 (不计算 ANSI 代码)
const truncated = truncateToWidth(styled, 8); // Red "Hello" + " W..." 带有正确的重置
```

### 缓存

为了性能，组件应缓存其渲染输出，并且仅在必要时重新渲染：

```typescript
class CachedComponent implements Component {
  private text: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = [truncateToWidth(this.text, width)];

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

## 示例

查看 `test/chat-simple.ts` 了解完整的聊天界面示例，包括：
- 带有自定义背景颜色的 Markdown 消息
- 响应期间的加载旋转器
- 带有自动补全和斜杠命令的编辑器
- 消息之间的间隔

运行它：
```bash
npx tsx test/chat-simple.ts
```

## 开发

```bash
# 安装依赖项（从 monorepo 根目录）
npm install

# 运行类型检查
npm run check

# 运行演示
npx tsx test/chat-simple.ts
```

### 调试日志

设置 `PI_TUI_WRITE_LOG` 以捕获写入 stdout 的原始 ANSI 流。

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log npx tsx test/chat-simple.ts
```

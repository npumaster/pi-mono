# 事件系统

事件系统允许 Mom 由计划的或即时的事件触发。事件是 `workspace/events/` 目录中的 JSON 文件。Harness 会监视此目录，并在事件到期时执行它们。

## 事件类型

### 即时事件 (Immediate)

Harness 一发现文件就立即执行。由 Mom 编写的程序使用，用于通知外部事件（webhooks、文件更改、API 回调等）。

```json
{
  "type": "immediate",
  "channelId": "C123ABC",
  "text": "New support ticket received: #12345"
}
```

执行后，文件将被删除。陈旧性由文件 mtime 确定（见启动行为）。

### 一次性事件 (One-Shot)

在特定日期/时间执行一次。用于提醒、计划任务或延期操作。

```json
{
  "type": "one-shot",
  "channelId": "C123ABC",
  "text": "Remind Mario about the dentist appointment",
  "at": "2025-12-15T09:00:00+01:00"
}
```

`at` 时间戳必须包含时区偏移量。执行后，文件将被删除。

### 周期性事件 (Periodic)

按 cron 计划重复执行。用于定期任务，如每日摘要、每周报告或定期检查。

```json
{
  "type": "periodic",
  "channelId": "C123ABC",
  "text": "Check inbox and post summary",
  "schedule": "0 9 * * 1-5",
  "timezone": "Europe/Vienna"
}
```

`schedule` 字段使用标准 cron 语法。`timezone` 字段使用 IANA 时区名称。文件将一直保留，直到被 Mom 或创建它的程序显式删除。

#### Cron 格式

`minute hour day-of-month month day-of-week`

示例：
- `0 9 * * *` — 每天 9:00
- `0 9 * * 1-5` — 工作日 9:00
- `30 14 * * 1` — 周一 14:30
- `0 0 1 * *` — 每月 1 号午夜
- `*/15 * * * *` — 每 15 分钟

## 时区处理

所有时间戳必须包含时区信息：
- 对于 `one-shot`：使用带偏移量的 ISO 8601 格式（例如 `2025-12-15T09:00:00+01:00`）
- 对于 `periodic`：使用带 IANA 时区名称的 `timezone` 字段（例如 `Europe/Vienna`, `America/New_York`）

Harness 在主机进程时区中运行。当用户提到时间而未指定时区时，假定为 Harness 时区。

## Harness 行为

### 启动

1. 扫描 `workspace/events/` 中的所有 `.json` 文件
2. 解析每个事件文件
3. 对于每个事件：
   - **即时事件**：检查文件 mtime。如果文件是在 Harness 未运行（mtime < harness 启动时间）时创建的，则视为陈旧。删除而不执行。否则，立即执行并删除。
   - **一次性事件**：如果 `at` 在过去，删除文件。如果 `at` 在未来，设置 `setTimeout` 在指定时间执行。
   - **周期性事件**：设置 cron 作业（使用 `croner` 库）按指定计划执行。如果 Harness 停机期间错过了计划时间，**不**补执行。等待下一次计划发生。

### 文件系统监视

Harness 使用 `fs.watch()` 监视 `workspace/events/`，去抖动时间为 100ms。

**添加新文件：**
- 解析事件
- 根据类型：立即执行、设置 `setTimeout` 或设置 cron 作业

**修改现有文件：**
- 取消此文件的任何现有计时器/cron
- 重新解析并重新设置（允许重新调度）

**删除文件：**
- 取消此文件的任何现有计时器/cron

### 解析错误

如果 JSON 文件解析失败：
1. 以指数退避重试（100ms, 200ms, 400ms）
2. 如果重试后仍然失败，删除文件并将错误记录到控制台

### 执行错误

如果代理在处理事件时出错：
1. 向频道发布错误消息
2. 删除事件文件（对于即时/一次性事件）
3. 不重试

## 队列集成

事件与 `SlackBot` 中现有的 `ChannelQueue` 集成：

- 新方法：`SlackBot.enqueueEvent(event: SlackEvent)` — 始终入队，无“已经在工作”拒绝
- 每个频道最多可排队 5 个事件。如果队列已满，丢弃并记录到控制台。
- 用户 @mom 提及保留当前行为：如果代理忙碌，则以“Already working”消息拒绝

当事件触发时：
1. 创建带有格式化消息的合成 `SlackEvent`
2. 调用 `slack.enqueueEvent(event)`
3. 如果代理忙碌，事件在队列中等待，空闲时处理

## 事件执行

当事件出队并执行时：

1. 发布状态消息："_Starting event: {filename}_"
2. 使用以下消息调用代理：`[EVENT:{filename}:{type}:{schedule}] {text}`
   - 对于即时事件：`[EVENT:webhook-123.json:immediate] New support ticket`
   - 对于一次性事件：`[EVENT:dentist.json:one-shot:2025-12-15T09:00:00+01:00] Remind Mario`
   - 对于周期性事件：`[EVENT:daily-inbox.json:periodic:0 9 * * 1-5] Check inbox`
3. 执行后：
   - 如果响应是 `[SILENT]`：删除状态消息，不向 Slack 发布任何内容
   - 即时和一次性事件：删除事件文件
   - 周期性事件：保留文件，事件将按计划再次触发

## 静默完成 (Silent Completion)

对于检查活动（收件箱、通知等）的周期性事件，Mom 可能没有发现任何要报告的内容。为了避免在频道中刷屏，Mom 可以仅响应 `[SILENT]`。这将删除 "Starting event..." 状态消息，并且不向 Slack 发布任何内容。

示例：一个周期性事件每 15 分钟检查一次新邮件。如果没有新邮件，Mom 响应 `[SILENT]`。如果有新邮件，Mom 发布摘要。

## 文件命名

事件文件应具有描述性名称，并以 `.json` 结尾：
- `webhook-12345.json` (即时)
- `dentist-reminder-2025-12-15.json` (一次性)
- `daily-inbox-summary.json` (周期性)

文件名用作跟踪计时器的标识符，并出现在事件消息中。避免特殊字符。

## 实现

### 文件

- `src/events.ts` — 事件解析、计时器管理、fs 监视
- `src/slack.ts` — 添加 `enqueueEvent()` 方法和 `size()` 到 `ChannelQueue`
- `src/main.ts` — 在启动时初始化事件监视器
- `src/agent.ts` — 使用事件文档更新系统提示

### 关键组件

```typescript
// events.ts

interface ImmediateEvent {
  type: "immediate";
  channelId: string;
  text: string;
}

interface OneShotEvent {
  type: "one-shot";
  channelId: string;
  text: string;
  at: string; // ISO 8601 with timezone offset
}

interface PeriodicEvent {
  type: "periodic";
  channelId: string;
  text: string;
  schedule: string; // cron syntax
  timezone: string; // IANA timezone
}

type MomEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

class EventsWatcher {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private crons: Map<string, Cron> = new Map();
  private startTime: number;
  
  constructor(
    private eventsDir: string,
    private slack: SlackBot,
    private onError: (filename: string, error: Error) => void
  ) {
    this.startTime = Date.now();
  }
  
  start(): void { /* scan existing, setup fs.watch */ }
  stop(): void { /* cancel all timers/crons, stop watching */ }
  
  private handleFile(filename: string): void { /* parse, schedule */ }
  private handleDelete(filename: string): void { /* cancel timer/cron */ }
  private execute(filename: string, event: MomEvent): void { /* enqueue */ }
}
```

### 依赖项

- `croner` — 支持时区的 Cron 调度

## 系统提示部分

以下内容应添加到 Mom 的系统提示中：

```markdown
## Events

你可以安排在特定时间或当外部事情发生时唤醒你的事件。事件是 `/workspace/events/` 中的 JSON 文件。

### Event Types

**Immediate** — Harness 一看到文件就触发。用于脚本/webhooks 中以通知外部事件。
```json
{"type": "immediate", "channelId": "C123", "text": "New GitHub issue opened"}
```

**One-shot** — 在特定时间触发一次。用于提醒。
```json
{"type": "one-shot", "channelId": "C123", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
```

**Periodic** — 按 cron 计划触发。用于定期任务。
```json
{"type": "periodic", "channelId": "C123", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "Europe/Vienna"}
```

### Cron Format

`minute hour day-of-month month day-of-week`

- `0 9 * * *` = 每天 9:00
- `0 9 * * 1-5` = 工作日 9:00
- `30 14 * * 1` = 周一 14:30
- `0 0 1 * *` = 每月 1 号午夜

### Timezones

所有 `at` 时间戳必须包含偏移量（例如 `+01:00`）。周期性事件使用 IANA 时区名称。Harness 运行在 ${TIMEZONE}。当用户提到时间而未指定时区时，假定为 ${TIMEZONE}。

### Creating Events

```bash
cat > /workspace/events/dentist-reminder.json << 'EOF'
{"type": "one-shot", "channelId": "${CHANNEL}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
```

### Managing Events

- 列出: `ls /workspace/events/`
- 查看: `cat /workspace/events/foo.json`
- 删除/取消: `rm /workspace/events/foo.json`

### When Events Trigger

你会收到如下消息：
```
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
```

即时和一次性事件在触发后自动删除。周期性事件会一直保留，直到你删除它们。

### Debouncing

编写创建即时事件的程序（电子邮件观察器、webhook 处理程序等）时，务必去抖动。如果一分钟内收到 50 封电子邮件，不要创建 50 个即时事件。相反：

- 在一个窗口（例如 30 秒）内收集事件
- 创建一个总结发生情况的即时事件
- 或者只是发出“新活动，检查收件箱”的信号，而不是每项一个事件

Bad:
```bash
# Creates event per email — will flood the queue
on_email() { echo '{"type":"immediate"...}' > /workspace/events/email-$ID.json; }
```

Good:
```bash
# Debounce: flag file + single delayed event  
on_email() {
  echo "$SUBJECT" >> /tmp/pending-emails.txt
  if [ ! -f /workspace/events/email-batch.json ]; then
    (sleep 30 && mv /tmp/pending-emails.txt /workspace/events/email-batch.json) &
  fi
}
```

或者更简单：使用周期性事件每 15 分钟检查一次新邮件，而不是即时事件。

### Limits

最多可排队 5 个事件。不要创建过多的即时或周期性事件。
```

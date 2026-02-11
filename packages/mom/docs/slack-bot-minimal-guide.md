# 最小化 Slack 机器人设置（无 Web 服务器，仅 WebSocket）

这里介绍如何使用 **Socket Mode** 将你的 Node.js 代理连接到 Slack - 无需 Express，无需 HTTP 服务器，只需 WebSocket 和回调。

---

## 1. 依赖项

```bash
npm install @slack/socket-mode @slack/web-api
```

就是这样。两个包：
- `@slack/socket-mode` - 通过 WebSocket 接收事件
- `@slack/web-api` - 发送消息回 Slack

---

## 2. 获取你的令牌

你需要 **两个令牌**：

### A. 机器人令牌 (`xoxb-...`)
1. 前往 https://api.slack.com/apps
2. 创建应用 → "From scratch"
3. 点击侧边栏中的 "OAuth & Permissions"
4. 添加 **Bot Token Scopes**（全部 16 个）：
   ```
   app_mentions:read
   channels:history
   channels:join
   channels:read
   chat:write
   files:read
   files:write
   groups:history
   groups:read
   im:history
   im:read
   im:write
   mpim:history
   mpim:read
   mpim:write
   users:read
   ```
5. 点击顶部的 "Install to Workspace"
6. 复制 **Bot User OAuth Token**（以 `xoxb-` 开头）

### B. 应用级令牌 (`xapp-...`)
1. 在同一个应用中，点击侧边栏中的 "Basic Information"
2. 滚动到 "App-Level Tokens"
3. 点击 "Generate Token and Scopes"
4. 随便起个名字（例如 "socket-token"）
5. 添加范围：`connections:write`
6. 点击 "Generate"
7. 复制令牌（以 `xapp-` 开头）

---

## 3. 启用 Socket Mode

1. 前往 https://api.slack.com/apps → 选择你的应用
2. 点击侧边栏中的 **"Socket Mode"**
3. 将 **"Enable Socket Mode"** 切换为 ON
4. 这会将你的应用的交互和事件通过 WebSocket 路由，而不是公共 HTTP 端点
5. 完成 - 不需要 webhook URL！

**注意：** Socket Mode 适用于开发中的内部应用或防火墙后的应用。不适用于通过 Slack Marketplace 分发的应用。

---

## 4. 启用直接消息

1. 前往 https://api.slack.com/apps → 选择你的应用
2. 点击侧边栏中的 **"App Home"**
3. 滚动到 **"Show Tabs"** 部分
4. 勾选 **"Allow users to send Slash commands and messages from the messages tab"**
5. 保存

---

## 5. 订阅事件

1. 前往 https://api.slack.com/apps → 选择你的应用
2. 点击侧边栏中的 **"Event Subscriptions"**
3. 将 **"Enable Events"** 切换为 ON
4. **重要：** 不需要 Request URL（Socket Mode 会处理）
5. 展开 **"Subscribe to bot events"**
6. 点击 **"Add Bot User Event"** 并添加：
   - `app_mention`（必需 - 查看机器人何时被提及）
   - `message.channels`（必需 - 记录所有频道消息以获取上下文）
   - `message.groups`（可选 - 查看私有频道消息）
   - `message.im`（必需 - 查看私信）
7. 点击底部的 **"Save Changes"**

---

## 6. 存储令牌

创建 `.env` 文件：

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
```

添加到 `.gitignore`：

```bash
echo ".env" >> .gitignore
```

---

## 7. 最小化工作代码

```javascript
require('dotenv').config();
const { SocketModeClient } = require('@slack/socket-mode');
const { WebClient } = require('@slack/web-api');

const socketClient = new SocketModeClient({ 
  appToken: process.env.SLACK_APP_TOKEN 
});

const webClient = new WebClient(process.env.SLACK_BOT_TOKEN);

// 监听应用提及 (@mom do something)
socketClient.on('app_mention', async ({ event, ack }) => {
  try {
    // 确认收到
    await ack();
    
    console.log('Mentioned:', event.text);
    console.log('Channel:', event.channel);
    console.log('User:', event.user);
    
    // 使用你的代理处理
    const response = await yourAgentFunction(event.text);
    
    // 发送响应
    await webClient.chat.postMessage({
      channel: event.channel,
      text: response
    });
  } catch (error) {
    console.error('Error:', error);
  }
});

// 启动连接
(async () => {
  await socketClient.start();
  console.log('⚡️ Bot connected and listening!');
})();

// 你现有的代理逻辑
async function yourAgentFunction(text) {
  // 你的代码在这里
  return "I processed: " + text;
}
```

**就是这样。没有 Web 服务器。只需运行它：**

```bash
node bot.js
```

---

## 8. 监听所有事件（不仅是提及）

如果你想查看机器人所在的频道/私信中的每条消息：

```javascript
// 监听所有 Slack 事件
socketClient.on('slack_event', async ({ event, body, ack }) => {
  await ack();
  
  console.log('Event type:', event.type);
  console.log('Event data:', event);
  
  if (event.type === 'message' && event.subtype === undefined) {
    // 常规消息（非机器人消息，非编辑等）
    console.log('Message:', event.text);
    console.log('Channel:', event.channel);
    console.log('User:', event.user);
    
    // 你的逻辑在这里
  }
});
```

---

## 9. 常用操作

### 发送消息
```javascript
await webClient.chat.postMessage({
  channel: 'C12345', // 或来自事件的频道 ID
  text: 'Hello!'
});
```

### 发送私信
```javascript
// 打开与用户的私信频道
const result = await webClient.conversations.open({
  users: 'U12345' // 用户 ID
});

// 发送到该私信频道
await webClient.chat.postMessage({
  channel: result.channel.id,
  text: 'Hey there!'
});
```

### 列出频道
```javascript
const channels = await webClient.conversations.list({
  types: 'public_channel,private_channel'
});
console.log(channels.channels);
```

### 获取频道成员
```javascript
const members = await webClient.conversations.members({
  channel: 'C12345'
});
console.log(members.members); // 用户 ID 数组
```

### 获取用户信息
```javascript
const user = await webClient.users.info({
  user: 'U12345'
});
console.log(user.user.name);
console.log(user.user.real_name);
```

### 加入频道
```javascript
await webClient.conversations.join({
  channel: 'C12345'
});
```

### 上传文件
```javascript
await webClient.files.uploadV2({
  channel_id: 'C12345',
  file: fs.createReadStream('./file.pdf'),
  filename: 'document.pdf',
  title: 'My Document'
});
```

---

## 10. 包含代理的完整示例

```javascript
require('dotenv').config();
const { SocketModeClient } = require('@slack/socket-mode');
const { WebClient } = require('@slack/web-api');

const socketClient = new SocketModeClient({ 
  appToken: process.env.SLACK_APP_TOKEN 
});

const webClient = new WebClient(process.env.SLACK_BOT_TOKEN);

// 你现有的代理/AI/whatever
class MyAgent {
  async process(message, context) {
    // 你的复杂逻辑在这里
    // context 包含: user, channel 等
    return `Processed: ${message}`;
  }
}

const agent = new MyAgent();

// 处理提及
socketClient.on('app_mention', async ({ event, ack }) => {
  await ack();
  
  try {
    // 从文本中移除 @mention
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    
    // 使用你的代理处理
    const response = await agent.process(text, {
      user: event.user,
      channel: event.channel
    });
    
    // 发送响应
    await webClient.chat.postMessage({
      channel: event.channel,
      text: response
    });
  } catch (error) {
    console.error('Error processing mention:', error);
    
    // 发送错误消息
    await webClient.chat.postMessage({
      channel: event.channel,
      text: 'Sorry, something went wrong!'
    });
  }
});

// 启动
(async () => {
  await socketClient.start();
  console.log('⚡️ Agent connected to Slack!');
})();
```

---

## 11. 可用事件类型

你在第 4 步中订阅了这些：

- `app_mention` - 有人 @提及机器人
- `message` - 机器人所在的频道/私信中的任何消息

事件对象结构：

```javascript
{
  type: 'app_mention' or 'message',
  text: 'the message text',
  user: 'U12345', // 谁发送的
  channel: 'C12345', // 发送到哪里
  ts: '1234567890.123456' // 时间戳
}
```

---

## 12. Socket Mode 的优势

✅ **无需 Web 服务器** - 只需运行你的脚本
✅ **无需公共 URL** - 在防火墙后工作
✅ **无需 ngrok** - 在 localhost 上工作
✅ **自动重连** - SDK 处理连接断开
✅ **事件驱动** - 只需监听回调

---

## 13. 劣势

❌ 不能分发到 Slack 应用目录（仅适用于你的工作区）
❌ 脚本必须运行才能接收消息（不像 webhook）
❌ 每个应用最多 10 个并发连接

---

## 重要提示

1. **必须调用 `ack()`** 对每个事件进行确认，否则 Slack 会重试
2. **机器人令牌** (`xoxb-`) 用于发送消息
3. **应用令牌** (`xapp-`) 用于通过 WebSocket 接收事件
4. **连接是持久的** - 你的脚本保持运行
5. **不需要 URL 验证**（不像 HTTP webhook）

---

## 故障排除

### "invalid_auth" 错误
- 检查你是否使用了正确的令牌
- WebClient 用机器人令牌，SocketModeClient 用应用令牌

### "missing_scope" 错误
- 确保你添加了所有 16 个机器人范围
- 添加范围后重新安装应用

### 接收不到事件
- 检查 Socket Mode 是否启用
- 检查你是否在 "Event Subscriptions" 中订阅了事件
- 确保机器人在频道中（或使用 `channels:join`）

### 机器人不响应提及
- 必须订阅 `app_mention` 事件
- 机器人必须安装到工作区
- 检查是否调用了 `await ack()`

---

就是这样。没有 HTTP 服务器的麻烦。只有 WebSocket 和回调。

# Feishu Image Bot

飞书生图机器人 — 在飞书群或私聊中 @机器人 发送需求，自动生成图片并回复。

## 功能

- **文生图**：发文字描述，GPT 分析需求并优化提示词，生成图片
- **图生图**：发送参考图 + 文字说明，基于参考图生成新图
- **多图输入**：支持多张参考图同时输入（富文本消息）
- **智能推理**：GPT 自动分析用户意图，优化生图提示词，支持中英文
- **群聊 + 私聊**：支持群内 @机器人 和私聊直接发消息

## 架构

```
用户 @机器人 "画一只太空猫"
    |
    v
飞书 WebSocket（长连接，实时接收消息）
    |
    v
Analyzer（GPT 推理：理解需求 -> 优化提示词）
    |
    v
Painter（GPT Image 2.0 生图）
    |
    v
上传图片到飞书 -> 回复用户
```

## 三种 Provider

| 模式 | 启动参数 | 说明 |
|------|---------|------|
| **Codex**（默认） | `node bot.mjs` | 走本地 Codex CLI + ChatGPT Plus 订阅，无需 API Key |
| OpenAI API | `node bot.mjs --openai` | 走 OpenAI Images API，需要 OPENAI_API_KEY |
| 火山方舟 | `node bot.mjs --ark` | 走 Seedream/豆包，需要 ARK_API_KEY |

## 快速开始

### 1. 创建飞书应用

1. 在[飞书开放平台](https://open.feishu.cn)创建一个自建应用
2. 开启以下权限：
   - `im:message` — 获取与发送单聊、群组消息
   - `im:message:send_as_bot` — 以机器人身份发消息
   - `im:resource` — 读取/上传图片资源
3. 事件订阅方式选择 **长连接（WebSocket）**
4. 订阅 `im.message.receive_v1` 事件

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

创建 `.env.local`：

```env
LARK_APP_ID=your_app_id
LARK_APP_SECRET=your_app_secret

# Codex 模式（默认）不需要以下配置
# OpenAI 模式需要：
OPENAI_API_KEY=your_openai_key
OPENAI_BASE_URL=https://api.openai.com  # 可选，自定义 API 端点

# 火山方舟模式需要：
ARK_API_KEY=your_ark_key
```

### 4. Codex 模式额外步骤

```bash
npm install -g @openai/codex
codex login   # 弹浏览器登录 ChatGPT
```

### 5. 启动

```bash
node bot.mjs              # Codex 模式（默认）
node bot.mjs --openai     # OpenAI API 模式
node bot.mjs --ark        # 火山方舟模式
node bot.mjs --verbose    # 详细日志
```

## 文件结构

```
bot.mjs            # 主入口：飞书 WebSocket + 消息处理
analyzer.mjs       # GPT 推理层（API 版）
analyzer-codex.mjs # GPT 推理层（Codex CLI 版）
painter.mjs        # 生图层（OpenAI API / 火山方舟）
painter-codex.mjs  # 生图层（Codex CLI 版）
feishu.mjs         # 飞书 API 封装
```

## License

MIT

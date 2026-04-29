# Feishu Image Bot

飞书生图机器人 — 在飞书群或私聊中 @机器人 发送需求，自动生成图片并回复。

## 功能

- **文生图**：发文字描述，GPT 分析需求并优化提示词，生成图片
- **图生图**：发送参考图 + 文字说明，基于参考图生成新图
- **多图输入**：支持多张参考图同时输入（富文本消息）
- **智能推理**：GPT 自动分析用户意图，优化生图提示词，支持中英文
- **群聊 + 私聊**：支持群内 @机器人 和私聊直接发消息
- **🆕 本地像素 resize**：用户只想改尺寸/比例/裁切时，毫秒级本地处理，不烧 GPT token
- **🆕 轻量 session 上下文**：按"群+发送人"维度记住最近 3 轮对话和上一张生成图，
  说"再黑一点 / 改成竖版 / 加个翅膀" 自动基于上一版迭代；15 分钟无活动自动过期

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
bot.mjs            # 主入口：飞书 WebSocket + 消息处理 + session 接入
analyzer.mjs       # GPT 推理层（API 版）— 接受 historyBlock 注入上下文
analyzer-codex.mjs # GPT 推理层（Codex CLI 版）— 同上
painter.mjs        # 生图层（OpenAI API / 火山方舟）
painter-codex.mjs  # 生图层（Codex CLI 版）
resizer.mjs        # 🆕 本地像素 resize（sharp）—— 绕过 GPT
session.mjs        # 🆕 轻量 session 管理（per chat:sender，TTL + LRU）
feishu.mjs         # 飞书 API 封装
flatten-alpha.mjs  # 透明 PNG 预处理（防 GPT Image 色块污染）
skills.mjs         # Anthropic 标准 skill loader（YAML + fs.watch 热加载）
skills/
  image-prompt-orchestrator/SKILL.md  # 编排：改图 vs 生图 / JSON vs plain
  image-resize/SKILL.md               # 🆕 触发条件：纯尺寸/比例/裁切
```

## Session 行为详解

### 触发场景

同一个人在同一个聊天窗口发消息，bot 会自动维持上下文：

```
[第 1 条] @bot 画一只太空猫              → 出图 A
[第 2 条] @bot 再黑一点                  → 自动基于 A 调暗（不会重新画一只新猫）
[第 3 条] @bot 改成 1:1 正方形           → 走本地 resize，毫秒返回
[第 4 条] @bot 保留这个色调，画成应龙    → 基于上一版的色调画新主题
```

### 配置（环境变量）

```env
SESSION_TTL_MIN=15      # 上下文保留时长（分钟，默认 15）
SESSION_MAX=200         # 全局最大 session 数（LRU 淘汰，默认 200）
```

### 重置上下文

用户在飞书里发以下任一关键词，立即清掉自己当前会话的上下文：

```
/new   /reset   /clear
新主题   新话题   重新开始   重来   重置上下文
```

### 隔离粒度

session key = `${chat_id}:${sender_id}`：
- 群里 A 和 B 各自独立的上下文，互不污染
- 同一个人在不同群也是独立 session（避免跨场景串场）

### 上一轮图自动复用

bot 会**只缓存上一轮生成的图**（不缓存用户传的原图，避免反复用旧素材）：

- 用户本轮没传图 → 自动复用上一轮生成图作为参考
- 用户本轮传了新图 → 用新图，session 缓存被新一轮的输出覆盖

## Resize 行为详解

只想改尺寸不改内容时，bot 走 **本地 sharp 像素处理**，毫秒级返回：

| 用户说 | bot 做 |
|---|---|
| 把这张图改成 1024x1024 | resize 到 1024×1024，cover 居中裁 |
| 缩小到 512 | resize 到 512×512 |
| 改成 16:9 | 按原图最长边算 16:9 比例 |
| 等比缩到宽 800 | resize 到宽 800（fit=inside） |
| 裁成正方形 | 1:1 cover 居中裁 |
| 改成竖屏 9:16 | 9:16 比例 cover |

带内容修改的不会走 resize（如"改成正方形构图"、"加点猫耳朵" → 走生图）。

详细规则见 `skills/image-resize/SKILL.md`（LLM 触发条件 + 示例）。

## License

MIT

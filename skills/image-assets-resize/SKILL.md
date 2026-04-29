---
name: image-assets-resize
description: 图片物料尺寸延展。用户提供参考图（KV/海报/拍脸图）+ 要求生成不同平台/不同尺寸的版本时触发。底层调用 GPT Image edit 模式按目标规格重新生成版面，再用 sharp 精确缩放至像素级目标尺寸。
---

# image-assets-resize — 图片物料平台尺寸延展

将一张参考图按平台规格批量延展成多个尺寸版本。**重新构图**而不是简单像素缩放，会保留主体并自动适配新比例的版面布局。

## 触发条件（什么时候走这个 skill）

只要用户**有参考图**，且**意图是改尺寸/换平台/批量出多版**，**全部走 platform-edit 模式**，不管原话怎么说。

具体三类典型场景：

### 场景 1 · 明示平台名

| 用户原话 | 抽取的 platforms |
|---|---|
| "做一张小红书封面" | `xiaohongshu-cover` |
| "做小红书 + 抖音两版" | `xiaohongshu-cover,douyin-cover` |
| "公众号封面 + 朋友圈各一份" | `wechat-cover,wechat-moments-portrait` |
| "B 站封面" | `bilibili-cover` |
| "FB 横版 + IG 方版" | `facebook-landscape,instagram-square` |

### 场景 2 · 隐式平台描述

| 用户原话 | 推导出的 platforms |
|---|---|
| "我要发朋友圈" | `wechat-moments-portrait` |
| "做个微博发的方图" | `weibo-square` |
| "我要 post 到 Twitter" | `twitter-square` |
| "做一套社媒物料" | `social-media`（自动展开为多个） |
| "做一套短视频封面" | `short-video`（展开为 douyin/kuaishou/video-cover） |

### 场景 3 · 纯尺寸/比例描述（用内联格式）

| 用户原话 | platforms |
|---|---|
| "改成 1:1" | `自定义:1024x1024` |
| "做个 1200×800 的封面" | `自定义:1200x800` |
| "改成竖版" | `自定义:1080x1920` |
| "改成正方形" | `自定义:1024x1024` |
| "改成 16:9" | `自定义:1920x1080` |

> ⚠️ 即使用户只说"改成 1:1" 这种纯尺寸要求，也走 platform-edit（用 inline 格式 `自定义:1024x1024`），**不再走旧的本地 sharp resize**——因为 platform-edit 会重新构图适配新版面，效果远好于硬缩放。

## 平台 key 完整清单（要选哪个就直接抽 key）

### 国内（直接 key）

```
wechat-cover            微信公众号封面     900×383
wechat-square           公众号方形缩略图   300×300
wechat-moments-portrait 朋友圈竖版海报     1080×1920
wechat-moments-square   朋友圈方版海报     1080×1080
xiaohongshu-cover       小红书笔记封面     1242×1660 (3:4 推荐)
xiaohongshu-square      小红书方版封面     1080×1080
douyin-cover            抖音视频封面       1080×1920
weibo-horizontal        微博横版           1200×675
weibo-square            微博方版           1200×1200
weibo-vertical          微博竖版           1200×1500
video-cover             视频号封面         1080×1080
bilibili-cover          B站视频封面        1146×717
zhihu-cover             知乎封面           1080×1080
taobao-main             淘宝商品主图       800×800
kuaishou-cover          快手视频封面       1080×1920
```

### 海外（直接 key）

```
facebook-square / facebook-landscape / facebook-cover / facebook-stories
instagram-square / instagram-portrait / instagram-stories
twitter-square / twitter-landscape / twitter-banner / twitter-instream
pinterest-pin / pinterest-square / pinterest-idea
linkedin-landscape / linkedin-square / linkedin-banner
```

### 中文别名（这些会被自动映射到对应 key）

```
微信公众号 / 公众号 / 微信       → wechat-cover
公众号封面                      → wechat-cover
朋友圈 / 朋友圈竖版              → wechat-moments-portrait
朋友圈方版                      → wechat-moments-square
小红书 / 小红书封面              → xiaohongshu-cover
抖音                           → douyin-cover
微博 / 微博横版                  → weibo-horizontal
微博方版                       → weibo-square
微博竖版                       → weibo-vertical
视频号                         → video-cover
B 站 / B站封面 / bilibili        → bilibili-cover
知乎                           → zhihu-cover
淘宝 / 淘宝主图                 → taobao-main
快手                           → kuaishou-cover
fb / facebook / Facebook        → facebook-square
ig / instagram / Instagram      → instagram-square
x / twitter / Twitter           → twitter-square
pinterest / Pinterest           → pinterest-pin
linkedin / LinkedIn             → linkedin-landscape
```

### 场景组（自动展开成多个 key）

```
social-media   → wechat-cover,weibo-horizontal,xiaohongshu-cover,douyin-cover
e-commerce     → taobao-main
short-video    → douyin-cover,kuaishou-cover,video-cover
knowledge      → zhihu-cover,bilibili-cover
```

### 自定义内联格式

格式：`<名称>:<宽>x<高>`，例如：

- `五一活动:1200x800`
- `Banner大图:1920x600`
- `自定义:1024x1024`

## 输出 schema（platform-edit mode）

当判断为 platform-edit 时，**输出唯一 1 个** `outputs` 项，所有平台塞在 `platforms` 字段（逗号分隔），不要拆成多个 outputs。

```json
{
  "summary": "把参考图做成小红书 + 抖音两版",
  "needs_clarification": false,
  "outputs": [
    {
      "mode": "platform-edit",
      "format": "plain",
      "filename_suffix": "_assets",
      "prompt": "",
      "platforms": "xiaohongshu-cover,douyin-cover",
      "scene": "五一活动",
      "extra_prompt": "不要带 logo",
      "verify": false
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `mode` | 必须是 `"platform-edit"` |
| `prompt` | **留空字符串** —— 真实 prompt 由 platform-edit 模块按规格自动构建 |
| `platforms` | 逗号分隔的平台 key 列表，支持别名 + 内联 + 场景组 |
| `scene` | 活动/场景名称（用户原话里的"五一活动"、"618 大促"等）；**没说就填空字符串** |
| `extra_prompt` | 用户原话里的额外要求（如"加'立即购买'文字"、"不要带 logo"、"加点喜庆元素"）；**没说就填空字符串** |
| `verify` | 用户**明确要求**"自检 / 检查文字裁切" 才填 `true`，**默认 `false`** |

## clean 模式触发（去 logo / 文字）

当 `extra_prompt` 包含以下任一关键词时，platform-edit 模块会自动切换到 **clean prompt**（去除原图所有文字/LOGO，只保留主体）：

```
不要 logo / 不要带 logo / 去掉 logo / 去除 logo / 无 logo
不要文案 / 不要文字 / 去掉文字 / 去除文字 / 无文字
不要装饰 / 去掉装饰
纯净 / 简洁 / 干净 / 净版 / clean
```

不需要你做特殊判断，原话照抄到 `extra_prompt` 即可。

## 硬性规则

1. **没参考图不要走 platform-edit** —— 这个 skill 必须有原图作 edit 输入，没图就走普通的 text2img 或反问用户要图。
2. **prompt 字段务必留空字符串 `""`** —— 不要自己填，交给底层模块。
3. **platforms 写 key 不要写中文名** —— 抽到中文别名后，**优先翻译成 key**（如"小红书" → `xiaohongshu-cover`）；翻不出来的（用户的自定义场景）才用 inline 格式。
4. **多平台用一个 outputs 项** —— platforms 字段写多个 key 逗号分隔，**不要拆成多个 outputs[]**。
5. **场景组优先**——如果用户说"一套社媒图"、"一套短视频封面"，**优先用 scene group key** 而不是手动列每个平台。

## 不要走 platform-edit 的场景

| 用户原话 | 走哪个 mode |
|---|---|
| "把熊的围领去掉，问号放大" | `image_edit` |
| "保持原图，改成果冻质感" | `image_edit` |
| "基于这张图风格生成新角色" | `img2img`（参考但不保留主体） |
| "画一只赛博猫" | `text2img`（无参考图） |
| "再黑一点" / "改成晚霞色调" | `image_edit`（局部色彩调整不是版面延展） |

## 失败兜底

- platform-edit 单平台失败时，其他平台继续跑 —— 不要因为一个失败就放弃整批。
- 如果 `OPENAI_API_KEY` 未配置，bot 会报错"platform-edit 需要 OPENAI_API_KEY"——这种情况下提示用户检查配置。

---

*基于 OpenClaw `image-assets-resize@1.0.0`（OrangeMoon 作者）2026-04-29 移植到 feishu-image-bot · JS 重写 · 沿用平台规格库与 prompt 模板*

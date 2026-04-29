---
name: image-resize
description: 用户只想改图片尺寸/比例/裁切（不改造型/风格/内容）时，直接走本地像素 resize，绕过生图模型。
---

# image-resize

如果用户的需求只是「调整尺寸 / 改比例 / 裁切」**不涉及修改图片内容**（造型、颜色、构图、主体），不要调 `image_generate`，输出 mode='resize' 让 bot 走本地像素处理（毫秒级返回，不烧 token）。

## 触发条件（必须同时满足）

1. 用户**已经提供了一张参考图**（无图无法 resize，按生图处理）
2. 用户的指令**只**涉及尺寸/比例/裁切，没有要求改图片内容

## 典型触发用语

- "把这张图改成 1024x1024"
- "缩小到 512"
- "resize 到 2:3 比例"
- "裁成正方形"
- "改成竖屏 9:16"
- "压成 1080p 宽"
- "图等比缩到长边 800"

## 反触发（不要识别成 resize）

下面这些虽然提到尺寸但**带内容修改**，必须走生图：

- "改成正方形构图"（"构图"=重新构图，要生图）
- "缩小一点画面元素"（缩元素 ≠ 缩图）
- "把人物变小"（改主体大小，要生图）
- "把这张图改成 1024 大小，再加点猫耳朵"（含内容修改 → 生图）

## 输出 schema

resize 的 outputs 元素格式：

```json
{
  "mode": "resize",
  "format": "plain",
  "filename_suffix": "_resize",
  "prompt": "(人类可读的目标说明，例如：1024×1024 cover 裁切)",
  "size": {
    "width": 1024,
    "height": 1024
  },
  "fit": "cover"
}
```

### size 三种写法（按用户指令选最贴的）

1. **明确宽高**：`{ "width": 1024, "height": 1024 }`
2. **只一边**：`{ "width": 1024 }` 或 `{ "height": 768 }`（另一边按原图比例）
3. **比例 + 最长边**：`{ "ratio": "16:9", "longest": 1920 }` —— 用户说"改成 16:9"但没说具体大小时用

### fit 五种模式

- `cover`（默认）：等比放大覆盖目标尺寸，多余裁掉。**用户没明确时用 cover**
- `contain`：等比缩放装入目标尺寸，剩余部分填白底。用户说"完整保留" / "不要裁切" 时用
- `fill`：强制拉到目标尺寸（会变形）。用户明确说"拉伸 / 填满"时用
- `inside`：等比缩到不超过目标。用户说"缩到不超过 1024" 时用
- `outside`：等比缩到至少覆盖目标。基本用不上，跳过

## 多版输出规则

resize 是确定性操作，**只输出 1 版**（无 JSON/plain 对比版的概念）。

## 完整示例

**用户**："把这张图改成 1:1 正方形"
**outputs**：
```json
[{
  "mode": "resize",
  "format": "plain",
  "filename_suffix": "_resize",
  "prompt": "1:1 正方形（cover 居中裁切）",
  "size": { "ratio": "1:1", "longest": 1024 },
  "fit": "cover"
}]
```

**用户**："缩小到 512"
**outputs**（默认正方形）：
```json
[{
  "mode": "resize",
  "format": "plain",
  "filename_suffix": "_resize",
  "prompt": "缩小到 512×512",
  "size": { "width": 512, "height": 512 },
  "fit": "cover"
}]
```

**用户**："等比缩到宽 800"
**outputs**：
```json
[{
  "mode": "resize",
  "format": "plain",
  "filename_suffix": "_resize",
  "prompt": "等比缩到宽 800",
  "size": { "width": 800 },
  "fit": "inside"
}]
```

**用户**："改成 16:9"
**outputs**（按原图最长边推 ratio）：
```json
[{
  "mode": "resize",
  "format": "plain",
  "filename_suffix": "_resize",
  "prompt": "16:9 比例",
  "size": { "ratio": "16:9" },
  "fit": "cover"
}]
```

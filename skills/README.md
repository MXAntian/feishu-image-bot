# Skills

bot 启动时自动加载本目录下的所有 skill，注入到 GPT 推理（analyzer）的 system prompt 中，让 LLM 在改写生图提示词时遵循 skill 的领域约束。

## 文件组织（Anthropic Skill 标准）

```
skills/
  <skill-name>/
    SKILL.md           # 必需：YAML frontmatter + Markdown body
    [资源文件]          # 可选：模板、参考图等（暂未启用）
```

## SKILL.md 文件格式

每个 SKILL.md 必须以 YAML frontmatter 开头，至少包含 `name` 和 `description`：

```markdown
---
name: <skill-slug>
description: <一句话说明这个 skill 干什么用的>
---

# <Skill 标题>

<完整的 skill 内容 ...>
```

- `name`：英文 slug，跟目录名建议保持一致
- `description`：一句话描述，会注入到 system prompt 让 LLM 理解 skill 用途
- body：完整的领域知识/规则/模板，LLM 会逐字遵循

## 热加载

bot 运行时如果改了 skills/ 下的内容（新增、修改、删除），会自动重新加载，不用重启 bot。

加载日志会打印到 stdout：
```
📚 Loaded 1 skill(s): image-prompt-orchestrator
📚 Reloaded 2 skill(s) after change
```

## 当前 Skills

| Skill | 用途 |
|---|---|
| image-prompt-orchestrator | 图像任务提示词编排（改图 vs 生图判断、JSON/自然语言双版输出） |

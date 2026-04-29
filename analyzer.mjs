// ============================================================
// GPT 推理层 — 分析需求 + 生成生图 prompt（OpenAI / Ark API 模式）
//
// v2: 加载 skills/ 注入 system prompt；输出 schema 改成 outputs 数组，
//     支持 skill 要求的多版（JSON + 自然语言）输出与 needs_clarification 反问。
// ============================================================

import { getSkillsPromptBlock } from './skills.mjs'

const BASE_SYSTEM_PROMPT = `你是一个专业的 AI 生图提示词优化师。
用户会给你一段生图需求（可能附带参考图片），你需要：

1. 理解用户的真实意图。
2. 严格遵循下方"已加载 Skills"段落里每个 skill 的指令、清单、模板与硬性规则。
3. 按 skill 要求决定输出几版 prompt（每一版对应一次生图调用）。
4. 当用户的意图不明确（典型场景：skill 中要求"必须先反问"），不要直接生图，把 needs_clarification 设为 true 并填 clarification_question。

输出格式（严格 JSON，不要用 markdown 代码块包裹）：

{
  "summary": "一句话中文总结你理解的需求",
  "needs_clarification": false,
  "clarification_question": "",
  "outputs": [
    {
      "mode": "text2img" | "img2img" | "image_edit" | "resize",
      "format": "json" | "plain",
      "filename_suffix": "_json" | "_plain" | "_resize" | "",
      "prompt": "最终发给生图模型的提示词（JSON 版就是 JSON 字符串，plain 版就是自然语言）；mode=resize 时填人类可读的目标说明",
      "negative_prompt": "可选，仅 plain 版用得到",
      "size": "(仅 mode=resize 用) 见 image-resize skill",
      "fit": "(仅 mode=resize 用) cover/contain/fill/inside/outside"
    }
  ]
}

通用约束：
- 单纯改图 → outputs 1 个，format 由 skill 决定（默认 json）。
- 生图 + 有参考图 → 按 skill 要求输出 2 个（一个 json 一个 plain）。
- 生图 + 无参考图 → outputs 1 个，format=plain。
- 纯尺寸/比例/裁切（image-resize skill 触发）→ outputs 1 个，mode=resize，含 size 字段。
- 提示词语言：中文场景/中文文字渲染用中文，其他英文。
- needs_clarification=true 时 outputs 可以是空数组 []。
- 不要解释、不要 markdown、直接输出 JSON。`

function buildSystemPrompt(historyBlock = '') {
  const skillsBlock = getSkillsPromptBlock()
  let out = BASE_SYSTEM_PROMPT
  if (skillsBlock) out += '\n\n' + skillsBlock
  if (historyBlock) out += '\n\n' + historyBlock
  return out
}

/**
 * 拼装 flatten 注解（告诉 LLM 参考图被预处理过，不要把纯色底当成"想要的背景"）
 * @param {boolean} refsFlattened
 * @param {string} flattenBg
 * @returns {string}
 */
export function buildFlattenNotice(refsFlattened, flattenBg = '#ffffff') {
  if (!refsFlattened) return ''
  return [
    '',
    '⚠️ 参考图预处理说明：',
    `用户原图是带透明背景的 PNG，已经被预处理成纯色 ${flattenBg} 底（避免 GPT Image 把透明区识别成"风格化彩色色块"）。`,
    `这个 ${flattenBg} 区域不是用户想要的背景，只是占位 — 在你输出的 prompt 里务必明确：`,
    '  - 不要把这个纯色当成"参考的背景"',
    '  - 不要让生成图保留这个纯色背景',
    '  - 只参考主体（非纯色区域）的造型/风格/颜色',
    '  - 输出图的背景由用户文字需求决定（用户没说就默认干净简洁背景）',
    '',
  ].join('\n')
}

/**
 * 调用 GPT 推理分析用户需求
 * @param {string} apiKey - OpenAI API key（或火山方舟 key）
 * @param {string} userText - 用户的文字需求
 * @param {string[]} imageBase64List - 用户附带的图片（base64 编码）
 * @param {object} options - { provider, baseUrl, chatModel, refsFlattened, flattenBg }
 * @returns {Promise<{summary, needs_clarification, clarification_question, outputs: Array}>}
 */
export async function analyzeRequest(apiKey, userText, imageBase64List = [], options = {}) {
  const provider = options.provider || 'openai'

  // user content 构造
  const flattenNotice = buildFlattenNotice(options.refsFlattened, options.flattenBg)
  const userTextFinal = (userText || '请根据附图生成类似风格的图片') + flattenNotice
  const content = []
  content.push({ type: 'text', text: userTextFinal })
  for (const b64 of imageBase64List) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${b64}` },
    })
  }

  const systemPrompt = buildSystemPrompt(options.historyBlock || '')

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content },
  ]

  const baseUrl = (options.baseUrl || 'https://api.openai.com').replace(/\/+$/, '')

  let url, headers, body
  if (provider === 'ark') {
    // 火山方舟（豆包）
    url = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }
    body = {
      model: 'doubao-1-5-vision-pro-32k-250115',
      messages,
      temperature: 0.3,
    }
  } else {
    url = `${baseUrl}/v1/chat/completions`
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }
    body = {
      model: options.chatModel || 'gpt-4o',
      messages,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }
  }

  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`GPT 推理失败 (${r.status}): ${errText}`)
  }

  const j = await r.json()
  const raw = j.choices?.[0]?.message?.content || ''

  let parsed
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
  } catch (e) {
    throw new Error(`GPT 返回解析失败: ${raw.slice(0, 200)}`)
  }

  return normalizeAnalysis(parsed)
}

/**
 * 兼容旧 schema（mode + prompt 平铺）→ 新 schema（outputs 数组）
 * 让本模块 + analyzer-codex.mjs 共用一份归一化逻辑
 */
export function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('analyzer 返回非法 JSON')
  }

  const summary = raw.summary || ''
  const needs_clarification = !!raw.needs_clarification
  const clarification_question = raw.clarification_question || ''

  // 已经是新 schema
  if (Array.isArray(raw.outputs)) {
    return {
      summary,
      needs_clarification,
      clarification_question,
      outputs: raw.outputs.map(o => ({
        mode: o.mode || 'text2img',
        format: o.format || 'plain',
        filename_suffix: o.filename_suffix || '',
        prompt: o.prompt || '',
        negative_prompt: o.negative_prompt || '',
        size: o.size || null,
        fit: o.fit || null,
      })).filter(o => o.prompt || o.mode === 'resize'),
    }
  }

  // 旧 schema 兼容：{ mode, prompt, negative_prompt, summary }
  if (raw.prompt) {
    return {
      summary,
      needs_clarification,
      clarification_question,
      outputs: [{
        mode: raw.mode || 'text2img',
        format: 'plain',
        filename_suffix: '',
        prompt: raw.prompt,
        negative_prompt: raw.negative_prompt || '',
      }],
    }
  }

  // needs_clarification=true 时 outputs 可以为空
  return {
    summary,
    needs_clarification,
    clarification_question,
    outputs: [],
  }
}

// 导出 buildSystemPrompt 给 codex 版复用
export { buildSystemPrompt }

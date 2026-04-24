// ============================================================
// GPT 推理层 — 分析需求 + 生成生图 prompt
// ============================================================

const SYSTEM_PROMPT = `你是一个专业的AI生图提示词优化师。
用户会给你一段生图需求（可能附带参考图片），你需要：

1. 理解用户的真实意图
2. 生成一段优化后的英文提示词，用于 GPT Image 2.0 / Seedream 生图
3. 判断这是"文生图"还是"图生图"任务

输出格式（严格JSON）：
{
  "mode": "text2img" | "img2img",
  "prompt": "优化后的英文生图提示词",
  "negative_prompt": "负面提示词（可选，如果需要）",
  "summary": "一句话中文总结你理解的需求"
}

注意：
- 提示词必须是英文
- 如果用户提供了参考图，mode 应为 img2img
- 提示词要具体、有画面感，包含风格/构图/光影等细节
- 不要解释，直接输出 JSON`

/**
 * 调用 GPT 推理分析用户需求
 * @param {string} apiKey - OpenAI API key（测试阶段用火山方舟 key）
 * @param {string} userText - 用户的文字需求
 * @param {string[]} imageBase64List - 用户附带的图片（base64 编码）
 * @param {object} options - { provider: 'openai' | 'ark' }
 */
export async function analyzeRequest(apiKey, userText, imageBase64List = [], options = {}) {
  const provider = options.provider || 'openai'

  // 构造消息内容
  const content = []
  content.push({ type: 'text', text: userText || '请根据附图生成类似风格的图片' })
  for (const b64 of imageBase64List) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${b64}` },
    })
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
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
    // OpenAI（支持自定义 base URL）
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

  try {
    // 尝试提取 JSON（可能被 markdown 包裹）
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    return JSON.parse(jsonMatch ? jsonMatch[0] : raw)
  } catch (e) {
    throw new Error(`GPT 返回解析失败: ${raw.slice(0, 200)}`)
  }
}

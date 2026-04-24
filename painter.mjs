// ============================================================
// 生图层 — 抽象接口，Seedream / GPT Image 可切换
// ============================================================

/**
 * 生成图片
 * @param {string} apiKey
 * @param {object} analysis - analyzeRequest 的返回值
 * @param {Buffer[]} refImages - 参考图 Buffer 列表（图生图时用）
 * @param {object} options - { provider: 'openai' | 'ark' }
 * @returns {Promise<Buffer>} 生成的图片 Buffer
 */
export async function generateImage(apiKey, analysis, refImages = [], options = {}) {
  const provider = options.provider || 'openai'

  if (provider === 'ark') {
    return generateWithArk(apiKey, analysis, refImages)
  } else {
    return generateWithOpenAI(apiKey, analysis, refImages, options)
  }
}

// ── GPT Image 2.0 (gpt-image-1) ────────────────────────────
async function generateWithOpenAI(apiKey, analysis, refImages, options = {}) {
  const baseUrl = (options.baseUrl || 'https://api.openai.com').replace(/\/+$/, '')
  const imageModel = options.imageModel || 'gpt-image-1'

  const form = new FormData()
  form.append('model', imageModel)
  form.append('prompt', analysis.prompt)
  form.append('size', '1024x1024')
  form.append('quality', 'high')

  // 图生图：附带参考图
  for (let i = 0; i < refImages.length; i++) {
    form.append('image[]', new Blob([refImages[i]], { type: 'image/png' }), `ref_${i}.png`)
  }

  const r = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`OpenAI Image 生成失败 (${r.status}): ${errText}`)
  }

  const j = await r.json()
  // GPT Image 返回 base64 或 url
  const imgData = j.data?.[0]
  if (imgData.b64_json) {
    return Buffer.from(imgData.b64_json, 'base64')
  } else if (imgData.url) {
    const imgR = await fetch(imgData.url)
    return Buffer.from(await imgR.arrayBuffer())
  }
  throw new Error('OpenAI Image 返回格式异常')
}

// ── 火山方舟 Seedream（测试用）────────────────────────────
async function generateWithArk(apiKey, analysis, refImages) {
  const body = {
    model: 'seedream-3-0-t2i-250201',
    prompt: analysis.prompt,
    size: '1024x1024',
    response_format: 'b64_json',
  }

  // Seedream 图生图（如果有参考图）
  if (refImages.length > 0 && analysis.mode === 'img2img') {
    body.model = 'doubao-seededit-3-0-i2i-250628'
    body.image = refImages[0].toString('base64')
    // SeedEdit 用 prompt 描述编辑意图
  }

  const r = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Ark Image 生成失败 (${r.status}): ${errText}`)
  }

  const j = await r.json()
  const imgData = j.data?.[0]
  if (imgData?.b64_json) {
    return Buffer.from(imgData.b64_json, 'base64')
  } else if (imgData?.url) {
    const imgR = await fetch(imgData.url)
    return Buffer.from(await imgR.arrayBuffer())
  }
  throw new Error('Ark Image 返回格式异常')
}

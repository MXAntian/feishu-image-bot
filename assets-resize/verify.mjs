// ============================================================
// AI self-check (GPT-4o vision) — text cropping / element completeness.
// Ported from verify_image() in generate_image.py.
//
// Failure modes degrade gracefully (return passed=true) so this is
// purely advisory and never blocks the pipeline.
// ============================================================

const VERIFY_MODEL = process.env.VERIFY_MODEL || 'gpt-4o'
const VERIFY_TIMEOUT_MS = 60_000

const VERIFY_PROMPT = (
  'Check this marketing image for:\n' +
  '1) TEXT CROPPING: Is any text partially cut off at edges? (CRITICAL)\n' +
  '2) ELEMENT COMPLETENESS: Are any elements clipped?\n' +
  '3) OVERALL QUALITY: Professional looking?\n' +
  'Reply PASS or list specific issues.'
)

/**
 * @param {Buffer} imageBuf
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.model]
 * @returns {Promise<{ passed: boolean, issues: string[], raw?: string }>}
 */
export async function verifyImage(imageBuf, opts = {}) {
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY
  if (!apiKey) return { passed: true, issues: ['skipped: no api key'] }
  if (!Buffer.isBuffer(imageBuf)) return { passed: true, issues: ['skipped: invalid buffer'] }

  const baseUrl = (opts.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')
  const model = opts.model || VERIFY_MODEL

  const b64 = imageBuf.toString('base64')
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: VERIFY_PROMPT },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }],
    max_tokens: 500,
    temperature: 0.3,
  }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), VERIFY_TIMEOUT_MS)

  try {
    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    clearTimeout(timer)

    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      return { passed: true, issues: [`verify HTTP ${r.status}: ${txt.slice(0, 120)}`] }
    }
    const j = await r.json()
    const content = j?.choices?.[0]?.message?.content
    if (typeof content !== 'string') return { passed: true, issues: ['verify: empty response'] }

    const upper = content.toUpperCase()
    const passed = upper.includes('PASS') && !content.toLowerCase().includes('crop')

    const issues = []
    if (!passed) {
      for (let line of content.split('\n')) {
        line = line.trim().replace(/^[-•·]\s*/, '').trim()
        if (line.length > 5) issues.push(line.slice(0, 200))
      }
    }
    return { passed, issues, raw: content }
  } catch (err) {
    clearTimeout(timer)
    return { passed: true, issues: [`verify exception: ${err.message}`] }
  }
}

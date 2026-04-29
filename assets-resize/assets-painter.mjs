// ============================================================
// OpenAI Images edit API caller for image-assets-resize.
// Uses /v1/images/edits with custom size + quality.
//
// Distinct from the existing painter.mjs (which calls /generations
// with size hardcoded to 1024x1024). This module is purpose-built
// for arbitrary platform-spec dimensions.
//
// Compatible with OpenAI official + OpenAI-compatible proxies
// (base url configurable via env or option).
// ============================================================

const DEFAULT_MODEL = 'gpt-image-1'
const DEFAULT_TIMEOUT_MS = 600_000 // 10 min — large size + edit can be slow

/**
 * Edit an image to match a target spec.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {Buffer} opts.image       Reference image buffer (PNG / JPEG)
 * @param {string} opts.prompt      Edit instruction
 * @param {string} opts.size        "WxH" — must satisfy gpt-image-2 rules (16-mult + ≥1MP)
 * @param {string} [opts.quality]   low | medium | high (default 'medium')
 * @param {string} [opts.model]     default 'gpt-image-1'
 * @param {string} [opts.baseUrl]   default 'https://api.openai.com'
 * @param {number} [opts.timeoutMs] default 600_000
 * @param {string} [opts.imageMime] default detect → 'image/png'
 * @returns {Promise<{ buf: Buffer, elapsedMs: number }>}
 */
export async function editImage(opts) {
  const {
    apiKey, image, prompt, size,
    quality = 'medium',
    model = DEFAULT_MODEL,
    baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, ''),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    imageMime,
  } = opts

  if (!apiKey) throw new Error('editImage: apiKey is required')
  if (!image || !Buffer.isBuffer(image)) throw new Error('editImage: image Buffer is required')
  if (!prompt) throw new Error('editImage: prompt is required')
  if (!size) throw new Error('editImage: size is required (e.g. "1024x1024")')

  const mime = imageMime || sniffMime(image) || 'image/png'
  const ext = mimeToExt(mime)

  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  form.append('size', size)
  form.append('quality', quality)
  // OpenAI Images Edit accepts multiple via 'image[]' or single 'image'.
  // Single is fine for our use case (one reference KV).
  form.append('image', new Blob([image], { type: mime }), `ref.${ext}`)

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)

  const start = Date.now()
  let resp
  try {
    resp = await fetch(`${baseUrl}/v1/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ctl.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      throw new Error(`editImage: timeout after ${timeoutMs}ms`)
    }
    throw new Error(`editImage: network error: ${err.message}`)
  }
  clearTimeout(timer)

  const elapsedMs = Date.now() - start

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`editImage: HTTP ${resp.status} ${resp.statusText} — ${body.slice(0, 400)}`)
  }

  const json = await resp.json()
  const item = json?.data?.[0]
  if (item?.b64_json) {
    return { buf: Buffer.from(item.b64_json, 'base64'), elapsedMs }
  }
  if (item?.url) {
    const r = await fetch(item.url)
    if (!r.ok) throw new Error(`editImage: download from url failed (${r.status})`)
    return { buf: Buffer.from(await r.arrayBuffer()), elapsedMs }
  }
  throw new Error('editImage: response missing b64_json/url')
}

// ── MIME sniffing ──────────────────────────────────────────

function sniffMime(buf) {
  if (!buf || buf.length < 4) return null
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  // WebP: RIFF .... WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return null
}

function mimeToExt(mime) {
  switch (mime) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    default: return 'png'
  }
}

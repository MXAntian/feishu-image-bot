// ============================================================
// Platform spec resolution + GPT size calculation.
// Ported from image-assets-resize@1.0.0 (OpenClaw / OrangeMoon).
//
// Key changes vs Python source:
// - Brand learning / persistence stripped (bot is one-shot, not multi-session)
// - Custom spec persistence stripped (inline parsing only, no disk save)
// - Scene group expansion kept
// ============================================================

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Spec data ───────────────────────────────────────────────

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'specs-data.json'), 'utf-8'),
)
export const PLATFORM_SPECS = data.PLATFORM_SPECS
export const PLATFORM_ALIASES = data.PLATFORM_ALIASES
export const SCENE_GROUPS = data.SCENE_GROUPS

// ── GPT size calculator ─────────────────────────────────────
//
// gpt-image-2 / Nano Banana require:
//   - Both dimensions multiples of 16
//   - Total pixels ≥ 1,000,000 (1 MP)
// Returns the legal size closest to target, plus the scale factor
// needed to downscale to the exact target after generation.

const MIN_GPT_PIXELS = 1_000_000

/**
 * @param {number} targetW
 * @param {number} targetH
 * @returns {{ size: string, scale: number, w: number, h: number }}
 *   size  — "WxH" string for API
 *   scale — targetW / w (1.0 if no resize needed)
 */
export function calcGptSize(targetW, targetH) {
  const targetPixels = targetW * targetH

  if (targetW % 16 === 0 && targetH % 16 === 0 && targetPixels >= MIN_GPT_PIXELS) {
    return { size: `${targetW}x${targetH}`, scale: 1.0, w: targetW, h: targetH }
  }

  const scaleUp = Math.max(1.0, Math.sqrt(MIN_GPT_PIXELS / targetPixels))
  let w = Math.round((targetW * scaleUp) / 16) * 16
  let h = Math.round((targetH * scaleUp) / 16) * 16

  // Bump up if rounding put us under the floor.
  for (let i = 0; i < 20; i++) {
    if (w * h >= MIN_GPT_PIXELS) break
    w += 16
    h = Math.round((targetH * (w / targetW)) / 16) * 16
  }

  return { size: `${w}x${h}`, scale: targetW / w, w, h }
}

// ── Inline spec parser ──────────────────────────────────────
// Accepts "Name:WxH" e.g. "我的活动:1200x800"

const INLINE_RE = /^([^:]+):(\d+)x(\d+)$/i

export function parseInlineSpec(str) {
  if (!str) return null
  const m = INLINE_RE.exec(str.trim())
  if (!m) return null
  const name = m[1].trim()
  const w = parseInt(m[2], 10)
  const h = parseInt(m[3], 10)
  if (!w || !h) return null
  // Reduce to canonical ratio.
  const g = gcd(w, h)
  return {
    name,
    width: w,
    height: h,
    ratio: `${w / g}:${h / g}`,
    safe_area: { top: 0, bottom: 0, left: 0, right: 0 },
    format: ['png', 'jpeg'],
    max_size_mb: 10,
    note: `自定义规格（${name}）`,
    _inline: true,
  }
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b)
}

// ── Spec lookup ─────────────────────────────────────────────
//
// Resolution order:
//   1. Direct platform key (wechat-cover, douyin-cover, ...)
//   2. Alias lookup (微信封面, 朋友圈, fb, ...)
//   3. Inline format ("我的活动:1200x800")
//   4. null

export function getSpec(key) {
  if (!key) return null
  const k = String(key).trim()

  if (PLATFORM_SPECS[k]) {
    return { ...PLATFORM_SPECS[k], _key: k }
  }
  if (PLATFORM_ALIASES[k]) {
    const real = PLATFORM_ALIASES[k]
    if (PLATFORM_SPECS[real]) return { ...PLATFORM_SPECS[real], _key: real }
  }
  // Case-insensitive alias try.
  const lower = k.toLowerCase()
  for (const [alias, real] of Object.entries(PLATFORM_ALIASES)) {
    if (alias.toLowerCase() === lower && PLATFORM_SPECS[real]) {
      return { ...PLATFORM_SPECS[real], _key: real }
    }
  }
  // Inline.
  const inline = parseInlineSpec(k)
  if (inline) return { ...inline, _key: k }
  return null
}

// ── Multi-key resolver ──────────────────────────────────────
//
// Input: comma-separated keys, e.g.
//   "wechat-cover,douyin-cover"
//   "小红书,B站,我的活动:1200x800"
//   "social-media"   (scene group expands to multiple)
// Output: deduped list of resolved specs.

export function resolveKeys(keysInput) {
  if (!keysInput) return []
  const raw = Array.isArray(keysInput) ? keysInput : String(keysInput).split(',')

  const out = []
  const seen = new Set()
  for (let token of raw) {
    token = String(token || '').trim()
    if (!token) continue

    // Scene group?
    if (SCENE_GROUPS[token]) {
      for (const child of SCENE_GROUPS[token]) {
        if (seen.has(child)) continue
        const sp = getSpec(child)
        if (sp) {
          out.push(sp)
          seen.add(sp._key || child)
        }
      }
      continue
    }
    const sp = getSpec(token)
    if (!sp) continue
    const sk = sp._key || token
    if (seen.has(sk)) continue
    out.push(sp)
    seen.add(sk)
  }
  return out
}

// ── List for help / discovery ───────────────────────────────

export function listPlatforms() {
  return Object.entries(PLATFORM_SPECS).map(([key, s]) => ({
    key,
    name: s.name,
    width: s.width,
    height: s.height,
    ratio: s.ratio,
  }))
}

// ── Filename builder ────────────────────────────────────────
// Format: {scene}_{platform}_{w}x{h}_v{version}.{ext}

export function buildFilename(scene, platformName, width, height, version = 1, ext = 'png') {
  const safeScene = (scene || 'untitled').trim()
    .replace(/\s+/g, '_')
    .replace(/　/g, '')
    .replace(/\//g, '&')
  const safePlatform = (platformName || 'unknown').replace(/\s+/g, '')
  return `${safeScene}_${safePlatform}_${width}x${height}_v${version}.${ext}`
}

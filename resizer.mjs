// ============================================================
// Resizer — 纯像素图像尺寸/比例处理
//
// 用 sharp 做本地 resize / crop / cover / contain，避免烧 GPT Image。
//
// 触发场景：analyzer 判定用户只是要"改尺寸/比例/裁切"，输出 mode='resize'
// + size 参数；bot.mjs 在 outputs 循环里把这些走到本地处理，绕过 painter。
//
// 优势：
//   - 快（毫秒级 vs GPT Image 30s+）
//   - 便宜（不烧 token）
//   - 稳（pixel-perfect 不畸变）
// ============================================================

import sharp from 'sharp'

/**
 * sharp 支持的 fit 模式映射 + 校验
 * - cover    : 等比放大/缩小到完全覆盖目标尺寸，多余裁掉（默认，最直观）
 * - contain  : 等比缩放到完全装入目标尺寸，剩余部分用 background 填充
 * - fill     : 强制拉伸到目标尺寸（会变形，慎用）
 * - inside   : 等比缩放到不超过目标尺寸（最大边匹配，输出可能小于目标）
 * - outside  : 等比缩放到至少覆盖目标尺寸（最小边匹配，输出可能大于目标）
 */
const VALID_FITS = new Set(['cover', 'contain', 'fill', 'inside', 'outside'])

/**
 * 解析 size 参数 → sharp 标准格式
 *
 * 接受的格式：
 *   { width: 1024, height: 1024 }        显式宽高
 *   { width: 1024 }                       只指定宽，高按比例
 *   { height: 1024 }                      只指定高，宽按比例
 *   { ratio: '16:9', longest: 1920 }     按比例 + 最长边
 *   { ratio: '1:1', longest: 1024 }      正方形快捷
 *
 * @returns {{width?: number, height?: number}}
 */
function resolveTargetSize(size, originalWidth, originalHeight) {
  if (!size || typeof size !== 'object') {
    throw new Error('size 参数缺失')
  }

  // 显式 width/height
  if (size.width || size.height) {
    return {
      width: size.width ? clampDim(size.width) : undefined,
      height: size.height ? clampDim(size.height) : undefined,
    }
  }

  // ratio + longest
  if (size.ratio && size.longest) {
    const m = String(size.ratio).match(/^(\d+):(\d+)$/)
    if (!m) throw new Error(`ratio 格式应为 "W:H"，收到 ${size.ratio}`)
    const rw = parseInt(m[1], 10)
    const rh = parseInt(m[2], 10)
    const longest = clampDim(size.longest)
    if (rw >= rh) {
      return { width: longest, height: Math.round(longest * rh / rw) }
    } else {
      return { width: Math.round(longest * rw / rh), height: longest }
    }
  }

  // ratio 没指定 longest → 按原图最长边
  if (size.ratio) {
    const m = String(size.ratio).match(/^(\d+):(\d+)$/)
    if (!m) throw new Error(`ratio 格式应为 "W:H"，收到 ${size.ratio}`)
    const rw = parseInt(m[1], 10)
    const rh = parseInt(m[2], 10)
    const longest = Math.max(originalWidth, originalHeight)
    if (rw >= rh) {
      return { width: longest, height: Math.round(longest * rh / rw) }
    } else {
      return { width: Math.round(longest * rw / rh), height: longest }
    }
  }

  throw new Error('size 必须含 width/height 或 ratio')
}

function clampDim(n) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v) || v <= 0) throw new Error(`非法尺寸: ${n}`)
  // 兜底防爆——飞书图片消息上限 10MB，10K x 10K PNG 估算 100MB+，封顶 4096
  return Math.min(Math.max(v, 8), 4096)
}

/**
 * 对图片 Buffer 做 resize
 *
 * @param {Buffer} imageBuffer - 原图
 * @param {object} opts
 *   - size: {width?, height?, ratio?, longest?} （见 resolveTargetSize）
 *   - fit: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'（默认 'cover'）
 *   - background: '#ffffff' 之类（仅 fit='contain' 时用作填充）
 *   - format: 'png' | 'jpeg' | 'webp'（默认沿用原格式，否则 png）
 * @returns {Promise<{buf: Buffer, info: {width, height, fit, format}}>}
 */
export async function resizeImage(imageBuffer, opts = {}) {
  const fit = opts.fit && VALID_FITS.has(opts.fit) ? opts.fit : 'cover'
  const background = opts.background || '#ffffff'

  const meta = await sharp(imageBuffer).metadata()
  const target = resolveTargetSize(opts.size, meta.width, meta.height)

  // sharp 输出格式：默认沿用原图，no original 才回退 png
  const outFormat = opts.format
    || (meta.format === 'jpeg' ? 'jpeg' : meta.format === 'webp' ? 'webp' : 'png')

  let pipeline = sharp(imageBuffer).resize({
    width: target.width,
    height: target.height,
    fit,
    background,
    withoutEnlargement: false,
  })

  if (outFormat === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: 92 })
  } else if (outFormat === 'webp') {
    pipeline = pipeline.webp({ quality: 92 })
  } else {
    pipeline = pipeline.png({ compressionLevel: 6 })
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
  return {
    buf: data,
    info: { width: info.width, height: info.height, fit, format: outFormat, originalWidth: meta.width, originalHeight: meta.height },
  }
}

/**
 * 给 bot.mjs 用的人类可读描述
 */
export function describeResize(info) {
  return `${info.originalWidth}×${info.originalHeight} → ${info.width}×${info.height} (${info.fit}/${info.format})`
}

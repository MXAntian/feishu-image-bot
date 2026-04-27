// ============================================================
// PNG alpha 通道压平工具
//
// 为啥要这个：GPT Image 2 / DALL-E 系列遇到带透明通道的参考图时，
// 会把透明区识别成"风格化彩色色块"，导致输出背景被填成花花的色块。
// 解决：发给 API 之前先把透明区合成成纯色（默认白）。
// ============================================================

import { PNG } from 'pngjs'

/**
 * 检测一个 PNG buffer 是否有"实质性"的透明像素
 * （PNG 头声明带 alpha 也可能全是 255，那就不需要 flatten）
 *
 * @param {Buffer} buf - PNG 文件 buffer
 * @returns {boolean} true=确实有透明像素
 */
export function pngHasTransparency(buf) {
  if (!buf || buf.length < 8) return false
  // 不是 PNG（magic 不对）→ 直接返回 false
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) return false
  try {
    const png = PNG.sync.read(buf)
    // colorType:
    //   0 = grayscale, 2 = RGB, 3 = palette, 4 = grayscale+alpha, 6 = RGBA
    // pngjs 解出来 data 永远是 4 通道 RGBA（不管原图是不是有 alpha）
    // 所以判断要看 alpha 字节是不是真有 < 255 的
    for (let i = 3; i < png.data.length; i += 4) {
      if (png.data[i] < 255) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 把 PNG buffer 的透明区合成到纯色背景上
 * 主体（alpha>0 的像素）保持视觉一致，alpha 全部置 255
 *
 * @param {Buffer} buf - 原 PNG buffer
 * @param {object} opts - { bg: '#RRGGBB' } 默认白色
 * @returns {Buffer} 压平后的 PNG buffer（不再有 alpha < 255）
 */
export function flattenPngAlpha(buf, opts = {}) {
  const bg = parseHexColor(opts.bg || '#ffffff')
  const png = PNG.sync.read(buf)

  for (let i = 0; i < png.data.length; i += 4) {
    const a = png.data[i + 3] / 255
    if (a >= 1) continue  // 完全不透明，不处理
    // alpha blending: out = fg * a + bg * (1 - a)
    png.data[i]     = Math.round(png.data[i]     * a + bg.r * (1 - a))
    png.data[i + 1] = Math.round(png.data[i + 1] * a + bg.g * (1 - a))
    png.data[i + 2] = Math.round(png.data[i + 2] * a + bg.b * (1 - a))
    png.data[i + 3] = 255
  }

  // 重新输出（注意 colorType: 6 = RGBA；写出去仍然是 PNG）
  return PNG.sync.write(png)
}

/**
 * 综合方法：检测 + flatten。
 * 没透明就原样返回，有透明就压平。返回 { buf, flattened: boolean }
 */
export function maybeFlattenAlpha(buf, opts = {}) {
  if (!pngHasTransparency(buf)) {
    return { buf, flattened: false }
  }
  return { buf: flattenPngAlpha(buf, opts), flattened: true }
}

/**
 * '#RRGGBB' / '#RGB' → { r, g, b }
 */
function parseHexColor(hex) {
  let s = String(hex || '#ffffff').trim().replace(/^#/, '')
  if (s.length === 3) s = s.split('').map(c => c + c).join('')
  if (s.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(s)) {
    return { r: 255, g: 255, b: 255 }
  }
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  }
}

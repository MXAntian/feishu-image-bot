// ============================================================
// Edit prompt construction.
// Ported from image-assets-resize@1.0.0 (build_edit_prompt /
// build_generate_prompt in generate_image.py).
// ============================================================

// Triggering 'clean' mode (strip text/logo) when extra prompt
// contains any of these keywords.
const CLEAN_KEYWORDS = [
  '不要logo', '不要带logo', '去掉logo', '去除logo', '无logo',
  '不要文案', '不要文字', '去掉文字', '去除文字', '无文字',
  '不要装饰', '去掉装饰', '纯净', '简洁', '干净', '净版', 'clean',
]

function isCleanRequest(extra) {
  if (!extra) return false
  const lower = String(extra).toLowerCase()
  return CLEAN_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))
}

/**
 * Edit-mode prompt: a reference image is supplied, model adapts it
 * to the target platform spec while preserving (or stripping) elements.
 */
export function buildEditPrompt({ platformName, width, height, scene = '', extra = '', safeNote = '' }) {
  const clean = isCleanRequest(extra)

  let prompt = clean
    ? (
        `以这张参考图为基准，适配生成一张【${platformName}】，尺寸${width}x${height}。` +
        `仅保留角色和背景场景，去除所有文字、LOGO、图标和装饰元素，保持画面干净简洁。`
      )
    : (
        `以这张参考图为基准，适配生成一张【${platformName}】，尺寸${width}x${height}。` +
        `严格保留原图所有视觉元素：角色、背景、所有文字、图标和装饰——一个都不能少。` +
        `仅调整元素位置来适配新比例，延伸的区域用背景纹理填充即可，不要添加任何新内容。`
      )

  if (scene) prompt += ` 场景：${scene}。`
  if (safeNote) prompt += ` 安全区提示：${safeNote}。`
  if (extra) prompt += ` 额外要求：${extra}`
  return prompt
}

/**
 * Text-to-image prompt (no reference image).
 */
export function buildGeneratePrompt({ platformName, width, height, scene = '', brand = '', styleHint = '' }) {
  const parts = [`生成一张【${platformName}】营销图片，尺寸${width}x${height}`]
  if (scene) parts.push(`，场景主题：${scene}`)
  if (brand) parts.push(`，品牌：${brand}`)
  if (styleHint) parts.push(`，风格：${styleHint}`)
  return parts.join('。')
}

export { isCleanRequest, CLEAN_KEYWORDS }

// ============================================================
// image-assets-resize main pipeline (JS port).
//
// Per platform:
//   1. resolve spec (incl. aliases / inline / scene group)
//   2. calc legal GPT size (16-mult + ≥1MP)
//   3. build edit prompt
//   4. call OpenAI Images Edit
//   5. sharp resize to exact target size if needed
//   6. optional GPT-4o vision self-check
//
// Returns Buffers in-memory; the caller (bot.mjs) uploads to
// Feishu and does not persist to disk.
// ============================================================

import sharp from 'sharp'

import { resolveKeys, calcGptSize } from './specs.mjs'
import { buildEditPrompt, buildGeneratePrompt } from './prompts.mjs'
import { editImage } from './assets-painter.mjs'
import { verifyImage } from './verify.mjs'

/**
 * @typedef {object} AssetResult
 * @property {string}  platform       Resolved platform key
 * @property {string}  name           Human-readable platform name
 * @property {number}  width
 * @property {number}  height
 * @property {boolean} success
 * @property {Buffer}  [buf]          Final image buffer (PNG)
 * @property {string}  [error]
 * @property {number}  [elapsedMs]
 * @property {string}  prompt         The edit prompt used (for log/replay)
 * @property {string}  gptSize        The GPT-side size requested
 * @property {boolean} [resized]      Whether sharp resize was applied
 * @property {boolean} [verifyPassed] Set if verify=true
 * @property {string[]}[verifyIssues]
 */

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.baseUrl]
 * @param {Buffer} [opts.refImage]      Reference image (required for edit mode)
 * @param {string|string[]} opts.platforms  Comma-separated keys or array
 * @param {string} [opts.scene='']
 * @param {string} [opts.extraPrompt='']
 * @param {string} [opts.quality='medium']
 * @param {boolean}[opts.verify=false]
 * @param {string} [opts.model]
 * @param {function(string):void} [opts.log]   per-step progress logger
 * @returns {Promise<{ ok: number, total: number, results: AssetResult[] }>}
 */
export async function generateAssets(opts) {
  const {
    apiKey,
    baseUrl,
    refImage,
    platforms,
    scene = '',
    extraPrompt = '',
    quality = 'medium',
    verify = false,
    model,
    log = () => {},
  } = opts

  if (!apiKey) throw new Error('generateAssets: apiKey required')

  const specs = resolveKeys(platforms)
  if (specs.length === 0) {
    throw new Error(`generateAssets: no valid platform resolved from ${JSON.stringify(platforms)}`)
  }

  const results = []
  for (const spec of specs) {
    const platformKey = spec._key
    const platformName = spec.name
    const tw = spec.width
    const th = spec.height
    const safeNote = spec.safe_note || ''

    const { size: gptSize, scale, w: gptW, h: gptH } = calcGptSize(tw, th)

    const prompt = refImage
      ? buildEditPrompt({ platformName, width: tw, height: th, scene, extra: extraPrompt, safeNote })
      : buildGeneratePrompt({ platformName, width: tw, height: th, scene })

    const result = {
      platform: platformKey,
      name: platformName,
      width: tw,
      height: th,
      success: false,
      prompt,
      gptSize,
    }

    log(`🎨 [${platformKey}] ${platformName} ${tw}×${th} (gpt ${gptSize}, scale ${scale.toFixed(2)})`)

    if (!refImage) {
      // Pure generation (no ref image) — currently not used by bot but
      // implemented for completeness/parity with Python source.
      result.error = 'text-to-image mode not wired yet (need refImage)'
      results.push(result)
      continue
    }

    try {
      const t0 = Date.now()
      const { buf: gptBuf, elapsedMs } = await editImage({
        apiKey,
        baseUrl,
        image: refImage,
        prompt,
        size: gptSize,
        quality,
        model,
      })
      log(`   ↳ edit done in ${elapsedMs}ms`)

      let finalBuf = gptBuf
      if (scale !== 1.0) {
        finalBuf = await sharp(gptBuf)
          .resize(tw, th, { fit: 'cover', position: 'center' })
          .png()
          .toBuffer()
        result.resized = true
        log(`   ↳ sharp resize ${gptW}x${gptH} → ${tw}x${th}`)
      }

      result.buf = finalBuf
      result.elapsedMs = Date.now() - t0
      result.success = true

      if (verify) {
        log(`   ↳ AI self-check...`)
        const v = await verifyImage(finalBuf, { apiKey, baseUrl })
        result.verifyPassed = v.passed
        result.verifyIssues = v.issues
        log(`   ↳ verify ${v.passed ? '✓ pass' : '⚠ ' + v.issues.slice(0, 2).join(' | ')}`)
      }
    } catch (err) {
      result.error = err.message
      log(`   ↳ ✗ ${err.message}`)
    }

    results.push(result)
  }

  const ok = results.filter((r) => r.success).length
  return { ok, total: results.length, results }
}

// Re-export for convenience.
export { resolveKeys, calcGptSize, listPlatforms } from './specs.mjs'

// ============================================================
// 生图层 — Codex CLI 方式（走 ChatGPT/Plus 订阅）
//
// 原理：codex exec --enable image_generation → rollout jsonl → 提取 base64 图片
// ============================================================

import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { writeFileSync, unlinkSync } from 'node:fs'

const IMAGE_MAGIC = {
  'iVBORw0KGgo': 'png',
  '/9j/': 'jpg',
  'UklGR': 'webp',
}

const BASE64_BLOB_RE = /"([A-Za-z0-9+/=]{200,})"/g

/**
 * 通过 Codex CLI 生成图片
 * @param {string} _apiKey - 不使用（codex 走自己的 auth）
 * @param {object} analysis - analyzeRequest 的返回值
 * @param {Buffer[]} refImages - 参考图 Buffer 列表
 * @param {object} options - { timeoutSec }
 * @returns {Promise<Buffer>} 生成的图片 Buffer
 */
export async function generateImage(_apiKey, analysis, refImages = [], options = {}) {
  const timeoutSec = options.timeoutSec || 300

  // 找 codex
  const codexExe = resolveCodex()

  // sessions 目录快照（用于找新文件）
  const sessionsRoot = resolveSessionsRoot()
  mkdirSync(sessionsRoot, { recursive: true })
  const beforeFiles = listRollouts(sessionsRoot)

  // 构造指令
  const instruction = buildInstruction(analysis.prompt, refImages)

  // 写参考图到临时文件
  const tmpRefs = []
  for (let i = 0; i < refImages.length; i++) {
    const p = join(tmpdir(), `codex_ref_${Date.now()}_${i}.png`)
    writeFileSync(p, refImages[i])
    tmpRefs.push(p)
  }

  try {
    // 跑 codex exec
    await runCodex(codexExe, instruction, tmpRefs, timeoutSec)
  } finally {
    // 清理临时文件
    for (const p of tmpRefs) {
      try { unlinkSync(p) } catch {}
    }
  }

  // 等 2s 让文件落盘
  await new Promise(r => setTimeout(r, 2000))

  // 找新的 rollout 文件
  const afterFiles = listRollouts(sessionsRoot)
  const newFiles = afterFiles.filter(f => !beforeFiles.has(f))

  if (newFiles.length === 0) {
    throw new Error('Codex 没有产生新的 rollout 文件，生图可能失败')
  }

  // 从新文件里提取最大的图片 base64
  const result = extractBestImage(newFiles)
  if (!result) {
    throw new Error('Codex rollout 文件中没有找到图片数据')
  }

  return result
}

function resolveCodex() {
  // Windows: 优先找 npm global
  const appdata = process.env.APPDATA
  if (appdata) {
    for (const name of ['codex.cmd', 'codex.exe', 'codex']) {
      const p = join(appdata, 'npm', name)
      try { statSync(p); return p } catch {}
    }
  }
  // fallback: 期望在 PATH 里
  return 'codex'
}

function resolveSessionsRoot() {
  const codexHome = process.env.CODEX_HOME
  if (codexHome) return resolve(codexHome, 'sessions')
  return join(homedir(), '.codex', 'sessions')
}

function listRollouts(root) {
  const result = new Set()
  try {
    walk(root, result)
  } catch {}
  return result
}

function walk(dir, result) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, result)
    } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      result.add(full)
    }
  }
}

function buildInstruction(prompt, refImages) {
  let inst = 'Use the imagegen tool to generate the image for the following request.'
  if (refImages.length > 0) {
    inst += ' Use the attached image(s) as visual reference / input for image-to-image.'
  }
  inst += '\nRequirements: generate the image directly, return only the image, no explanation.\n\nRequest:\n'
  inst += prompt
  return inst
}

function runCodex(codexExe, instruction, refPaths, timeoutSec) {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--color', 'never',
      '--enable', 'image_generation',
    ]
    for (const ref of refPaths) {
      args.push('-i', ref)
    }

    const proc = execFile(codexExe, args, {
      timeout: timeoutSec * 1000,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      shell: true,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Codex 执行失败: ${err.message}\n${stderr?.slice(-500) || ''}`))
      } else {
        resolve({ stdout, stderr })
      }
    })

    // 通过 stdin 传入指令
    proc.stdin.write(instruction)
    proc.stdin.end()
  })
}

function extractBestImage(filePaths) {
  let best = null
  let bestSize = 0

  for (const fp of filePaths) {
    let text
    try { text = readFileSync(fp, 'utf-8') } catch { continue }

    for (const line of text.split('\n')) {
      let match
      BASE64_BLOB_RE.lastIndex = 0
      while ((match = BASE64_BLOB_RE.exec(line)) !== null) {
        const blob = match[1]
        // 检查是否是图片 magic
        for (const [magic] of Object.entries(IMAGE_MAGIC)) {
          if (blob.startsWith(magic) && blob.length > bestSize) {
            bestSize = blob.length
            best = blob
          }
        }
      }
    }
  }

  if (!best) return null
  return Buffer.from(best, 'base64')
}

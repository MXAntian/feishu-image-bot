// ============================================================
// GPT 推理层 — Codex CLI 方式（走 ChatGPT/Plus 订阅）
//
// v2: 复用 analyzer.mjs 的 buildSystemPrompt + normalizeAnalysis，
//     skills 注入和输出 schema 跟 API 模式一致。
// ============================================================

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { statSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildSystemPrompt, normalizeAnalysis, buildFlattenNotice } from './analyzer.mjs'

/**
 * 通过 Codex CLI 推理分析用户需求
 * @param {string} _apiKey - 不使用（codex 走自己的 auth）
 * @param {string} userText - 用户的文字需求
 * @param {string[]} imageBase64List - 用户附带的图片（base64）
 * @param {object} options - { timeoutSec, refsFlattened, flattenBg }
 */
export async function analyzeRequest(_apiKey, userText, imageBase64List = [], options = {}) {
  const timeoutSec = options.timeoutSec || 180  // skill 加大后 system prompt 更长，给 3min
  const codexExe = resolveCodex()

  // 构造 instruction：system prompt + 用户需求 + flatten notice
  let instruction = buildSystemPrompt() + '\n\n---\n\n用户需求：\n'
  instruction += userText || '请根据附图生成类似风格的图片'
  instruction += buildFlattenNotice(options.refsFlattened, options.flattenBg)

  if (imageBase64List.length > 0) {
    instruction += `\n\n（用户附带了 ${imageBase64List.length} 张参考图片）`
  }

  instruction += '\n\n请按上方约束直接输出 JSON：'

  // 写参考图到临时文件（codex -i 支持图片输入）
  const tmpRefs = []
  for (let i = 0; i < imageBase64List.length; i++) {
    const p = join(tmpdir(), `codex_analyze_ref_${Date.now()}_${i}.png`)
    writeFileSync(p, Buffer.from(imageBase64List[i], 'base64'))
    tmpRefs.push(p)
  }

  let stdout
  try {
    const result = await runCodex(codexExe, instruction, tmpRefs, timeoutSec)
    stdout = result.stdout
  } finally {
    for (const p of tmpRefs) {
      try { unlinkSync(p) } catch {}
    }
  }

  // 提取 JSON
  const raw = stdout.trim()
  let parsed
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
  } catch (e) {
    throw new Error(`Codex 推理返回解析失败: ${raw.slice(0, 300)}`)
  }

  return normalizeAnalysis(parsed)
}

function resolveCodex() {
  const appdata = process.env.APPDATA
  if (appdata) {
    for (const name of ['codex.cmd', 'codex.exe', 'codex']) {
      const p = join(appdata, 'npm', name)
      try { statSync(p); return p } catch {}
    }
  }
  return 'codex'
}

function runCodex(codexExe, instruction, refPaths, timeoutSec) {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--color', 'never',
    ]
    for (const ref of refPaths) {
      args.push('-i', ref)
    }

    // v2.1 修 DEP0190：Node 22+ 不让 args 数组 + shell:true 共存（args 不会被 shell 转义）。
    // Windows 调 .cmd / .bat 显式走 cmd.exe /c，shell:false，args 安全传递。
    const isWindowsCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexExe)
    const exe = isWindowsCmd ? 'cmd.exe' : codexExe
    const finalArgs = isWindowsCmd ? ['/c', codexExe, ...args] : args

    const proc = execFile(exe, finalArgs, {
      timeout: timeoutSec * 1000,
      encoding: 'utf-8',
      errors: 'replace',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Codex 推理执行失败: ${err.message}\n${stderr?.slice(-300) || ''}`))
      } else {
        resolve({ stdout, stderr })
      }
    })

    proc.stdin.write(instruction)
    proc.stdin.end()
  })
}

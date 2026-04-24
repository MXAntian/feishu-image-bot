// ============================================================
// GPT 推理层 — Codex CLI 方式（走 ChatGPT/Plus 订阅）
//
// 通过 codex exec 跑 chat 推理，不需要 API key
// ============================================================

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { writeFileSync, unlinkSync } from 'node:fs'

const SYSTEM_PROMPT = `你是一个专业的AI生图提示词优化师。
用户会给你一段生图需求（可能附带参考图片），你需要：

1. 理解用户的真实意图
2. 生成一段优化后的提示词，用于 GPT Image 2.0 生图
3. 判断这是"文生图"还是"图生图"任务

输出格式（严格JSON，不要用 markdown 包裹）：
{
  "mode": "text2img" | "img2img",
  "prompt": "优化后的生图提示词",
  "negative_prompt": "负面提示词（可选，如果需要）",
  "summary": "一句话中文总结你理解的需求"
}

注意：
- 提示词语言自行判断：如果需求涉及中文文字渲染/中文场景，用中文提示词；其他情况英文效果更好
- 如果用户提供了参考图，mode 应为 img2img
- 提示词要具体、有画面感，包含风格/构图/光影等细节
- 不要解释，直接输出 JSON`

/**
 * 通过 Codex CLI 推理分析用户需求
 * @param {string} _apiKey - 不使用
 * @param {string} userText - 用户的文字需求
 * @param {string[]} imageBase64List - 用户附带的图片（base64 编码）
 * @param {object} options - { timeoutSec }
 */
export async function analyzeRequest(_apiKey, userText, imageBase64List = [], options = {}) {
  const timeoutSec = options.timeoutSec || 120
  const codexExe = resolveCodex()

  // 构造 instruction
  let instruction = SYSTEM_PROMPT + '\n\n---\n\n用户需求：\n'
  instruction += userText || '请根据附图生成类似风格的图片'

  if (imageBase64List.length > 0) {
    instruction += `\n\n（用户附带了 ${imageBase64List.length} 张参考图片）`
  }

  instruction += '\n\n请直接输出 JSON：'

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

  // 从 stdout 提取 JSON
  const raw = stdout.trim()
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    return JSON.parse(jsonMatch ? jsonMatch[0] : raw)
  } catch (e) {
    throw new Error(`Codex 推理返回解析失败: ${raw.slice(0, 300)}`)
  }
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

    const proc = execFile(codexExe, args, {
      timeout: timeoutSec * 1000,
      encoding: 'utf-8',
      errors: 'replace',
      maxBuffer: 10 * 1024 * 1024,
      shell: true,
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

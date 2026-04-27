// ============================================================
// Skills 加载器 — Anthropic Skill 标准格式
//
// 目录结构：
//   skills/
//     <skill-name>/
//       SKILL.md   ← YAML frontmatter (name + description) + Markdown body
//
// 启动加载 + fs.watch 热加载（改 skill 文件不用重启 bot）
// ============================================================

import { readFileSync, readdirSync, statSync, existsSync, watch } from 'node:fs'
import { join } from 'node:path'

let _skills = new Map()       // name -> { name, description, body, path }
let _skillsDir = null
let _log = console.log
let _watcherStarted = false
let _reloadTimer = null

/**
 * 解析单个 SKILL.md
 * 返回 { name, description, body } 或 null（格式不对）
 */
function parseSkillFile(text) {
  // YAML frontmatter: --- ... ---
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return null
  const fm = m[1]
  const body = m[2].trim()

  // 简易 YAML（只取 key: value 单行）
  const name = (fm.match(/^name:\s*(.+?)\s*$/m) || [])[1]
  const description = (fm.match(/^description:\s*(.+?)\s*$/m) || [])[1]
  if (!name) return null
  return { name: name.trim(), description: (description || '').trim(), body }
}

/**
 * 扫描 skills 目录，加载所有有效 SKILL.md
 */
function scanSkills(dir) {
  const map = new Map()
  if (!existsSync(dir)) return map
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillPath = join(dir, entry.name, 'SKILL.md')
    if (!existsSync(skillPath)) continue
    try {
      const text = readFileSync(skillPath, 'utf-8')
      const parsed = parseSkillFile(text)
      if (!parsed) {
        _log(`⚠️  Skill 解析失败（缺 YAML frontmatter 或 name 字段）: ${skillPath}`)
        continue
      }
      map.set(parsed.name, { ...parsed, path: skillPath })
    } catch (e) {
      _log(`⚠️  Skill 读取失败 ${skillPath}: ${e.message}`)
    }
  }
  return map
}

/**
 * 初始化：加载 + 启动 watcher
 * @param {object} opts - { dir, log }
 */
export function initSkills(opts = {}) {
  _skillsDir = opts.dir
  if (opts.log) _log = opts.log

  _skills = scanSkills(_skillsDir)
  _log(`📚 Loaded ${_skills.size} skill(s): ${[..._skills.keys()].join(', ') || '(none)'}`)

  if (_watcherStarted || !existsSync(_skillsDir)) return
  try {
    // Windows / macOS 支持 recursive；Linux 不支持但 watcher 会 fallback 到顶层
    watch(_skillsDir, { recursive: true }, () => {
      // debounce 300ms 防止单次保存触发多次 reload
      if (_reloadTimer) clearTimeout(_reloadTimer)
      _reloadTimer = setTimeout(() => {
        _reloadTimer = null
        const next = scanSkills(_skillsDir)
        const oldNames = [..._skills.keys()].sort().join(',')
        const newNames = [...next.keys()].sort().join(',')
        _skills = next
        if (oldNames !== newNames) {
          _log(`📚 Reloaded ${_skills.size} skill(s): ${[..._skills.keys()].join(', ') || '(none)'}`)
        } else {
          _log(`📚 Reloaded ${_skills.size} skill(s) (content updated)`)
        }
      }, 300)
    })
    _watcherStarted = true
  } catch (e) {
    _log(`⚠️  Skill watcher 启动失败（不致命，热加载不可用）: ${e.message}`)
  }
}

/**
 * 拼装注入到 analyzer system prompt 的 skills 块
 * 没有任何 skill 时返回空字符串
 */
export function getSkillsPromptBlock() {
  if (_skills.size === 0) return ''
  const parts = []
  parts.push('---')
  parts.push('')
  parts.push('# 已加载 Skills（请在生成提示词时严格遵循下述每条 skill 的约束与模板）')
  parts.push('')
  for (const s of _skills.values()) {
    parts.push(`## Skill: ${s.name}`)
    if (s.description) parts.push(`> ${s.description}`)
    parts.push('')
    parts.push(s.body)
    parts.push('')
  }
  return parts.join('\n')
}

/**
 * 列出当前已加载的 skill 摘要（用于启动日志 / 调试）
 */
export function listSkills() {
  return [..._skills.values()].map(s => ({ name: s.name, description: s.description, path: s.path }))
}

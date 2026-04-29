// ============================================================
// 轻量级 session 管理 — per (chat_id, sender_id) 上下文
//
// 用途：让同事在同一个对话窗口可以连续迭代图片，
//       第二次说"再黑一点 / 改成竖版 / 加个翅膀"时
//       bot 知道是基于上一轮的输出在调整，不当成全新需求。
//
// 设计要点：
//   - key = `${chat_id}:${sender_id}` —— 群里多人独立隔离
//   - TTL = 默认 15 分钟，每次访问刷新（活跃就续命）
//   - LRU 上限 200 个 session 防内存泄漏
//   - 历史窗口 3 轮喂给 LLM，再多 prompt 容易爆
//   - lastImage 缓存上一轮**生成的图**（不是用户传的原图），
//     用户没传新图时自动作为参考图，实现"基于上一版改"
// ============================================================

const DEFAULT_TTL_MS = 15 * 60 * 1000  // 15 分钟
const DEFAULT_MAX_SESSIONS = 200
const HISTORY_WINDOW = 3                 // 喂给 analyzer 的最近 N 轮

const RESET_KEYWORDS = [
  '/new', '/reset', '/clear',
  '新主题', '新话题', '重新开始', '重来', '重置上下文',
]

/**
 * 单个 session 的形状：
 * {
 *   key,
 *   createdAt,
 *   lastUpdated,
 *   turns: [
 *     { userText, summary, lastPromptHint, mode, ts }
 *   ],
 *   lastImage: Buffer | null,   // 上一轮生成的图（不传给 LLM，作为下一轮 ref）
 *   lastImageMime: 'image/png',
 * }
 */

export class SessionManager {
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs || DEFAULT_TTL_MS
    this.maxSessions = opts.maxSessions || DEFAULT_MAX_SESSIONS
    this.historyWindow = opts.historyWindow || HISTORY_WINDOW
    this.log = opts.log || (() => {})
    /** @type {Map<string, object>} */
    this._store = new Map()
    this._sweepTimer = null
  }

  static makeKey(chatId, senderId) {
    return `${chatId || 'unknown'}:${senderId || 'unknown'}`
  }

  /**
   * 拿 session（不存在则新建）。访问即续命。
   */
  touch(key) {
    let s = this._store.get(key)
    const now = Date.now()
    if (!s) {
      s = {
        key,
        createdAt: now,
        lastUpdated: now,
        turns: [],
        lastImage: null,
        lastImageMime: null,
      }
      this._store.set(key, s)
      this._enforceLRU()
      this.log(`🆕 session created: ${key} (total=${this._store.size})`)
    } else {
      s.lastUpdated = now
      // 移到 Map 末尾让它成为最新的（Map 迭代顺序保证 LRU）
      this._store.delete(key)
      this._store.set(key, s)
    }
    return s
  }

  /**
   * 只查不创建（用于"用户没说话之前看历史"，避免空 session 占位）
   */
  peek(key) {
    return this._store.get(key) || null
  }

  /**
   * 写入一轮。turn = { userText, summary, lastPromptHint, mode }
   */
  pushTurn(key, turn) {
    const s = this.touch(key)
    s.turns.push({
      userText: (turn.userText || '').slice(0, 500),
      summary: (turn.summary || '').slice(0, 300),
      lastPromptHint: (turn.lastPromptHint || '').slice(0, 600),
      mode: turn.mode || 'text2img',
      ts: Date.now(),
    })
    // 只留最近 (historyWindow * 2) 轮，避免 turns 数组膨胀
    if (s.turns.length > this.historyWindow * 2) {
      s.turns = s.turns.slice(-this.historyWindow * 2)
    }
  }

  /**
   * 缓存上一轮生成的图。下次同 key 用户没传图时会自动作为 ref。
   */
  setLastImage(key, buf, mime = 'image/png') {
    const s = this.touch(key)
    s.lastImage = buf || null
    s.lastImageMime = mime
  }

  /**
   * 拿最近 N 轮历史（给 analyzer 用）
   * 返回适合塞进 system prompt 的纯文本块（不含图）
   */
  getHistoryBlock(key) {
    const s = this._store.get(key)
    if (!s || s.turns.length === 0) return ''
    const recent = s.turns.slice(-this.historyWindow)
    const lines = ['', '---', '', '# 最近的对话历史（仅供上下文参考，不要直接复用）', '']
    recent.forEach((t, i) => {
      lines.push(`## 第 ${i + 1} 轮（${formatAgo(t.ts)}）`)
      lines.push(`- 用户说：${t.userText || '(只发了图)'}`)
      lines.push(`- 你理解为：${t.summary || '(无)'}`)
      if (t.lastPromptHint) lines.push(`- 上次给生图模型的提示词大致是：${t.lastPromptHint}`)
      lines.push(`- 模式：${t.mode}`)
      lines.push('')
    })
    lines.push('如果当前用户消息明显是在**延续上面的迭代**（如"再 / 再XX一点 / 那个 / 这个 / 上一张 / 刚才那个"），请基于上文理解；')
    lines.push('如果是**全新需求**，忽略上面历史，按新需求处理。')
    lines.push('')
    return lines.join('\n')
  }

  /**
   * 清掉某个 session（重置关键词触发）
   */
  clear(key) {
    const had = this._store.has(key)
    this._store.delete(key)
    if (had) this.log(`🧹 session cleared: ${key}`)
    return had
  }

  /**
   * 检查是不是重置关键词。是 → 清完返回 true，bot 应回"已重置"提示。
   */
  detectReset(text) {
    if (!text) return false
    const t = text.trim().toLowerCase()
    return RESET_KEYWORDS.some(k => t === k.toLowerCase() || t.startsWith(k.toLowerCase() + ' '))
  }

  /**
   * 扫描清理过期 session
   */
  sweepExpired() {
    const now = Date.now()
    let removed = 0
    for (const [key, s] of this._store.entries()) {
      if (now - s.lastUpdated > this.ttlMs) {
        this._store.delete(key)
        removed++
      }
    }
    if (removed > 0) this.log(`⏰ session sweep: 清理 ${removed} 个过期 session, 剩 ${this._store.size}`)
    return removed
  }

  /**
   * 启动定时清理（每 60s 一次）
   */
  startSweeper(intervalMs = 60_000) {
    if (this._sweepTimer) return
    this._sweepTimer = setInterval(() => this.sweepExpired(), intervalMs)
    if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref()
  }

  stopSweeper() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer)
      this._sweepTimer = null
    }
  }

  /**
   * 强制 LRU 淘汰
   * Map 的 insertion order 就是访问顺序（touch 时会 delete + set）
   * 满了就从头部（最老）开始删
   */
  _enforceLRU() {
    while (this._store.size > this.maxSessions) {
      const oldestKey = this._store.keys().next().value
      this._store.delete(oldestKey)
      this.log(`📦 LRU 淘汰最老 session: ${oldestKey}`)
    }
  }

  size() {
    return this._store.size
  }
}

function formatAgo(ts) {
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.round(diff / 1000)}s 前`
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}min 前`
  return `${Math.round(diff / 3600_000)}h 前`
}

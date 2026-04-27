#!/usr/bin/env node
// ============================================================
// 太空杀飞书生图机器人 — 主入口
//
// 流程：
//   飞书群 @机器人 → 解析文字+图片 → GPT推理生成prompt
//   → GPT Image 2.0 / Seedream 生图 → 发图回群
//
// 使用：
//   node bot.mjs                # 启动（默认 codex，走 ChatGPT 订阅）
//   node bot.mjs --openai       # 走 OpenAI API
//   node bot.mjs --ark          # 测试模式（火山方舟）
//   node bot.mjs --verbose      # 详细日志
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as lark from '@larksuiteoapi/node-sdk'
import { initFeishu, sendText, sendImage, uploadImage, downloadImage, getBotInfo } from './feishu.mjs'
import { analyzeRequest as analyzeRequestAPI } from './analyzer.mjs'
import { analyzeRequest as analyzeRequestCodex } from './analyzer-codex.mjs'
import { generateImage as generateImageAPI } from './painter.mjs'
import { generateImage as generateImageCodex } from './painter-codex.mjs'
import { initSkills, listSkills } from './skills.mjs'
import { maybeFlattenAlpha } from './flatten-alpha.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── 加载 .env.local ────────────────────────────────────────
const envPath = resolve(__dirname, '.env.local')
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf-8').replace(/^\uFEFF/, '').split('\n').forEach(line => {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  })
}

// ── CLI 参数 ────────────────────────────────────────────────
const argv = process.argv.slice(2)
const VERBOSE = argv.includes('--verbose')
const USE_ARK = argv.includes('--ark')
const USE_OPENAI = argv.includes('--openai')
const PROVIDER = USE_ARK ? 'ark' : USE_OPENAI ? 'openai' : 'codex'

// ── 配置 ────────────────────────────────────────────────────
const LARK_APP_ID = process.env.LARK_APP_ID
const LARK_APP_SECRET = process.env.LARK_APP_SECRET
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const ARK_API_KEY = process.env.ARK_API_KEY
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com'

if (!LARK_APP_ID || !LARK_APP_SECRET) {
  console.error('❌ 缺少 LARK_APP_ID / LARK_APP_SECRET')
  process.exit(1)
}

const apiKey = USE_ARK ? ARK_API_KEY : OPENAI_API_KEY
if (PROVIDER !== 'codex' && !apiKey) {
  console.error(`❌ 缺少 ${USE_ARK ? 'ARK_API_KEY' : 'OPENAI_API_KEY'}`)
  process.exit(1)
}

const creds = initFeishu(LARK_APP_ID, LARK_APP_SECRET)

// 机器人自身 open_id —— 启动时通过 /bot/v3/info 拉取并缓存，用于识别"是否被 @ 到"
let BOT_OPEN_ID = null

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

// ── 消息去重 ────────────────────────────────────────────────
const processedMsgIds = new Set()
const MSG_DEDUP_MAX = 1000

function isDuplicate(msgId) {
  if (processedMsgIds.has(msgId)) return true
  processedMsgIds.add(msgId)
  if (processedMsgIds.size > MSG_DEDUP_MAX) {
    const first = processedMsgIds.values().next().value
    processedMsgIds.delete(first)
  }
  return false
}

// ── 任务队列 ────────────────────────────────────────────────
const taskQueue = []
let activeTask = null

function getQueuePosition(msgId) {
  const idx = taskQueue.findIndex(t => t.msgId === msgId)
  return idx === -1 ? -1 : idx + 1
}

function getQueueLength() {
  return taskQueue.length + (activeTask ? 1 : 0)
}

async function enqueueTask(event) {
  const msg = event?.message
  if (!msg) return

  const msgId = msg.message_id
  const chatId = msg.chat_id

  if (isDuplicate(msgId)) return

  // @ 触发判定：
  //   - p2p（私聊）→ 直通，私聊本来就是定向给机器人
  //   - group（群聊）→ 必须 mentions 里有一项 id.open_id === BOT_OPEN_ID 才响应
  //                    @所有人（@_all）不会带具体 open_id，自动被屏蔽
  //   - 其他 chat_type 一律忽略
  if (msg.chat_type === 'p2p') {
    // ok, 直通
  } else if (msg.chat_type === 'group') {
    if (!BOT_OPEN_ID) {
      log(`⚠️  群消息但未知机器人 open_id，跳过（启动时 getBotInfo 可能失败了）`)
      return
    }
    const mentions = Array.isArray(msg.mentions) ? msg.mentions : []
    const mentionedMe = mentions.some(m => m?.id?.open_id === BOT_OPEN_ID)
    if (!mentionedMe) {
      const keys = mentions.map(m => m?.key || '?').join(',') || 'none'
      log(`⏭️  群消息未 @ 机器人，忽略 (mentions=[${keys}])`)
      return
    }
  } else {
    return
  }

  const queueLen = getQueueLength()
  if (queueLen > 0) {
    await sendText(creds, chatId, `📋 收到！前面还有 ${queueLen} 个任务在排队，请稍等~`)
  }

  taskQueue.push({ event, msgId, chatId })
  processQueue()
}

async function processQueue() {
  if (activeTask || taskQueue.length === 0) return

  const task = taskQueue.shift()
  activeTask = task
  try {
    await handleMessage(task.event)
  } finally {
    activeTask = null
    processQueue()
  }
}

// ── 处理单条消息 ────────────────────────────────────────────
async function handleMessage(event) {
  const msg = event?.message
  if (!msg) return

  const msgId = msg.message_id
  const chatId = msg.chat_id
  const msgType = msg.message_type
  const senderId = event.sender?.sender_id?.open_id

  log(`📨 处理消息 type=${msgType} from=${senderId} chat=${chatId}`)

  try {
    // 1. 提取文字内容
    let userText = ''
    if (msgType === 'text') {
      const content = JSON.parse(msg.content || '{}')
      userText = content.text || ''
      // 去掉 @机器人 的部分
      userText = userText.replace(/@_user_\d+/g, '').trim()
    } else if (msgType === 'post') {
      // 富文本消息，提取纯文本
      const content = JSON.parse(msg.content || '{}')
      const paragraphs = content.content || content.zh_cn?.content || []
      for (const para of paragraphs) {
        for (const elem of (para || [])) {
          if (elem.tag === 'text') userText += elem.text
        }
      }
      userText = userText.trim()
    }

    if (!userText && msgType === 'text') {
      await sendText(creds, chatId, '请告诉我你想生成什么样的图片~')
      return
    }

    // 2. 提取图片（如果有）
    const rawImageBuffers = []

    if (msgType === 'image') {
      const content = JSON.parse(msg.content || '{}')
      const imageKey = content.image_key
      if (imageKey) {
        rawImageBuffers.push(await downloadImage(creds, msgId, imageKey))
      }
    }

    if (msgType === 'post') {
      const content = JSON.parse(msg.content || '{}')
      const paragraphs = content.content || content.zh_cn?.content || []
      for (const para of paragraphs) {
        for (const elem of (para || [])) {
          if (elem.tag === 'img' && elem.image_key) {
            rawImageBuffers.push(await downloadImage(creds, msgId, elem.image_key))
          }
        }
      }
    }

    // 2.5 透明 PNG 预处理：GPT Image 2 会把透明区识别成"风格化色块"，
    // 输出背景被花花色块污染。发给模型前压平到环境配的纯色（默认白）。
    const FLATTEN_BG = process.env.REF_FLATTEN_BG || '#ffffff'
    const imageBuffers = []
    const imageBase64List = []
    let anyFlattened = false
    for (const raw of rawImageBuffers) {
      const { buf, flattened } = maybeFlattenAlpha(raw, { bg: FLATTEN_BG })
      imageBuffers.push(buf)
      imageBase64List.push(buf.toString('base64'))
      if (flattened) anyFlattened = true
    }
    if (anyFlattened) {
      log(`🧽 检测到透明 PNG 参考图，已压平到 ${FLATTEN_BG} 底（防 GPT Image 色块污染）`)
    }

    if (!userText && imageBase64List.length === 0) {
      await sendText(creds, chatId, '没有收到有效的文字或图片，请重新发送~')
      return
    }

    // 3. 发送"处理中"提示
    const timeHint = PROVIDER === 'codex' ? '\n⏱️ 预计需要 2~3 分钟' : ''
    await sendText(creds, chatId, `🎨 收到！正在为你生成图片...${timeHint}\n📝 需求：${userText || '(基于参考图生成)'}`)

    // 4. GPT 推理分析需求
    log(`🧠 GPT 推理中... provider=${PROVIDER}`)
    const analyzeFn = PROVIDER === 'codex' ? analyzeRequestCodex : analyzeRequestAPI
    const analysis = await analyzeFn(apiKey, userText, imageBase64List, {
      provider: PROVIDER,
      baseUrl: OPENAI_BASE_URL,
      // 告诉 analyzer：参考图被压成纯底了，让它在生图 prompt 里说明"那个底色不是想要的背景"
      refsFlattened: anyFlattened,
      flattenBg: FLATTEN_BG,
    })

    if (VERBOSE) log(`📋 分析结果: ${JSON.stringify(analysis)}`)

    // 4.1 needs_clarification → 反问，不生图
    if (analysis.needs_clarification) {
      const q = analysis.clarification_question || '需要再确认一下你的需求，能再描述清楚点吗？'
      await sendText(creds, chatId, `🤔 ${q}`)
      log(`⏸️  需要澄清，跳过生图`)
      return
    }

    const outputs = analysis.outputs || []
    if (outputs.length === 0) {
      await sendText(creds, chatId, '⚠️ 推理结果为空，没法生图，请换个描述试试~')
      log(`⏸️  outputs 为空，跳过`)
      return
    }

    const multi = outputs.length > 1
    await sendText(creds, chatId, `💡 理解：${analysis.summary}\n⏳ ${multi ? `将生成 ${outputs.length} 张对比图（JSON 版 + 自然语言版）` : '正在生成图片'}...`)

    // 5. 循环生图（每个 output 一次）
    const genFn = PROVIDER === 'codex' ? generateImageCodex : generateImageAPI
    let okCount = 0
    for (let i = 0; i < outputs.length; i++) {
      const out = outputs[i]
      const label = out.format === 'json' ? 'JSON 版' : (out.format === 'plain' ? '自然语言版' : `第 ${i+1} 版`)
      log(`🖼️ 生图 ${i+1}/${outputs.length} (${label}) mode=${out.mode}`)
      try {
        // 把 outputs[i] 摊平成 painter 期望的 analysis 格式
        const subAnalysis = {
          mode: out.mode,
          prompt: out.prompt,
          negative_prompt: out.negative_prompt || '',
          summary: analysis.summary,
        }
        const imageBuffer = await genFn(apiKey, subAnalysis, imageBuffers, { provider: PROVIDER, baseUrl: OPENAI_BASE_URL })
        log(`📤 上传图 ${i+1}/${outputs.length} 到飞书...`)
        const imageKey = await uploadImage(creds, imageBuffer)
        if (multi) {
          await sendText(creds, chatId, `📦 ${label}${out.filename_suffix ? ` (${out.filename_suffix})` : ''}：`)
        }
        await sendImage(creds, chatId, imageKey)
        okCount++
        log(`✅ 完成 ${i+1}/${outputs.length}！image_key=${imageKey}`)
      } catch (innerErr) {
        log(`❌ 第 ${i+1} 版生图失败: ${innerErr.message}`)
        await sendText(creds, chatId, `❌ ${label}生成失败：${innerErr.message}`)
      }
    }

    if (multi) log(`📊 多版生图完成 ${okCount}/${outputs.length}`)

  } catch (err) {
    log(`❌ 处理失败: ${err.message}`)
    try {
      await sendText(creds, chatId, `❌ 生图失败了：${err.message}\n请稍后重试或换个描述试试~`)
    } catch {}
  }
}

// ── 飞书长连接（官方 SDK WSClient）──────────────────────────
function startWSClient() {
  const wsClient = new lark.WSClient({
    appId: LARK_APP_ID,
    appSecret: LARK_APP_SECRET,
    loggerLevel: VERBOSE ? lark.LoggerLevel.DEBUG : lark.LoggerLevel.WARN,
  })

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      if (VERBOSE) log(`[event] im.message.receive_v1`)
      try {
        await enqueueTask(data)
      } catch (e) {
        log(`❌ enqueueTask error: ${e.message}`)
      }
    },
  })

  wsClient.start({ eventDispatcher })
  log('✅ 飞书 WSClient 已启动，等待消息...')
}

// ── 启动 ────────────────────────────────────────────────────
async function main() {
  log(`🚀 太空杀飞书生图机器人启动`)
  log(`   Provider: ${PROVIDER}`)
  log(`   Verbose: ${VERBOSE}`)

  // 拉取机器人自身 open_id —— 用于群聊里识别"是否被 @"
  // 失败也不阻止启动（私聊还能用），但群聊会被 enqueueTask 跳过并打日志
  try {
    const botInfo = await getBotInfo(creds)
    BOT_OPEN_ID = botInfo?.open_id || null
    log(`🤖 机器人身份: ${botInfo?.app_name || '(unknown)'} open_id=${BOT_OPEN_ID || 'N/A'}`)
    if (!BOT_OPEN_ID) {
      log(`⚠️  bot/v3/info 返回了，但没拿到 open_id，群聊里所有消息都会被忽略`)
    }
  } catch (e) {
    log(`⚠️  getBotInfo 失败，群聊里的 @ 触发判定会失效（消息会被忽略）: ${e.message}`)
  }

  // 加载 skills + 启动 watcher（热加载）
  const skillsDir = resolve(__dirname, 'skills')
  initSkills({ dir: skillsDir, log: (msg) => log(msg) })
  const skills = listSkills()
  if (skills.length > 0) {
    for (const s of skills) {
      log(`   ↳ skill: ${s.name}${s.description ? ' — ' + s.description.slice(0, 60) : ''}`)
    }
  } else {
    log(`   ↳ skill: (none) — analyzer 将走基础 prompt`)
  }

  startWSClient()
}

main().catch(e => {
  console.error('❌ 启动失败:', e)
  process.exit(1)
})

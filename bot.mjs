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
import { initFeishu, sendText, sendImage, uploadImage, downloadImage } from './feishu.mjs'
import { analyzeRequest as analyzeRequestAPI } from './analyzer.mjs'
import { analyzeRequest as analyzeRequestCodex } from './analyzer-codex.mjs'
import { generateImage as generateImageAPI } from './painter.mjs'
import { generateImage as generateImageCodex } from './painter-codex.mjs'

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

  // 支持群消息（@机器人）和单聊
  if (msg.chat_type !== 'group' && msg.chat_type !== 'p2p') return

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
    const imageBuffers = []
    const imageBase64List = []

    if (msgType === 'image') {
      const content = JSON.parse(msg.content || '{}')
      const imageKey = content.image_key
      if (imageKey) {
        const buf = await downloadImage(creds, msgId, imageKey)
        imageBuffers.push(buf)
        imageBase64List.push(buf.toString('base64'))
      }
    }

    if (msgType === 'post') {
      const content = JSON.parse(msg.content || '{}')
      const paragraphs = content.content || content.zh_cn?.content || []
      for (const para of paragraphs) {
        for (const elem of (para || [])) {
          if (elem.tag === 'img' && elem.image_key) {
            const buf = await downloadImage(creds, msgId, elem.image_key)
            imageBuffers.push(buf)
            imageBase64List.push(buf.toString('base64'))
          }
        }
      }
    }

    if (!userText && imageBase64List.length === 0) {
      await sendText(creds, chatId, '没有收到有效的文字或图片，请重新发送~')
      return
    }

    // 3. 发送"处理中"提示
    await sendText(creds, chatId, `🎨 收到！正在为你生成图片...\n📝 需求：${userText || '(基于参考图生成)'}`)

    // 4. GPT 推理分析需求
    log(`🧠 GPT 推理中... provider=${PROVIDER}`)
    const analyzeFn = PROVIDER === 'codex' ? analyzeRequestCodex : analyzeRequestAPI
    const analysis = await analyzeFn(apiKey, userText, imageBase64List, { provider: PROVIDER, baseUrl: OPENAI_BASE_URL })

    if (VERBOSE) log(`📋 分析结果: ${JSON.stringify(analysis)}`)

    await sendText(creds, chatId, `💡 理解：${analysis.summary}\n⏳ 正在生成图片...`)

    // 5. 生图
    log(`🖼️ 生图中... mode=${analysis.mode} provider=${PROVIDER}`)
    const genFn = PROVIDER === 'codex' ? generateImageCodex : generateImageAPI
    const imageBuffer = await genFn(apiKey, analysis, imageBuffers, { provider: PROVIDER, baseUrl: OPENAI_BASE_URL })

    // 6. 上传到飞书 + 发送
    log(`📤 上传图片到飞书...`)
    const imageKey = await uploadImage(creds, imageBuffer)
    await sendImage(creds, chatId, imageKey)

    log(`✅ 完成！image_key=${imageKey}`)

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
function main() {
  log(`🚀 太空杀飞书生图机器人启动`)
  log(`   Provider: ${PROVIDER}`)
  log(`   Verbose: ${VERBOSE}`)

  startWSClient()
}

main()

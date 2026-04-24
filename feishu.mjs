// ============================================================
// 飞书 API 封装 — 消息收发 + 图片上传下载
// ============================================================

import { readFileSync, writeFileSync } from 'node:fs'

let _tenantToken = null
let _tokenExpiry = 0

export function initFeishu(appId, appSecret) {
  if (!appId || !appSecret) throw new Error('LARK_APP_ID / LARK_APP_SECRET 缺失')
  return { appId, appSecret }
}

// ── Tenant Access Token ─────────────────────────────────────
export async function getTenantToken(creds) {
  if (_tenantToken && Date.now() < _tokenExpiry) return _tenantToken
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  })
  const j = await r.json()
  if (j.code !== 0) throw new Error(`tenant_token failed: ${j.msg}`)
  _tenantToken = j.tenant_access_token
  _tokenExpiry = Date.now() + (j.expire - 300) * 1000 // 提前5分钟刷新
  return _tenantToken
}

// ── 发送文本消息 ────────────────────────────────────────────
export async function sendText(creds, chatId, text, replyMsgId = null) {
  const token = await getTenantToken(creds)
  const body = {
    receive_id: chatId,
    msg_type: 'text',
    content: JSON.stringify({ text }),
  }
  const url = new URL('https://open.feishu.cn/open-apis/im/v1/messages')
  url.searchParams.set('receive_id_type', 'chat_id')
  const opts = {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
  if (replyMsgId) {
    // 回复特定消息
    const replyBody = { ...body, reply_in_thread: false }
    opts.body = JSON.stringify(replyBody)
  }
  const r = await fetch(url.toString(), opts)
  return r.json()
}

// ── 发送图片消息 ────────────────────────────────────────────
export async function sendImage(creds, chatId, imageKey) {
  const token = await getTenantToken(creds)
  const body = {
    receive_id: chatId,
    msg_type: 'image',
    content: JSON.stringify({ image_key: imageKey }),
  }
  const url = new URL('https://open.feishu.cn/open-apis/im/v1/messages')
  url.searchParams.set('receive_id_type', 'chat_id')
  const r = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

// ── 上传图片（Buffer → image_key）────────────────────────────
export async function uploadImage(creds, imageBuffer, imageName = 'generated.png') {
  const token = await getTenantToken(creds)
  const form = new FormData()
  form.append('image_type', 'message')
  form.append('image', new Blob([imageBuffer]), imageName)
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const j = await r.json()
  if (j.code !== 0) throw new Error(`upload_image failed: ${j.msg}`)
  return j.data.image_key
}

// ── 下载消息中的图片（image_key → Buffer）──────────────────
export async function downloadImage(creds, messageId, imageKey) {
  const token = await getTenantToken(creds)
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) throw new Error(`download_image failed: ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// ── 获取消息详情（用于提取图片 key 等）──────────────────────
export async function getMessage(creds, messageId) {
  const token = await getTenantToken(creds)
  const r = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return r.json()
}

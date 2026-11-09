import http from 'node:http'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

const port = Number(process.env.MOCK_GARDEN_API_PORT || 8788)
const host = process.env.MOCK_GARDEN_API_HOST || '127.0.0.1'
const imageSize = Number(process.env.MOCK_GARDEN_IMAGE_SIZE || 512)
const presetColors = {
  morning: [0xff, 0xd9, 0xa0],
  noon: [0xa0, 0xd8, 0xff],
  night: [0x2a, 0x2a, 0x4a],
}
const presetNames = Object.keys(presetColors)

// ---- 最小 PNG 编码（纯色图，按 preset 着色便于区分） ----

const crcTable = new Int32Array(256).map((_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value
})

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function solidPng([r, g, b], size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = r
    row[2 + x * 3] = g
    row[3 + x * 3] = b
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const presetPngs = new Map(presetNames.map((name) => [name, solidPng(presetColors[name], imageSize)]))

// ---- 任务存储 ----

const jobs = new Map()

function nowIso() {
  return new Date().toISOString()
}

function scheduleJob(jobId, mode) {
  setTimeout(() => {
    const job = jobs.get(jobId)
    if (!job) return
    job.status = 'running'
    job.started_at = nowIso()
  }, 400)
  setTimeout(() => {
    const job = jobs.get(jobId)
    if (!job) return
    job.completed_at = nowIso()
    if (mode === 'fail') {
      job.status = 'failed'
      job.error_code = 'mock_failure'
      job.error_message = 'Mock 生成失败（mode=fail）'
      return
    }
    job.status = 'succeeded'
    job.result_asset_id = `asset-${job.preset_key}-${jobId}`
  }, 1400)
}

// ---- HTTP 基础设施 ----

function appendCors(headers) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, appendCors({ 'Content-Type': 'application/json; charset=utf-8' }))
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/** 去掉可选的 /api 前缀（vite dev proxy 会 rewrite 剥掉前缀，真实反向代理可能不会） */
function stripApiPrefix(pathname) {
  return pathname.startsWith('/api/') ? pathname.slice(4) : pathname
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, appendCors({}))
    res.end()
    return
  }

  const url = new URL(req.url, 'http://mock-garden.local')
  const path = stripApiPrefix(url.pathname)
  const failMode = url.searchParams.get('mode') === 'fail'

  const submitMatch = path.match(/^\/schemes\/([^/]+)\/ai-generations$/)
  if (req.method === 'POST' && submitMatch) {
    let payload
    try {
      payload = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 422, { detail: '请求体不是有效 JSON' })
      return
    }
    const required = ['scheme_revision_id', 'preset_key', 'client_request_id']
    const missing = required.filter((key) => typeof payload?.[key] !== 'string' || !payload[key])
    if (missing.length) {
      sendJson(res, 422, { detail: `缺少字段：${missing.join('、')}` })
      return
    }
    if (!presetNames.includes(payload.preset_key)) {
      sendJson(res, 422, { detail: `preset_key 必须是 ${presetNames.join('|')} 之一` })
      return
    }
    const jobId = crypto.randomUUID()
    const job = {
      job_id: jobId,
      scheme_id: decodeURIComponent(submitMatch[1]),
      status: 'queued',
      preset_key: payload.preset_key,
      error_code: null,
      error_message: null,
      result_asset_id: null,
      client_request_id: payload.client_request_id,
      created_at: nowIso(),
      started_at: null,
      completed_at: null,
    }
    jobs.set(jobId, job)
    scheduleJob(jobId, failMode ? 'fail' : 'ok')
    sendJson(res, 202, job)
    return
  }

  if (req.method === 'GET' && path === '/ai-generations/capability') {
    sendJson(res, 200, {
      provider: 'mock-garden',
      supports_image_input: false,
      supports_multi_image_input: false,
      max_total_input_images: 0,
    })
    return
  }

  const jobMatch = path.match(/^\/ai-generations\/([^/]+)$/)
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]))
    if (!job) {
      sendJson(res, 404, { detail: '任务不存在' })
      return
    }
    sendJson(res, 200, job)
    return
  }

  // 公司画廊归档（本地迁移版本自带功能，不属于 Garden 服务；开发期占位接受即可）
  if (req.method === 'POST' && path === '/gallery') {
    sendJson(res, 200, { status: 'archived' })
    return
  }

  const mediaMatch = path.match(/^\/media\/([^/]+)\/content$/)
  if (req.method === 'GET' && mediaMatch) {
    const assetId = decodeURIComponent(mediaMatch[1])
    const preset = presetNames.find((name) => assetId.includes(`-${name}-`)) ?? 'noon'
    const png = presetPngs.get(preset)
    res.writeHead(200, appendCors({
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      ETag: `"${crypto.createHash('sha256').update(png).digest('hex')}"`,
      'Cache-Control': 'private',
    }))
    res.end(png)
    return
  }

  sendJson(res, 404, { detail: `未找到路由：${req.method} ${path}` })
})

server.listen(port, host, () => {
  console.log(`mock-garden-api listening on http://${host}:${port}`)
  console.log(`endpoints (both with and without /api prefix):`)
  console.log(`  POST /api/schemes/{scheme}/ai-generations?mode=fail  提交任务`)
  console.log(`  GET  /api/ai-generations/capability`)
  console.log(`  GET  /api/ai-generations/{job_id}`)
  console.log(`  GET  /api/media/{asset_id}/content`)
})

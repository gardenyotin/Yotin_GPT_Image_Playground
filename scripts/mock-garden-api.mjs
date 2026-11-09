import http from 'node:http'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'

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

// 本地 mock 不访问任何供应商；用请求头 X-Mock-User 模拟归属，缺省为开发用户。
const jobs = new Map()
const capabilities = {
  provider: 'mock-garden', supports_image_input: true, supports_multi_image_input: true,
  max_total_input_images: 3, max_input_images_per_job: 3, max_output_images_per_job: 4,
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname.replace(/^\/api(?=\/)/, '')
  if (req.method === 'GET' && path === '/image-capabilities') return sendJson(res, 200, capabilities)
  const user = req.headers['x-mock-user'] || 'local-user'
  if (path === '/identity' && req.method === 'GET') return sendJson(res, 200, { username: user, display_name: '本地 Mock 用户' })
  if (path === '/auth/login' && req.method === 'POST') return sendJson(res, 200, { username: user, display_name: '本地 Mock 用户' })
  if (path === '/auth/logout' && req.method === 'POST') return sendJson(res, 200, { ok: true })
  if (user === 'anonymous') return sendJson(res, 401, { detail: '请登录' })
  try {
    if (req.method === 'POST' && path === '/image-jobs') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const request = new Request(url, { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] || 'application/json' }, body: bytes })
      const multipart = (req.headers['content-type'] || '').startsWith('multipart/')
      const form = multipart ? await request.formData() : null
      const body = form ? Object.fromEntries([...form].filter(([key]) => key !== 'image')) : await request.json()
      const params = form ? JSON.parse(body.params || '{}') : body.params || {}
      const images = form ? form.getAll('image') : []
      if (!['garden-web', 'playground'].includes(body.source_app) || typeof body.prompt !== 'string' || !body.prompt.trim()
        || typeof body.client_request_id !== 'string' || !body.client_request_id.trim() || body.client_request_id.length > 64
        || !Number.isInteger(params.n ?? 1) || (params.n ?? 1) < 1 || (params.n ?? 1) > 4 || images.length > 3
        || images.some((f) => typeof f === 'string' || !f.type.startsWith('image/'))
        || (form && [...form].some(([key, value]) => typeof value !== 'string' && key !== 'image'))) {
        return sendJson(res, 422, { detail: '请求参数或参考图片无效' })
      }
      const entries = await Promise.all(images.map(async (f, index) => ({ slot: index + 1, mime: f.type, sha256: crypto.createHash('sha256').update(Buffer.from(await f.arrayBuffer())).digest('hex') })))
      const existing = [...jobs.values()].find((j) => j.requested_by_user_id === user && j.source_app === body.source_app && j.client_request_id === body.client_request_id)
      if (existing) {
        if (existing.prompt !== body.prompt || !isDeepStrictEqual(existing.params_json, params)
          || !isDeepStrictEqual(existing.input_images_json.images.map((e) => e.sha256), entries.map((e) => e.sha256))) {
          return sendJson(res, 409, { detail: 'client_request_id 已用于不同的提示词、参数或参考图片' })
        }
        return sendJson(res, 200, existing)
      }
      const job = {
        job_id: crypto.randomUUID(), requested_by_user_id: user, source_app: body.source_app,
        client_request_id: body.client_request_id, prompt: body.prompt, params_json: params,
        input_images_json: { images: entries },
        status: 'queued', result_assets_json: [], created_at: new Date().toISOString(),
        error_code: null, error_message: null,
      }
      jobs.set(job.job_id, job)
      setTimeout(() => { if (job.status === 'queued') job.status = 'running' }, 100)
      setTimeout(() => {
        if (job.status !== 'running') return
        job.completed_at = new Date().toISOString()
        job.status = url.searchParams.get('mode') === 'fail' ? 'failed' : 'succeeded'
        if (job.status === 'failed') { job.error_code = 'mock_failure'; job.error_message = 'Mock 生成失败' }
        else job.result_assets_json = Array.from({ length: params.n ?? 1 }, (_, index) => ({ index, mime: 'image/png' }))
      }, 300)
      return sendJson(res, 202, job)
    }
    const match = path.match(/^\/image-jobs\/([^/]+)(?:\/(cancel|results\/(\d+)))?$/)
    if (match) {
      const job = jobs.get(decodeURIComponent(match[1]))
      if (!job || job.requested_by_user_id !== user) return sendJson(res, 404, { detail: '任务不存在' })
      if (req.method === 'POST' && match[2] === 'cancel') {
        const cancelled = ['queued', 'running', 'retry_wait'].includes(job.status)
        if (cancelled) job.status = 'cancelled'
        return sendJson(res, 200, { job_id: job.job_id, cancelled })
      }
      if (req.method === 'GET' && match[3] !== undefined) {
        const index = Number(match[3])
        if (job.status !== 'succeeded' || !job.result_assets_json.some((e) => e.index === index)) return sendJson(res, 404, { detail: '任务结果不存在' })
        const png = presetPngs.get(presetNames[index % presetNames.length])
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' })
        return res.end(png)
      }
      if (req.method === 'GET' && !match[2]) return sendJson(res, 200, job)
    }
    if (req.method === 'POST' && path === '/gallery') return sendJson(res, 200, { status: 'archived' })
    sendJson(res, 404, { detail: '未找到路由' })
  } catch (err) {
    console.warn('Mock 请求失败', err.message)
    sendJson(res, 422, { detail: '请求体无效' })
  }
})

server.listen(port, host, () => console.log(`mock-garden-api listening on http://${host}:${server.address().port}`))

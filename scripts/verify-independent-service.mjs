// 从首页真实点击→网关→假 /v1 服务→取图→reload；不调用供应商、不修改线上数据。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const require = createRequire(path.resolve(process.env.GARDEN_ROOT || '../Garden-Design-Calculator', 'src/frontend/package.json'))
const { chromium, expect } = require('@playwright/test')
const root = await mkdtemp('/tmp/playground-independent-browser-')
const posts = []
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const upstream = createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req))
  if (req.url === '/api/identity') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ user_id: 'browser-alice' }))
  }
  assert.equal(req.headers['x-api-key'], 'gateway-private-test-key')
  assert.equal(req.headers.cookie, undefined)
  if (req.url.startsWith('/v1/jobs/') && req.url.includes('/result?')) {
    res.writeHead(200, { 'Content-Type': 'image/png' })
    return res.end(png)
  }
  res.writeHead(req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' })
  if (req.url === '/v1/models') return res.end(JSON.stringify({ provider: 'test', data: [{ supports_image_input: true,
    supports_multi_image_input: true, max_total_input_images: 8, max_input_images_per_job: 8,
    max_output_images_per_job: 4, supported_params: ['n', 'size', 'quality', 'output_format'] }] }))
  if (req.method === 'POST') {
    posts.push({ path: req.url, key: req.headers['idempotency-key'], payload: JSON.parse(body) })
    assert.equal(posts.at(-1).payload.user_ref, 'browser-alice')
  }
  res.end(JSON.stringify({ job_id: 'browser-job', requested_by: 'browser-alice', status: req.method === 'POST' ? 'queued' : 'succeeded',
    params_json: { n: 1 }, result_assets_json: [{ index: 0, storage_key: 'private-output' }] }))
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const free = net.createServer()
await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve))
const port = free.address().port
await new Promise((resolve) => free.close(resolve))
await mkdir(path.join(root, 'data'))
const api = `http://127.0.0.1:${upstream.address().port}`
const server = spawn('python3', ['deploy/ai_gallery_server.py'], { env: { ...process.env,
  AI_GALLERY_PORT: String(port), AI_GALLERY_HOST: '127.0.0.1', AI_GALLERY_APP_DIR: path.resolve('dist'),
  AI_GALLERY_DATA_DIR: path.join(root, 'data'), GARDEN_API_URL: api,
  AI_IMAGE_SERVICE_URL: api, AI_IMAGE_SERVICE_API_KEY: 'gateway-private-test-key' }, stdio: 'ignore' })
let browser
try {
  const base = `http://127.0.0.1:${port}`
  await expect(async () => assert.equal((await fetch(base + '/api/health')).status, 200)).toPass({ timeout: 10000 })
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/yotin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome' })
  const context = await browser.newContext()
  await context.addInitScript(() => localStorage.setItem('ai-company-gallery-identity', JSON.stringify({ id: 'browser-test', nickname: '网关回归', avatar: '🌷' })))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.getByLabel('描述你想生成的图片，可输入 @ 来指定参考图...').fill('独立生图服务网关回归')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '生成图像', exact: true }).click()
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('gpt-image-playground')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const req = db.transaction('tasks').objectStore('tasks').getAll()
      req.onsuccess = () => { db.close(); resolve(req.result[0]) }
      req.onerror = () => { db.close(); reject(req.error) }
    }
  }))
  await expect(async () => expect((await saved())?.status).toBe('done')).toPass({ timeout: 20000 })
  assert.equal(posts.length, 1)
  assert.equal(posts[0].path, '/v1/images/generations')
  assert.match(posts[0].key, /^[a-f0-9-]{36}$/)
  await page.reload({ waitUntil: 'domcontentloaded' })
  assert.equal((await saved()).status, 'done')
  assert.equal(posts.length, 1)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(root, 'result.png'), fullPage: true })
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ status: 'passed', generationPosts: posts.length,
    path: posts[0].path, reloadPreserved: true, pageErrors: errors }))
  console.log('INDEPENDENT_GATEWAY_BROWSER_PASSED', root)
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  upstream.closeAllConnections()
  await new Promise((resolve) => upstream.close(resolve))
}

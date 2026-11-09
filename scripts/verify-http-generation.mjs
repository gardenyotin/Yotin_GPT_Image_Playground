// HTTP 页面真实按钮回归；所有 API 均拦截到浏览器夹具，不提交真实生图。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const base = process.argv[2]
assert(base && new URL(base).protocol === 'http:', '请提供非 localhost 的 HTTP 页面地址')
const require = createRequire(path.resolve(process.env.GARDEN_ROOT || '../Garden-Design-Calculator', 'src/frontend/package.json'))
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext()
  await context.addInitScript(() => localStorage.setItem('ai-company-gallery-identity', JSON.stringify({ id: 'http-test', nickname: 'HTTP回归', avatar: '🌷' })))
  const page = await context.newPage()
  const errors = []
  const keys = []
  page.on('pageerror', (err) => errors.push(err.message))
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== new URL(base).origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    let data = { items: [] }
    if (url.pathname === '/api/image-capabilities') data = { provider: 'fake', supports_image_input: true, supports_multi_image_input: true, max_total_input_images: 3, max_input_images_per_job: 3, max_output_images_per_job: 4 }
    if (url.pathname === '/api/runtime-config') data = { model: 'garden-managed', streamImages: false, streamPartialImages: 0 }
    if (url.pathname === '/api/image-jobs' && request.method() === 'POST') {
      const match = request.postData()?.match(/name="client_request_id"\r\n\r\n([^\r]+)/)
      assert(match, '提交缺少幂等键')
      keys.push(match[1])
      data = { job_id: 'http-uuid-test', status: 'queued' }
    }
    if (url.pathname === '/api/image-jobs/http-uuid-test') data = { job_id: 'http-uuid-test', status: 'succeeded', params_json: { n: 1 }, result_assets_json: [{ index: 0 }] }
    if (url.pathname.endsWith('/results/0')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') })
    return route.fulfill({ status: request.method() === 'POST' ? 202 : 200, contentType: 'application/json', body: JSON.stringify(data) })
  })
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID })), { secure: false, uuid: 'undefined' })
  await page.getByLabel('描述你想生成的图片，可输入 @ 来指定参考图...').fill('HTTP UUID 生图回归')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: '/tmp/playground-http-before-submit.png' })
  await page.getByRole('button', { name: '生成图像', exact: true }).click()
  const savedTask = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('gpt-image-playground')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const read = db.transaction('tasks').objectStore('tasks').getAll()
      read.onsuccess = () => { db.close(); resolve(read.result[0]) }
      read.onerror = () => { db.close(); reject(read.error) }
    }
  }))
  await expect(async () => expect((await savedTask())?.status).toBe('done')).toPass({ timeout: 20000 })
  assert.equal(keys.length, 1)
  assert.match(keys[0], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.equal((await savedTask()).gardenRequestId, keys[0])
  await page.reload({ waitUntil: 'domcontentloaded' })
  assert.equal((await savedTask()).status, 'done')
  assert.equal(keys.length, 1)
  assert.equal(errors.some((error) => error.includes('randomUUID')), false)
  console.log('HTTP_SUBMIT_RESULT_PERSISTENCE_OK; no real API submissions')
} finally {
  await browser.close()
}

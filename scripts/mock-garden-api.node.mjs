import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { after, before, test } from 'node:test'
import crypto from 'node:crypto'

let child
let origin
before(async () => {
  child = spawn(process.execPath, ['scripts/mock-garden-api.mjs'], { env: { ...process.env, MOCK_GARDEN_API_PORT: '0', MOCK_GARDEN_IMAGE_SIZE: '4' }, stdio: ['ignore', 'pipe', 'pipe'] })
  origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mock 启动超时')), 5000)
    child.once('error', reject)
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    })
  })
})
after(async () => { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') } })

test('真实 HTTP multipart → 幂等重放 → 多图结果与归属', async () => {
  const caps = await (await fetch(`${origin}/api/image-capabilities`)).json()
  assert.equal(caps.max_output_images_per_job, 4)
  const makeBody = () => {
    const form = new FormData()
    form.set('source_app', 'playground')
    form.set('client_request_id', 'stable-request')
    form.set('prompt', '原始提示词\n不要庭院模板')
    form.set('params', JSON.stringify({ n: 2 }))
    for (const value of ['one', 'two']) form.append('image', new Blob([value], { type: 'image/png' }), value + '.png')
    return form
  }
  const response = await fetch(`${origin}/api/image-jobs`, { method: 'POST', body: makeBody() })
  assert.equal(response.status, 202)
  const job = await response.json()
  assert.deepEqual(job.input_images_json.images.map((image) => image.sha256), ['one', 'two'].map((value) => crypto.createHash('sha256').update(value).digest('hex')))
  const replay = await fetch(`${origin}/api/image-jobs`, { method: 'POST', body: makeBody() })
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).job_id, job.job_id)
  const conflict = makeBody()
  conflict.set('prompt', 'different prompt')
  assert.equal((await fetch(`${origin}/api/image-jobs`, { method: 'POST', body: conflict })).status, 409)
  let status
  for (let attempt = 0; attempt < 30; attempt++) {
    status = await (await fetch(`${origin}/api/image-jobs/${job.job_id}`)).json()
    if (status.status === 'succeeded') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(status.status, 'succeeded')
  assert.equal(status.result_assets_json.length, 2)
  for (const index of [0, 1]) {
    const image = await fetch(`${origin}/api/image-jobs/${job.job_id}/results/${index}`)
    assert.equal(image.headers.get('Content-Type'), 'image/png')
    assert.equal(image.status, 200)
  }
  assert.equal((await fetch(`${origin}/api/image-jobs/${job.job_id}/results/2`)).status, 404)
  assert.equal((await fetch(`${origin}/api/image-jobs/${job.job_id}`, { headers: { 'X-Mock-User': 'bob' } })).status, 404)
  assert.equal((await fetch(`${origin}/api/image-jobs/${job.job_id}`, { headers: { 'X-Mock-User': 'anonymous' } })).status, 401)
})

test('取消终态不会被定时完成覆盖', async () => {
  const response = await fetch(`${origin}/api/image-jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_app: 'playground', client_request_id: 'cancel-me', prompt: 'cat', params: { n: 1 } }) })
  const job = await response.json()
  assert.equal((await (await fetch(`${origin}/api/image-jobs/${job.job_id}/cancel`, { method: 'POST' })).json()).cancelled, true)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal((await (await fetch(`${origin}/api/image-jobs/${job.job_id}`)).json()).status, 'cancelled')
})

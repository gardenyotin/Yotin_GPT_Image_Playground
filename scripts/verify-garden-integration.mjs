// 显式真实联调：独立数据库/媒体/配置副本，A/B 各提交一次，不操作生产环境。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
if (!args.includes('--real') || !args.includes('--config') || !args.includes('--reference')) {
  throw new Error('用法：node scripts/verify-garden-integration.mjs --real --config <Garden 配置> --reference <参考图> [--garden-root <Garden 仓库>]')
}
const playground = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const garden = path.resolve(args.includes('--garden-root') ? option('--garden-root') : path.join(playground, '../Garden-Design-Calculator'))
const src = path.join(garden, 'src')
const python = path.join(src, '.venv/bin/python')
const node = process.execPath
const configPath = path.resolve(option('--config'))
const referencePath = path.resolve(option('--reference'))
const configBytes = await readFile(configPath)
const config = JSON.parse(configBytes)
const active = config.vendors?.find((v) => v.vendor_id === config.active_vendor_id)
assert(active?.api_key && active.adapter !== 'fake', '需要已配置密钥的真实供应商')
const reference = await readFile(referencePath)
const mime = /\.jpe?g$/i.test(referencePath) ? 'image/jpeg' : 'image/png'
const ports = { core: 8220, ai: 9220, gateway: 8788, playground: 5178, admin: 5298 }
const proxy = JSON.parse(await readFile(path.join(playground, 'dev-proxy.config.json'), 'utf8'))
assert(proxy.enabled && proxy.prefix === '/api' && proxy.target === `http://127.0.0.1:${ports.gateway}`, '开发代理须指向本次隔离网关，禁止误连其他环境')
for (const port of Object.values(ports)) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}
const resume = args.includes('--resume')
const output = resume ? path.resolve(option('--resume')) : await mkdtemp('/tmp/garden-real-integration-')
assert(output.startsWith('/tmp/garden-real-integration-'), '只能续查本脚本的隔离目录')
const password = randomUUID()
const url = (key) => `http://127.0.0.1:${ports[key]}`
const children = []
const report = resume ? JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'))
  : { output, provider: active.display_name, model: active.model, jobs: [], checks: {} }
if (resume) {
  assert.equal(report.jobs.length, 2, '续查需要两个已提交任务，禁止自动补提')
  assert(report.jobs.every((job) => job.status === 'succeeded'), '仅支持续查已成功任务')
  assert.equal(Buffer.compare(configBytes, await readFile(path.join(output, 'ai-provider.json'))), 0, '续查配置必须保持一致')
  await writeFile(path.join(output, 'report-before-resume.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  delete report.error
}
await mkdir(path.join(output, 'src'), { recursive: true })
await writeFile(path.join(output, 'ai-provider.json'), configBytes, { mode: 0o600 })
const env = {
  ...process.env,
  PATH: `${path.dirname(node)}:${path.dirname(python)}:${process.env.PATH}`,
  PYTHONPATH: path.join(src, 'backend'),
  DATABASE_URL: `sqlite:///${output}/integration.db`,
  YOUTING_SRC_ROOT: path.join(output, 'src'),
  YOUTING_DATA_DIR: path.join(output, 'src/data'),
  YOUTING_ASSETS_DIR: path.join(output, 'src/assets'),
  YOUTING_MEDIA_DIR: path.join(output, 'media'),
  YOUTING_AI_CONFIG: path.join(output, 'ai-provider.json'),
  YOUTING_AI_EMBEDDED: '0',
  YOUTING_AI_SERVICE_URL: url('ai'),
  YOUTING_BOOTSTRAP_PASSWORD: password,
}
const require = createRequire(path.join(src, 'frontend/package.json'))
const { chromium, request, expect } = require('@playwright/test')
let browser
const contexts = []

function start(name, command, argv, cwd, extra = {}) {
  const log = createWriteStream(path.join(output, `${name}.log`), { mode: 0o600, flags: 'a' })
  const child = spawn(command, argv, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  children.push(child)
  return child
}
async function command(name, argv) {
  const child = start(name, python, argv, src)
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  assert.equal(code, 0, `${name} 失败，查看隔离日志`)
}
async function ready(target) {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    try { if ((await fetch(target)).ok) return } catch { /* 启动期间等待监听。 */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`启动超时：${target}`)
}
async function json(response) {
  assert(response.ok(), `HTTP ${response.status()} ${new URL(response.url()).pathname}`)
  return response.json()
}
async function client(baseURL, username = 'admin') {
  const api = await request.newContext({ baseURL })
  contexts.push(api)
  await json(await api.post('/api/auth/login', { data: { username, password } }))
  return api
}
async function waitJob(api, endpoint, id) {
  const until = Date.now() + 15 * 60_000
  let job
  do {
    job = await json(await api.get(`${endpoint}/${id}`))
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 2000))
  } while (Date.now() < until)
  throw new Error(`任务尚未终态：${id}；不要重新提交，保留数据库核查`)
}

console.log(JSON.stringify({ output, provider: report.provider, model: report.model, ports }))
try {
  if (resume) {
    // 仅重置本脚本隔离库的临时账号口令，不重建任务、不调用供应商。
    await command('resume-password', ['-c', "import os; from app.db import SessionLocal, User; from app.security import hash_password; from sqlalchemy import select; db=SessionLocal(); users=db.scalars(select(User).where(User.username.in_(['admin','integration-user']))).all(); [(setattr(u,'password_hash',hash_password(os.environ['YOUTING_BOOTSTRAP_PASSWORD']))) for u in users]; db.commit(); db.close()"])
  } else {
    for (const name of ['data', 'schemas', 'assets']) await cp(path.join(src, name), path.join(output, 'src', name), { recursive: true })
    await command('migrate', ['-m', 'alembic', 'upgrade', 'head'])
    await command('seed', ['-m', 'app.cli', 'seed'])
    await command('bootstrap', ['-m', 'app.cli', 'bootstrap'])
  }
  start('ai-api', python, ['-m', 'uvicorn', 'app.ai.api:app', '--host', '127.0.0.1', '--port', String(ports.ai)], src)
  await ready(`${url('ai')}/api/ai-service/ready`)
  start('core', python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(ports.core)], src)
  await ready(`${url('core')}/api/ready`)
  start('worker', python, ['scripts/ai_worker_loop.py'], src, { AI_WORKER_INTERVAL: '0.5' })
  start('gateway', python, ['deploy/ai_gallery_server.py'], playground, {
    GARDEN_API_URL: url('core'), AI_GALLERY_HOST: '127.0.0.1', AI_GALLERY_PORT: String(ports.gateway),
    AI_GALLERY_DATA_DIR: path.join(output, 'gallery'), AI_GALLERY_APP_DIR: path.join(playground, 'dist'),
  })
  await ready(`${url('gateway')}/api/image-capabilities`)
  start('playground-ui', node, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(ports.playground), '--strictPort'], playground)
  start('admin-ui', node, ['node_modules/vite/bin/vite.js', '--config', 'vite.admin.config.ts', '--host', '127.0.0.1', '--port', String(ports.admin)], path.join(src, 'frontend'), { YOUTING_API_TARGET: url('core') })
  await Promise.all([ready(url('playground')), ready(url('admin'))])
  const admin = await client(url('core'))
  const user = 'integration-user'
  if (!resume) {
    await json(await admin.post('/api/platform/users', { data: { username: user, password, display_name: '统一生图联调' } }))
    const api = await client(url('core'), user)
    const workspaces = await json(await api.get('/api/workspaces'))
    const wid = workspaces.items[0].workspace_id
    const site = await json(await api.post(`/api/workspaces/${wid}/sites`, { data: { label: '隔离联调场地' } }))
    const project = await json(await api.post(`/api/workspaces/${wid}/projects`, { data: { name: '统一生图真实联调', site_id: site.site_id } }))
    const scene = JSON.parse(await readFile(path.join(src, 'frontend/e2e/fixtures/scene-b9.json'), 'utf8'))
    await json(await api.post(`/api/projects/${project.project_id}/site-revisions`, { data: { site_json: scene.site, source_type: 'customer_estimate' } }))
    await json(await api.patch(`/api/projects/${project.project_id}/brief`, { data: { brief: { budget: 20000, activity_ratio: 60, style: 'minimal', product_intents: {} } } }))
    const scheme = await json(await api.post(`/api/projects/${project.project_id}/schemes`, { data: { name: '联调方案' } }))
    await json(await api.post(`/api/schemes/${scheme.scheme_id}/revisions`, { data: { scene, base_revision_id: null } }))
    const revisions = await json(await api.get(`/api/schemes/${scheme.scheme_id}/revisions`))
    const schemeEndpoint = `/api/schemes/${scheme.scheme_id}/ai-generations`
    const submitted = await json(await api.post(schemeEndpoint, { multipart: {
      scheme_revision_id: revisions.items[0].revision_id, preset_key: 'noon', client_request_id: randomUUID(),
      camera_snapshot: JSON.stringify({ camera: { position: [0, 0, 0], target: [0, 0, 0], fov: 50 }, preset: '午后', sunTime: 12 }),
      file: { name: path.basename(referencePath), mimeType: mime, buffer: reference },
    } }))
    report.jobs.push({ job_id: submitted.job_id, job_type: 'scheme', status: submitted.status })
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    const a = await waitJob(api, '/api/ai-generations', submitted.job_id)
    Object.assign(report.jobs[0], { status: a.status, error_code: a.error_code })
    assert.equal(a.status, 'succeeded', `Garden 任务失败：${a.error_code}`)
    console.log(`Garden 任务成功：${a.job_id}`)
  }

  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  const external = []
  // 公共字体/版本检查 GET 不属于生图调用；供应商生成 POST 不得从浏览器发出。
  page.on('request', (req) => { if (req.method() !== 'GET' && !['127.0.0.1', 'localhost'].includes(new URL(req.url()).hostname)) external.push(new URL(req.url()).origin) })
  await page.goto(url('playground'))
  await json(await context.request.post(`${url('playground')}/api/auth/login`, { data: { username: user, password } }))
  const b = resume ? report.jobs[1] : await page.evaluate(async ({ dataUrl }) => {
    const client = await import('/src/lib/gardenImageApi.ts')
    return client.submitJob({ prompt: '保持参考图的庭院布局，呈现自然午后光线的写实花园照片。', params: { n: 1, size: 'auto', quality: 'auto', output_format: 'png' }, taskId: crypto.randomUUID(), inputImageDataUrls: [dataUrl] })
  }, { dataUrl: `data:${mime};base64,${reference.toString('base64')}` })
  if (!resume) report.jobs.push({ job_id: b.job_id, job_type: 'generic', status: b.status })
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  const completed = await waitJob(context.request, `${url('playground')}/api/image-jobs`, b.job_id)
  Object.assign(report.jobs[1], { status: completed.status, error_code: completed.error_code })
  assert.equal(completed.status, 'succeeded', `Playground 任务失败：${completed.error_code}`)
  const images = await page.evaluate(async (job) => {
    const client = await import('/src/lib/gardenImageApi.ts')
    return (await client.getJobResult(job)).images
  }, completed)
  assert.equal(images.length, 1)
  await writeFile(path.join(output, 'playground.png'), Buffer.from(images[0].split(',')[1], 'base64'))
  assert.deepEqual(external, [], 'Playground 浏览器出现外部提交')
  report.checks.playground_external_mutations = external.length
  const records = await json(await admin.get('/api/admin/ai-jobs?scope=today'))
  for (const job of report.jobs) {
    const row = records.items.find((r) => r.job_id === job.job_id && r.job_type === job.job_type)
    assert(row && row.status === 'succeeded' && row.provider !== 'fake')
    assert.equal(row.provider_vendor_name, active.display_name)
    const result = await admin.get(`/api/admin/ai-jobs/${row.job_id}/result?job_type=${row.job_type}&index=0`)
    assert(result.ok())
    const bytes = await result.body()
    if (job.job_type === 'generic') assert.equal(Buffer.compare(bytes, await readFile(path.join(output, 'playground.png'))), 0)
    await writeFile(path.join(output, `${row.job_type}.png`), bytes)
    Object.assign(job, { source_app: row.source_app, provider: row.provider, provider_name: row.provider_vendor_name, channel: row.provider_channel, model: row.provider_model, duration_ms: row.duration_ms, attempts: row.provider_attempts.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    const filtered = await json(await admin.get(`/api/admin/ai-jobs?source_app=${row.source_app}`))
    assert.equal(filtered.total, 1)
    assert.equal(filtered.items[0].job_id, job.job_id)
  }
  await page.goto(`${url('admin')}/admin/`)
  await page.getByLabel('账号').fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '进入后台' }).click()
  await page.getByRole('button', { name: '生图记录', exact: true }).click()
  for (const job of report.jobs) await expect(page.locator(`tr[data-job-id="${job.job_id}"] .aijt-status`)).toHaveText('成功')
  await expect(async () => assert(await page.locator('.aijt-thumb').evaluateAll((imgs) => imgs.length === 2 && imgs.every((img) => img.complete && img.naturalWidth > 0)))).toPass({ timeout: 15000 })
  await page.screenshot({ path: path.join(output, 'admin-records.png'), fullPage: true })
  report.checks.admin_preview = true
  report.checks.playground_result_matches_admin = true
  report.verification_mode = resume ? 'existing-jobs' : 'submit-and-verify'
  report.checks.config_unchanged = Buffer.compare(configBytes, await readFile(configPath)) === 0
  assert(report.checks.config_unchanged)
  report.status = 'passed'
  console.log('两个任务、Playground 客户端及 Garden 后台记录验证通过')
} catch (err) {
  report.status = 'failed'
  report.error = err.message
  console.error(err.message)
  process.exitCode = 1
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  await browser?.close()
  await Promise.all(contexts.map((ctx) => ctx.dispose()))
  for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGTERM')
}

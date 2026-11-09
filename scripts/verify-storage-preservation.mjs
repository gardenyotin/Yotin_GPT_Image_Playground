#!/usr/bin/env node
// Local-only browser QA: seeds a populated v3 IndexedDB in a fresh context.
// Uses an existing Playwright install; never opens a user's browser profile.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const base = process.env.STORAGE_QA_URL || 'http://127.0.0.1:5743'
const target = new URL(base)
assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'QA URL must be loopback')
const artifactDir = path.resolve(process.env.STORAGE_QA_ARTIFACTS || `/tmp/playground-storage-qa-${Date.now()}`)
await fs.mkdir(artifactDir, { recursive: true })
const playwrightPath = process.env.PLAYWRIGHT_MODULE || '/home/yotin/Garden-Design-Calculator/src/frontend/node_modules/playwright/index.mjs'
const { chromium } = await import(pathToFileURL(playwrightPath))
const browser = await chromium.launch({ headless: true })
const report = { base, started: new Date().toISOString(), scenarios: [], requests: [], errors: [], consoleErrors: [], status: 'running' }

async function makeContext() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue()
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      report.requests.push({ url: req.url(), method: req.method(), action: 'blocked-external' })
      return route.abort('blockedbyclient')
    }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      report.requests.push({ url: req.url(), method: req.method(), action: 'blocked-mutation' })
      return route.abort('blockedbyclient')
    }
    if (url.pathname === '/__storage_seed__') return route.fulfill({ contentType: 'text/html', body: '<html><body>Isolated v3 fixture</body></html>' })
    if (url.pathname === '/api/runtime-config') return route.fulfill({ json: { model: 'gpt-image-2', streamImages: true, streamPartialImages: 1 } })
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { items: [], total: 0 } })
    return route.continue()
  })
  await ctx.addInitScript(() => {
    window.__storageEvents = []
    const original = indexedDB.open.bind(indexedDB)
    indexedDB.open = (...args) => {
      const req = original(...args)
      req.addEventListener('blocked', () => window.__storageEvents.push({ type: 'blocked', args }))
      req.addEventListener('upgradeneeded', (e) => window.__storageEvents.push({ type: 'upgrade', old: e.oldVersion, next: e.newVersion }))
      return req
    }
  })
  ctx.on('page', (page) => {
    page.on('pageerror', (err) => report.errors.push(String(err)))
    page.on('console', (msg) => {
      if (msg.type() === 'error') report.consoleErrors.push(msg.text().slice(0, 1000))
    })
  })
  return ctx
}

async function seed(page, { mixed = false, hold = false } = {}) {
  await page.goto(`${base}/__storage_seed__`)
  return page.evaluate(async ({ mixed, hold }) => {
    const req = indexedDB.open('gpt-image-playground', 3)
    req.onupgradeneeded = () => {
      for (const name of ['tasks', 'images', 'thumbnails', 'agentConversations']) req.result.createObjectStore(name, { keyPath: 'id' })
    }
    const db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
    const names = ['reference', 'output-a', 'output-b', 'orphan', 'draft', 'agent', 'mask', 'transparent-original']
    const rows = names.map((id, i) => {
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 6
      const c = canvas.getContext('2d'); c.fillStyle = `rgb(${20 + i * 25},${180 - i * 13},${40 + i * 17})`; c.fillRect(0, 0, 8, 6)
      c.fillStyle = '#ffffff'; c.fillRect(i % 8, 0, 1, 6)
      return { id, dataUrl: canvas.toDataURL('image/png'), width: 8, height: 6, createdAt: 1700000000000 + i, source: id.startsWith('output') ? 'generated' : 'upload' }
    })
    const params = { size: 'auto', quality: 'high', output_format: 'png', output_compression: null, moderation: 'auto', n: 1, transparent_output: false }
    const tasks = ['a', 'b'].map((suffix, i) => ({
      id: `task-${suffix}`, prompt: `旧任务保留 ${suffix} 庭院参考图`, params, apiProvider: 'openai', apiProfileId: 'qa-profile', apiProfileName: '隔离旧配置', apiModel: 'gpt-image-2', apiMode: 'images',
      inputImageIds: ['reference'], outputImages: [`output-${suffix}`], status: 'done', error: null, createdAt: 1700000000100 + i, finishedAt: 1700000000200 + i, elapsed: 100,
      isFavorite: true, favoriteCollectionIds: ['qa-favorites'], sourceMode: i ? 'agent' : 'gallery',
      ...(i ? { agentConversationId: 'conversation-1', agentRoundId: 'round-1', agentMessageId: 'assistant-1' } : { maskTargetImageId: 'reference', maskImageId: 'mask', transparentOriginalImages: ['transparent-original'] }),
    }))
    const conversation = {
      id: 'conversation-1', title: '旧会话保留', activeRoundId: 'round-1', createdAt: 1700000000000, updatedAt: 1700000000200,
      rounds: [{ id: 'round-1', index: 1, parentRoundId: null, userMessageId: 'user-1', assistantMessageId: 'assistant-1', prompt: '保留参考图及作品', inputImageIds: ['agent'], outputTaskIds: ['task-b'], status: 'done', error: null, createdAt: 1700000000100, finishedAt: 1700000000200 }],
      messages: [{ id: 'user-1', role: 'user', roundId: 'round-1', content: '保留参考图及作品', inputImageIds: ['agent'], createdAt: 1700000000100 }, { id: 'assistant-1', role: 'assistant', roundId: 'round-1', content: '历史结果', outputTaskIds: ['task-b'], createdAt: 1700000000200 }],
    }
    const profile = { id: 'qa-profile', name: '隔离旧配置', provider: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'qa-not-a-real-key', model: 'gpt-image-2', timeout: 300, apiMode: 'images', codexCli: false, apiProxy: true }
    const persisted = {
      version: 2, state: { settings: { ...profile, profiles: [profile], activeProfileId: profile.id, customProviders: [], clearInputAfterSubmit: false, persistInputOnRestart: true, allowPromptRewrite: false, enterSubmit: false, taskCompletionNotification: false }, params,
        appMode: 'gallery', prompt: '未提交的旧提示词', inputImages: [{ id: 'draft', dataUrl: '' }], galleryInputDraft: { prompt: '未提交的旧提示词', inputImages: [{ id: 'draft', dataUrl: '' }], maskDraft: null, maskEditorImageId: null, updatedAt: 1700000000000 },
        agentConversations: [], activeAgentConversationId: 'conversation-1', agentInputDrafts: {},
        favoriteCollections: [{ id: 'qa-favorites', name: '历史精选', createdAt: 1700000000000, updatedAt: 1700000000000 }], defaultFavoriteCollectionId: 'qa-favorites', dismissedCodexCliPrompts: [], supportPromptDismissed: true, supportPromptSkippedForImportedData: true,
      },
    }
    localStorage.setItem('gpt-image-playground', JSON.stringify(persisted))
    localStorage.setItem('ai-company-gallery-identity', JSON.stringify({ id: 'qa-employee', nickname: '旧员工', avatar: '🌳' }))
    localStorage.setItem('ai-company-gallery-archived-images', JSON.stringify(['output-a', 'output-b']))
    const toBlob = (url) => { const [header, data] = url.split(','); return new Blob([Uint8Array.from(atob(data), (s) => s.charCodeAt(0))], { type: header.slice(5).split(';')[0] }) }
    const tx = db.transaction(['tasks', 'images', 'thumbnails', 'agentConversations'], 'readwrite')
    for (const task of tasks) tx.objectStore('tasks').put(task)
    tx.objectStore('agentConversations').put(conversation)
    for (const row of rows) {
      const asBlob = mixed && row.id === 'output-b'
      const { dataUrl, ...meta } = row
      tx.objectStore('images').put(asBlob ? { ...meta, blob: toBlob(dataUrl) } : row)
      tx.objectStore('thumbnails').put({ id: row.id, ...(asBlob ? { blob: toBlob(dataUrl) } : { thumbnailDataUrl: dataUrl }), width: 8, height: 6, thumbnailVersion: 2 })
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error) })
    if (hold) window.__heldV3 = db
    else db.close()
    return { rows, tasks, conversation, persisted, mixed }
  }, { mixed, hold })
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const req = indexedDB.open('gpt-image-playground')
    const db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
    const names = [...db.objectStoreNames]
    const rows = {}
    for (const name of names) {
      const tx = db.transaction(name, 'readonly'); const r = tx.objectStore(name).getAll()
      rows[name] = await new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    }
    const version = db.version
    const indexes = [...db.transaction('thumbnails').objectStore('thumbnails').indexNames]
    db.close()
    const normalize = async (record, field) => {
      const url = record[field] ?? (record.blob ? await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(record.blob) }) : null)
      const bytes = url ? Uint8Array.from(atob(url.split(',')[1]), (s) => s.charCodeAt(0)) : new Uint8Array()
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const { blob, ...rest } = record
      return { ...rest, [field]: url, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''), storage: blob ? 'blob' : 'string' }
    }
    rows.images = await Promise.all(rows.images.map((r) => normalize(r, 'dataUrl')))
    rows.thumbnails = await Promise.all(rows.thumbnails.map((r) => normalize(r, 'thumbnailDataUrl')))
    return { version, indexes, rows, localStorage: Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])), renderedImages: [...document.images].map((img) => ({ srcType: img.src.split(':')[0], loaded: img.complete && img.naturalWidth > 0, width: img.naturalWidth })) }
  })
}

function verify(fixture, before, after) {
  assert.equal(after.version, 4)
  assert.deepEqual(Object.keys(after.rows).sort(), ['agentConversations', 'images', 'tasks', 'thumbnails'])
  assert(after.indexes.includes('thumbnailVersion'))
  for (const store of Object.keys(before.rows)) {
    assert.equal(after.rows[store].length, before.rows[store].length, `${store}: count preserved`)
    assert.deepEqual(after.rows[store].map((r) => r.id).sort(), before.rows[store].map((r) => r.id).sort(), `${store}: IDs preserved`)
  }
  for (const store of ['images', 'thumbnails']) for (const old of before.rows[store]) {
    const current = after.rows[store].find((r) => r.id === old.id)
    assert.deepEqual(current, old, `${store}/${old.id}: data URL, bytes SHA, metadata and storage format preserved`)
  }
  for (const old of fixture.tasks) {
    const current = after.rows.tasks.find((r) => r.id === old.id)
    for (const key of Object.keys(old)) assert.deepEqual(current[key], old[key], `task/${old.id}/${key}`)
  }
  const conversation = after.rows.agentConversations.find((r) => r.id === fixture.conversation.id)
  assert.equal(conversation.title, fixture.conversation.title)
  assert.deepEqual(conversation.rounds[0].inputImageIds, ['agent'])
  assert.deepEqual(conversation.rounds[0].outputTaskIds, ['task-b'])
  for (const key of ['ai-company-gallery-identity', 'ai-company-gallery-archived-images']) assert.equal(after.localStorage[key], before.localStorage[key], key)
  const state = JSON.parse(after.localStorage['gpt-image-playground']).state
  assert(state.favoriteCollections.some((c) => c.id === 'qa-favorites' && c.name === '历史精选'))
  assert.equal(state.defaultFavoriteCollectionId, 'qa-favorites')
  for (const key of ['clearInputAfterSubmit', 'persistInputOnRestart', 'allowPromptRewrite', 'enterSubmit']) assert.equal(state.settings[key], fixture.persisted.state.settings[key], `settings/${key}`)
  assert(!after.localStorage['gpt-image-playground:image-blob-migrated'], 'automatic Blob migration must stay disabled')
  assert(after.renderedImages.some((img) => img.loaded), 'actual application renders stored images')
}

try {
  for (const mixed of [false, true]) {
    const ctx = await makeContext(); const page = await ctx.newPage()
    const fixture = await seed(page, { mixed }); const before = await snapshot(page)
    await fs.writeFile(path.join(artifactDir, `fixture-${mixed ? 'mixed' : 'legacy'}.json`), JSON.stringify({ fixture, before }, null, 2))
    await page.goto(base)
    await page.waitForTimeout(2500)
    await page.screenshot({path:path.join(artifactDir,'startup.png'),fullPage:true})
    await fs.writeFile(path.join(artifactDir,'startup.json'),JSON.stringify({body:await page.locator('body').innerText(),events:await page.evaluate(()=>window.__storageEvents)},null,2))
    await page.waitForFunction(() => document.body.innerText.includes('旧任务保留'), null, { timeout: 15000 })
    await page.waitForTimeout(5500)
    const after = await snapshot(page)
    await fs.writeFile(path.join(artifactDir, `latest-snapshot.json`), JSON.stringify({after,body:await page.locator('body').innerText(),events:await page.evaluate(()=>window.__storageEvents)},null,2))
    await page.screenshot({path:path.join(artifactDir,'latest.png'),fullPage:true})
    verify(fixture, before, after)
    await page.screenshot({ path: path.join(artifactDir, `${mixed ? 'mixed' : 'legacy'}-first.png`), fullPage: true })
    await page.reload(); await page.waitForTimeout(3500)
    const refreshed = await snapshot(page); verify(fixture, before, refreshed)
    await page.screenshot({ path: path.join(artifactDir, `${mixed ? 'mixed' : 'legacy'}-refresh.png`), fullPage: true })
    const writeCheck = await page.evaluate(async ({ sample }) => {
      const db = await import('/src/lib/db.ts')
      const image = { ...sample, id: 'qa-new-string-write' }
      await db.putImage(image)
      await db.putImageThumbnail({ id: image.id, thumbnailDataUrl: image.dataUrl, width: 8, height: 6, thumbnailVersion: 2 })
      const restored = await db.getImage(image.id)
      return { readable: restored?.dataUrl === image.dataUrl }
    }, { sample: fixture.rows[0] })
    assert(writeCheck.readable, 'application DB API reads new image')
    const afterWrite = await snapshot(page)
    for (const store of ['images', 'thumbnails']) assert.equal(afterWrite.rows[store].find((r) => r.id === 'qa-new-string-write').storage, 'string', 'new writes remain strings')
    report.scenarios.push({ name: mixed ? 'mixed-blob-read' : 'legacy-v3-to-v4', before, after, refreshed, newWrite: { readable: writeCheck.readable, images: afterWrite.rows.images.find((r) => r.id === 'qa-new-string-write'), thumbnails: afterWrite.rows.thumbnails.find((r) => r.id === 'qa-new-string-write') }, status: 'pass' })
    await ctx.close()
  }
  const ctx = await makeContext(); const holder = await ctx.newPage()
  const fixture = await seed(holder, { hold: true }); const before = await snapshot(holder)
  const page = await ctx.newPage(); await page.goto(base)
  await page.waitForFunction(() => window.__storageEvents.some((e) => e.type === 'blocked'), null, { timeout: 15000 })
  const blockedEvents = await page.evaluate(() => window.__storageEvents)
  await page.screenshot({ path: path.join(artifactDir, 'upgrade-blocked.png'), fullPage: true })
  await holder.close(); await page.waitForTimeout(5000)
  const after = await snapshot(page); verify(fixture, before, after)
  await page.screenshot({ path: path.join(artifactDir, 'upgrade-unblocked.png'), fullPage: true })
  report.scenarios.push({ name: 'old-tab-blocks-until-closed', blockedEvents, before, after, status: 'pass' })
  await ctx.close()
  assert(!report.requests.some((r) => r.action === 'blocked-mutation'), 'application attempted a mutation during storage-only QA')
  assert.equal(report.errors.length, 0, 'no browser errors')
  report.status = 'pass'
} catch (err) {
  report.status = 'failed'; report.failure = err.stack || String(err)
  process.exitCode = 1
} finally {
  report.finished = new Date().toISOString()
  await fs.writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(JSON.stringify({ status: report.status, artifacts: artifactDir, scenarios: report.scenarios.map((s) => ({ name: s.name, status: s.status, counts: Object.fromEntries(Object.entries(s.after.rows).map(([k, v]) => [k, v.length])) })), failure: report.failure, blockedRequests: report.requests.length }, null, 2))
}

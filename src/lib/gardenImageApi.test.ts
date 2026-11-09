import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultGardenProfile, normalizeSettings } from './apiProfiles'
import { callGardenImageApi, cancelJob, getJobStatus, submitJob } from './gardenImageApi'

const caps = { provider: 'fake', supports_image_input: true, supports_multi_image_input: true, max_total_input_images: 3, max_input_images_per_job: 3, max_output_images_per_job: 4 }
const profile = createDefaultGardenProfile()
const opts = { settings: normalizeSettings({}), prompt: '原文\n一只猫', params: { ...DEFAULT_PARAMS, n: 2 }, taskId: 'local-task', inputImageDataUrls: ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='] }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('Garden 通用生图客户端', () => {
  it('没有 randomUUID 的 HTTP 环境仍能生成有效幂等键并提交', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    const fetch = vi.fn().mockResolvedValueOnce(json(caps)).mockResolvedValueOnce(json({ job_id: 'http-job' }, 202))
    vi.stubGlobal('fetch', fetch)
    expect((await submitJob({ ...opts, taskId: undefined })).job_id).toBe('http-job')
    expect(fetch.mock.calls[1][1].body.get('client_request_id')).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('上传原文与有序参考图，持久化任务 ID 并按索引取多张图片', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(caps)).mockResolvedValueOnce(json({ job_id: 'job', status: 'queued' }, 202))
      .mockResolvedValueOnce(json({ job_id: 'job', status: 'running' }))
      .mockResolvedValueOnce(json({ job_id: 'job', status: 'succeeded', result_assets_json: [{ index: 1 }, { index: 0 }] }))
      .mockImplementation(async () => new Response('png', { headers: { 'Content-Type': 'image/png' } }))
    vi.stubGlobal('fetch', fetch)
    const enqueued = vi.fn()
    const result = await callGardenImageApi({ ...opts, onCustomTaskEnqueued: enqueued }, profile, { sleep: async () => {} })
    const body = fetch.mock.calls[1][1].body as FormData
    expect(body.get('prompt')).toBe(opts.prompt)
    expect(body.get('source_app')).toBe('playground')
    expect(body.get('client_request_id')).toBe('local-task')
    expect(JSON.parse(body.get('params') as string).n).toBe(2)
    expect(await Promise.all(body.getAll('image').map((f) => (f as File).text()))).toEqual(['a', 'b'])
    expect(fetch.mock.calls.every(([, init]) => init.credentials === 'include')).toBe(true)
    expect(fetch.mock.calls[1][1].headers).not.toHaveProperty('Content-Type')
    expect(enqueued).toHaveBeenCalledWith({ taskId: 'job' })
    expect(result.images).toHaveLength(2)
    expect(fetch.mock.calls.slice(-2).map(([url]) => url)).toEqual(['/api/image-jobs/job/results/0', '/api/image-jobs/job/results/1'])
  })

  it.each([
    [{ supports_image_input: false }, '不支持参考'],
    [{ supports_multi_image_input: false }, '不支持多张'],
    [{ max_input_images_per_job: 1 }, '最多支持'],
    [{ max_output_images_per_job: 1 }, '图片数量'],
  ])('能力不支持时禁止提交 %j', async (patch, message) => {
    const fetch = vi.fn().mockResolvedValue(json({ ...caps, ...patch }))
    vi.stubGlobal('fetch', fetch)
    await expect(submitJob(opts)).rejects.toThrow(message)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([['failed', '供应商失败'], ['cancelled', '已取消'], ['strange', '未知状态']])('终态/未知状态报错 %s', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(caps)).mockResolvedValueOnce(json({ job_id: 'job' })).mockResolvedValue(json({ job_id: 'job', status, error_message: '供应商失败' })))
    await expect(callGardenImageApi(opts, profile)).rejects.toThrow(message)
  })

  it('相同幂等键可重放 200，不生成新键', async () => {
    const fetch = vi.fn().mockImplementation(async (url) => json(url.endsWith('image-capabilities') ? caps : { job_id: 'existing', status: 'running' }))
    vi.stubGlobal('fetch', fetch)
    expect((await submitJob(opts)).job_id).toBe('existing')
    expect((await submitJob(opts)).job_id).toBe('existing')
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('image-jobs')).map(([, init]) => init.body.get('client_request_id'))).toEqual(['local-task', 'local-task'])
  })

  it('未登录或服务不可用时直接显示错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ detail: '请登录' }, 401)))
    await expect(getJobStatus('job')).rejects.toThrow('请登录')
  })

  it('取消使用同源身份与任务路由', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ cancelled: true }))
    vi.stubGlobal('fetch', fetch)
    expect(await cancelJob('job')).toEqual({ cancelled: true })
    expect(fetch.mock.calls[0][0]).toBe('/api/image-jobs/job/cancel')
    expect(fetch.mock.calls[0][1].method).toBe('POST')
  })
})

it('恢复未知提交时绕过新供应商能力门槛，以原幂等键由服务端重放', async () => {
  const fetch = vi.fn().mockResolvedValue(json({ job_id: 'original-job', status: 'running' }))
  vi.stubGlobal('fetch', fetch)
  expect((await submitJob({ ...opts, resumeRequest: true })).job_id).toBe('original-job')
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][1].body.get('client_request_id')).toBe(opts.taskId)
})

it('轮询超时立即结束等待且保留已排队任务的 ID', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn().mockResolvedValueOnce(json(caps)).mockResolvedValueOnce(json({ job_id: 'pending' }))
    .mockResolvedValue(json({ job_id: 'pending', status: 'running' }))
  vi.stubGlobal('fetch', fetch)
  const enqueued = vi.fn()
  try {
    const result = callGardenImageApi({ ...opts, onCustomTaskEnqueued: enqueued }, { ...profile, timeout: 0.1 }).catch((err) => err)
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(enqueued).toHaveBeenCalledWith({ taskId: 'pending' })
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('image-jobs'))).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
})

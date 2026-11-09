import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type AppSettings } from '../types'
import { callGardenImageApi, GARDEN_SCHEME_ID } from './gardenImageApi'
import type { CallApiOptions } from './imageApiShared'
import { createDefaultGardenProfile, DEFAULT_SETTINGS } from './apiProfiles'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function pngResponse(): Response {
  return new Response(PNG_BYTES, {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  })
}

function gardenSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    profiles: [createDefaultGardenProfile()],
  }
}

function baseOptions(overrides: Partial<CallApiOptions> = {}): CallApiOptions {
  return {
    settings: gardenSettings(),
    prompt: 'a small red house',
    params: { ...DEFAULT_PARAMS },
    inputImageDataUrls: [],
    ...overrides,
  }
}

describe('callGardenImageApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('submits a generation, polls the job and fetches the result image', async () => {
    const enqueued: string[] = []
    let pollCount = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith(`/schemes/${GARDEN_SCHEME_ID}/ai-generations`) ) {
        return jsonResponse(202, { job_id: 'job-1', status: 'queued' })
      }
      if (url.endsWith('/ai-generations/job-1')) {
        pollCount += 1
        return pollCount === 1
          ? jsonResponse(200, { job_id: 'job-1', status: 'running' })
          : jsonResponse(200, { job_id: 'job-1', status: 'succeeded', result_asset_id: 'asset-1' })
      }
      if (url.endsWith('/media/asset-1/content')) return pngResponse()
      throw new Error(`unexpected fetch: ${url}`)
    })

    const result = await callGardenImageApi(baseOptions({
      taskId: 'task-42',
      onCustomTaskEnqueued: (request) => { enqueued.push(request.taskId) },
    }), createDefaultGardenProfile(), { sleep: async () => {} })

    expect(enqueued).toEqual(['job-1'])
    expect(result.images).toHaveLength(1)
    expect(result.images[0].startsWith('data:image/png;base64,')).toBe(true)

    const submitCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/ai-generations'))
    expect(submitCall).toBeDefined()
    const [submitUrl, submitInit] = submitCall!
    expect(String(submitUrl)).toBe(`/api/schemes/${GARDEN_SCHEME_ID}/ai-generations`)
    expect((submitInit as RequestInit).method).toBe('POST')
    expect((submitInit as RequestInit).credentials).toBe('include')
    const body = JSON.parse(String((submitInit as RequestInit).body))
    expect(body.scheme_revision_id).toBe('playground-rev-1')
    expect(body.preset_key).toBe('noon')
    expect(body.client_request_id).toBe('task-42')
    expect(body.camera_snapshot.prompt).toBe('a small red house')
    expect(body.camera_snapshot.size).toBe(DEFAULT_PARAMS.size)
  })

  it('falls back to a random client_request_id when taskId is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/ai-generations')) return jsonResponse(202, { job_id: 'job-2' })
      if (url.endsWith('/ai-generations/job-2')) return jsonResponse(200, { job_id: 'job-2', status: 'succeeded', result_asset_id: 'asset-2' })
      if (url.endsWith('/media/asset-2/content')) return pngResponse()
      throw new Error(`unexpected fetch: ${url}`)
    })

    await callGardenImageApi(baseOptions(), createDefaultGardenProfile(), { sleep: async () => {} })

    const submitCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/ai-generations'))
    const body = JSON.parse(String((submitCall![1] as RequestInit).body))
    expect(body.client_request_id.length).toBeGreaterThan(0)
    expect(body.client_request_id.length).toBeLessThanOrEqual(64)
  })

  it('throws the job error_message when the job fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/ai-generations')) return jsonResponse(202, { job_id: 'job-3' })
      if (url.endsWith('/ai-generations/job-3')) {
        return jsonResponse(200, { job_id: 'job-3', status: 'failed', error_code: 'provider_error', error_message: '上游服务出错' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    await expect(
      callGardenImageApi(baseOptions(), createDefaultGardenProfile(), { sleep: async () => {} }),
    ).rejects.toThrow('上游服务出错')
  })

  it('throws when the job is cancelled', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/ai-generations')) return jsonResponse(202, { job_id: 'job-4' })
      if (url.endsWith('/ai-generations/job-4')) return jsonResponse(200, { job_id: 'job-4', status: 'cancelled' })
      throw new Error(`unexpected fetch: ${url}`)
    })

    await expect(
      callGardenImageApi(baseOptions(), createDefaultGardenProfile(), { sleep: async () => {} }),
    ).rejects.toThrow('已取消')
  })

  it('throws a readable error when submit is rejected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(422, { detail: '缺少字段：preset_key' }))

    await expect(
      callGardenImageApi(baseOptions(), createDefaultGardenProfile(), { sleep: async () => {} }),
    ).rejects.toThrow('缺少字段：preset_key')
  })

  it('throws when the submit response has no job_id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(202, { status: 'queued' }))

    await expect(
      callGardenImageApi(baseOptions(), createDefaultGardenProfile(), { sleep: async () => {} }),
    ).rejects.toThrow('job_id')
  })

  it('throws when a succeeded job has no result_asset_id', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/ai-generations')) return jsonResponse(202, { job_id: 'job-5' })
      if (url.endsWith('/ai-generations/job-5')) return jsonResponse(200, { job_id: 'job-5', status: 'succeeded' })
      throw new Error(`unexpected fetch: ${url}`)
    })

    await expect(
      callGardenImageApi(baseOptions(), createDefaultGardenProfile(), { sleep: async () => {} }),
    ).rejects.toThrow('result_asset_id')
  })
})

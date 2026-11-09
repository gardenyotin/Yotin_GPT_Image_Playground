import type { ApiProfile } from '../types'
import { blobToDataUrl } from './dataUrl'
import { readRuntimeEnv } from './runtimeEnv'
import {
  createRequestTimeoutError,
  getApiErrorMessage,
  pickActualParams,
  type CallApiOptions,
  type CallApiResult,
} from './imageApiShared'

const GARDEN_API_PREFIX = readRuntimeEnv(import.meta.env.VITE_GARDEN_API_PREFIX) || '/api'
/** 占位 scheme，真实接入时需由 Garden 侧分配 */
export const GARDEN_SCHEME_ID = 'playground'
const GARDEN_SCHEME_REVISION_ID = 'playground-rev-1'
const GARDEN_PRESET_KEY = 'noon'

const POLL_INITIAL_DELAY_MS = 1000
const POLL_MAX_DELAY_MS = 5000
const POLL_BACKOFF_FACTOR = 1.5

const GARDEN_RUNNING_STATUSES = new Set(['queued', 'running', 'retry_wait'])

interface GardenJob {
  job_id?: unknown
  status?: unknown
  error_code?: unknown
  error_message?: unknown
  result_asset_id?: unknown
}

export interface GardenCallOverrides {
  /** 测试注入用：覆盖轮询间隔的 sleep 实现 */
  sleep?: (ms: number) => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function gardenFetch(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return fetch(`${GARDEN_API_PREFIX}${path}`, {
    cache: 'no-store',
    credentials: 'include',
    signal,
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
}

async function submitGardenGeneration(opts: CallApiOptions, signal: AbortSignal): Promise<string> {
  const clientRequestId = (opts.taskId ?? randomRequestId()).slice(0, 64)
  const cameraSnapshot = { prompt: opts.prompt, ...opts.params }
  const response = await gardenFetch(
    `/schemes/${encodeURIComponent(GARDEN_SCHEME_ID)}/ai-generations`,
    {
      method: 'POST',
      body: JSON.stringify({
        scheme_revision_id: GARDEN_SCHEME_REVISION_ID,
        preset_key: GARDEN_PRESET_KEY,
        client_request_id: clientRequestId,
        camera_snapshot: cameraSnapshot,
      }),
    },
    signal,
  )
  if (!response.ok) {
    throw new Error(await getApiErrorMessage(response))
  }
  const job = await response.json().catch(() => null)
  const jobId = isRecord(job) ? job.job_id : undefined
  if (typeof jobId !== 'string' || !jobId) {
    throw new Error('Garden 服务未返回有效的 job_id')
  }
  return jobId
}

function getGardenJobError(job: GardenJob): string {
  const message = typeof job.error_message === 'string' && job.error_message.trim()
    ? job.error_message
    : typeof job.error_code === 'string' && job.error_code.trim()
      ? job.error_code
      : 'Garden 任务失败'
  return message
}

async function pollGardenJob(jobId: string, signal: AbortSignal, sleep: (ms: number) => Promise<void>): Promise<string> {
  let delayMs = POLL_INITIAL_DELAY_MS
  for (;;) {
    await sleep(delayMs)
    if (signal.aborted) throw signal.reason

    const response = await gardenFetch(`/ai-generations/${encodeURIComponent(jobId)}`, { method: 'GET' }, signal)
    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }
    const job: GardenJob = await response.json().catch(() => ({}))
    const status = typeof job.status === 'string' ? job.status : ''
    if (status === 'succeeded') {
      const assetId = typeof job.result_asset_id === 'string' ? job.result_asset_id : ''
      if (!assetId) throw new Error('Garden 任务成功但未返回 result_asset_id')
      return assetId
    }
    if (status === 'failed') throw new Error(getGardenJobError(job))
    if (status === 'cancelled') throw new Error('Garden 任务已取消')
    if (!GARDEN_RUNNING_STATUSES.has(status)) {
      throw new Error(`Garden 任务返回未知状态：${status || '（缺失）'}`)
    }
    delayMs = Math.min(POLL_MAX_DELAY_MS, Math.round(delayMs * POLL_BACKOFF_FACTOR))
  }
}

async function fetchGardenImage(assetId: string, signal: AbortSignal): Promise<string> {
  const response = await gardenFetch(`/media/${encodeURIComponent(assetId)}/content`, { method: 'GET' }, signal)
  if (!response.ok) {
    throw new Error(await getApiErrorMessage(response))
  }
  const blob = await response.blob()
  const mime = blob.type.startsWith('image/') ? blob.type : 'image/png'
  return blobToDataUrl(blob, mime)
}

export async function callGardenImageApi(opts: CallApiOptions, profile: ApiProfile, overrides: GardenCallOverrides = {}): Promise<CallApiResult> {
  if (opts.inputImageDataUrls.length) {
    console.warn('Garden 接口本阶段不支持输入图片，已忽略参考图。')
  }
  const sleep = overrides.sleep ?? defaultSleep
  const controller = new AbortController()
  const { signal } = controller
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)
  try {
    const jobId = await submitGardenGeneration(opts, signal)
    opts.onCustomTaskEnqueued?.({ taskId: jobId })
    const assetId = await pollGardenJob(jobId, signal, sleep)
    const image = await fetchGardenImage(assetId, signal)
    return {
      images: [image],
      actualParams: pickActualParams(opts.params),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

import type { ApiProfile } from '../types'
import { base64ToBytes, blobToDataUrl } from './dataUrl'
import { readRuntimeEnv } from './runtimeEnv'
import { createRequestTimeoutError, getApiErrorMessage, type CallApiOptions, type CallApiResult } from './imageApiShared'

const GARDEN_API_PREFIX = (readRuntimeEnv(import.meta.env.VITE_GARDEN_API_PREFIX) || '/api').replace(/\/$/, '')
const RUNNING_STATUSES = new Set(['queued', 'running', 'retry_wait'])

export interface GardenJob {
  job_id: string
  status: string
  params_json?: { n?: number }
  result_assets_json?: Array<{ index: number }>
  error_code?: string | null
  error_message?: string | null
}

export interface GardenCapabilities {
  provider: string
  supports_image_input: boolean
  supports_multi_image_input: boolean
  max_total_input_images: number
  max_input_images_per_job: number
  max_output_images_per_job: number
  supported_params?: string[]
  output_formats?: string[]
}

export interface GardenCallOverrides {
  sleep?: (ms: number) => Promise<void>
}

export class GardenApiError extends Error {
  constructor(message: string, public status: number) {
    super(message)
    this.name = 'GardenApiError'
  }
}

async function gardenFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${GARDEN_API_PREFIX}${path}`, {
    cache: 'no-store',
    credentials: 'include',
    ...init,
    headers: { Accept: 'application/json', ...init.headers },
  })
  if (!response.ok) throw new GardenApiError(await getApiErrorMessage(response), response.status)
  return response
}

export async function getCapabilities(signal?: AbortSignal): Promise<GardenCapabilities> {
  const caps = await (await gardenFetch('/image-capabilities', { signal })).json()
  if (typeof caps?.provider !== 'string' || typeof caps.supports_image_input !== 'boolean'
    || typeof caps.supports_multi_image_input !== 'boolean'
    || [caps.supported_params, caps.output_formats].some((list) => list !== undefined && (!Array.isArray(list) || list.some((value: unknown) => typeof value !== 'string')))
    || !['max_total_input_images', 'max_input_images_per_job', 'max_output_images_per_job'].every((key) => Number.isInteger(caps[key]) && caps[key] >= 0)) {
    throw new Error('Garden 服务返回的能力声明无效')
  }
  return caps
}

export async function submitJob(opts: CallApiOptions, signal?: AbortSignal): Promise<GardenJob> {
  if (!opts.resumeRequest) {
    const caps = await getCapabilities(signal)
    const count = opts.inputImageDataUrls.length
    if (count && !caps.supports_image_input) throw new Error('Garden 当前供应商不支持参考图片，无法提交图片编辑任务')
    if (count > 1 && !caps.supports_multi_image_input) throw new Error('Garden 当前供应商不支持多张参考图片')
    const max = Math.min(caps.max_total_input_images, caps.max_input_images_per_job)
    if (count > max) throw new Error(`Garden 当前最多支持 ${max} 张参考图片`)
    if (!Number.isInteger(opts.params.n) || opts.params.n < 1 || opts.params.n > caps.max_output_images_per_job) {
      throw new Error(`Garden 单任务图片数量必须为 1..${caps.max_output_images_per_job}`)
    }
  }
  if (opts.nativeTransparentBackground) throw new Error('Garden 当前不支持原生透明背景，请使用本地后处理')
  if (opts.maskDataUrl) throw new Error('Garden 当前不支持蒙版编辑')
  const id = opts.taskId ?? crypto.randomUUID()
  if (!id || id.length > 64) throw new Error('Garden 请求标识必须为 1..64 字符')
  const body = new FormData()
  body.set('client_request_id', id)
  body.set('source_app', 'playground')
  body.set('prompt', opts.prompt)
  // 透明背景由本地后处理实现，不作为供应商参数发送。
  body.set('params', JSON.stringify({ ...opts.params, transparent_output: false }))
  for (const [idx, url] of opts.inputImageDataUrls.entries()) {
    const match = url.match(/^data:(image\/[\w.+-]+);base64,(.*)$/s)
    if (!match) throw new Error('参考图片必须为有效的图片 data URL')
    const bytes = base64ToBytes(match[2])
    body.append('image', new Blob([new Uint8Array(bytes)], { type: match[1] }), `reference-${idx + 1}`)
  }
  const job = await (await gardenFetch('/image-jobs', { method: 'POST', body, signal })).json()
  if (typeof job?.job_id !== 'string' || !job.job_id) throw new Error('Garden 服务未返回有效的 job_id')
  return job
}

export async function getJobStatus(jobId: string, signal?: AbortSignal): Promise<GardenJob> {
  const job = await (await gardenFetch(`/image-jobs/${encodeURIComponent(jobId)}`, { signal })).json()
  if (typeof job?.status !== 'string' || job.job_id !== jobId) throw new Error('Garden 服务返回的任务状态无效')
  return job
}

export async function getJobResult(job: GardenJob, signal?: AbortSignal): Promise<CallApiResult> {
  if (job.status !== 'succeeded') throw new Error(job.error_message || job.error_code || 'Garden 任务尚未成功')
  const entries = job.result_assets_json
  if (!Array.isArray(entries) || !entries.length
    || entries.some((e) => !Number.isInteger(e?.index) || e.index < 0)
    || [...entries].sort((a, b) => a.index - b.index).some((e, idx) => e.index !== idx)
    || (job.params_json?.n !== undefined && entries.length !== job.params_json.n)) throw new Error('Garden 任务成功但结果清单无效')
  const images = await Promise.all([...entries].sort((a, b) => a.index - b.index).map(async (entry) => {
    const response = await gardenFetch(`/image-jobs/${encodeURIComponent(job.job_id)}/results/${entry.index}`, { signal })
    const blob = await response.blob()
    if (!blob.type.startsWith('image/')) throw new Error('Garden 结果不是有效的图片')
    return blobToDataUrl(blob)
  }))
  return { images }
}

export async function cancelJob(jobId: string, signal?: AbortSignal): Promise<{ cancelled: boolean }> {
  return (await gardenFetch(`/image-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', signal })).json()
}

export async function waitForJob(jobId: string, signal: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<CallApiResult> {
  let delay = 1000
  for (;;) {
    signal.throwIfAborted()
    const job = await getJobStatus(jobId, signal)
    if (job.status === 'succeeded') return getJobResult(job, signal)
    if (job.status === 'failed') throw new Error(job.error_message || job.error_code || 'Garden 任务失败')
    if (job.status === 'cancelled') throw new Error('Garden 任务已取消')
    if (!RUNNING_STATUSES.has(job.status)) throw new Error(`Garden 任务返回未知状态：${job.status}`)
    if (sleep) await sleep(delay)
    else await new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, delay)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })
    delay = Math.min(5000, Math.round(delay * 1.5))
  }
}

export async function callGardenImageApi(opts: CallApiOptions, profile: ApiProfile, overrides: GardenCallOverrides = {}): Promise<CallApiResult> {
  const controller = new AbortController()
  const abort = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', abort, { once: true })
  if (opts.signal?.aborted) abort()
  const timeout = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)
  try {
    const job = await submitJob(opts, controller.signal)
    await opts.onCustomTaskEnqueued?.({ taskId: job.job_id })
    return await waitForJob(job.job_id, controller.signal, overrides.sleep)
  } finally {
    clearTimeout(timeout)
    opts.signal?.removeEventListener('abort', abort)
  }
}

import type { TaskRecord } from '../types'
import { getImage } from './db'

export interface CompanyIdentity {
  id: string
  nickname: string
  avatar: string
}

export interface CompanyGalleryItem {
  id: string
  user_id: string
  nickname_snapshot: string
  avatar_snapshot: string
  prompt_raw: string
  image_url: string
  thumbnail_url: string
  reference_images: string[]
  created_at: string
  is_featured: boolean
}

const IDENTITY_KEY = 'ai-company-gallery-identity'
const ARCHIVED_KEY = 'ai-company-gallery-archived-images'

export function getCompanyIdentity(): CompanyIdentity | null {
  try {
    const value = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? 'null') as Partial<CompanyIdentity> | null
    if (!value?.id || !value.nickname || !value.avatar) return null
    return { id: value.id, nickname: value.nickname, avatar: value.avatar }
  } catch {
    return null
  }
}

export function saveCompanyIdentity(identity: CompanyIdentity) {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
}

export async function resolveCompanyIdentity(nickname: string, avatar: string, userId?: string) {
  const response = await fetch('/api/users/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, avatar, user_id: userId }),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || '身份设置失败')
  return payload as {
    status: 'created' | 'resolved' | 'ambiguous'
    user?: CompanyIdentity
    candidates?: CompanyIdentity[]
  }
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片读取失败'))
    image.src = dataUrl
  })
}

async function toWebp(dataUrl: string, quality: number, maxEdge?: number, width?: number) {
  const image = await loadImage(dataUrl)
  const scale = width
    ? Math.min(1, width / image.width)
    : maxEdge
      ? Math.min(1, maxEdge / Math.max(image.width, image.height))
      : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持图片处理')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('WebP 编码失败')), 'image/webp', quality)
  })
}

export function getArchivedImageIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(ARCHIVED_KEY) ?? '[]') as string[])
  } catch {
    return new Set<string>()
  }
}

function markArchived(imageId: string) {
  const ids = getArchivedImageIds()
  ids.add(imageId)
  localStorage.setItem(ARCHIVED_KEY, JSON.stringify([...ids].slice(-5000)))
  window.dispatchEvent(new Event('company-gallery-updated'))
}

export async function archiveTaskToCompanyGallery(task: TaskRecord, identity: CompanyIdentity) {
  const archived = getArchivedImageIds()
  const inputImages = (await Promise.all(task.inputImageIds.map((id) => getImage(id))))
    .filter((image): image is NonNullable<typeof image> => Boolean(image))
  const references = await Promise.all(inputImages.map((image) => toWebp(image.dataUrl, 0.82, 2048)))

  for (const outputId of task.outputImages) {
    if (archived.has(outputId)) continue
    const output = await getImage(outputId)
    if (!output) throw new Error('生成图片仍在写入本地存储，稍后自动重试归档')
    const image = await toWebp(output.dataUrl, 0.85)
    const thumbnail = await toWebp(output.dataUrl, 0.75, undefined, 320)
    const form = new FormData()
    form.append('metadata', JSON.stringify({
      user_id: identity.id,
      prompt_raw: task.prompt,
    }))
    form.append('image', image, `${outputId}.webp`)
    form.append('thumbnail', thumbnail, `${outputId}-thumbnail.webp`)
    references.forEach((reference, index) => form.append('references', reference, `${outputId}-reference-${index + 1}.webp`))
    const response = await fetch('/api/gallery', { method: 'POST', body: form })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '公司画廊归档失败')
    markArchived(outputId)
  }
}

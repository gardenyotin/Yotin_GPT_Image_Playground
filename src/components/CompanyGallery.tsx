import { useEffect, useState } from 'react'
import type { CompanyGalleryItem, CompanyIdentity } from '../lib/companyGallery'
import { createInputImageFromFile } from '../store'
import { useStore } from '../store'

interface GalleryUser {
  id: string
  nickname: string
  avatar: string
  generation_count: number
}

interface Props {
  identity: CompanyIdentity
  onReuse: () => void
}

export default function CompanyGallery({ identity, onReuse }: Props) {
  const [items, setItems] = useState<CompanyGalleryItem[]>([])
  const [users, setUsers] = useState<GalleryUser[]>([])
  const [search, setSearch] = useState('')
  const [userId, setUserId] = useState('')
  const [selected, setSelected] = useState<CompanyGalleryItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams({ limit: '100' })
      if (search.trim()) params.set('search', search.trim())
      if (userId) params.set('user_id', userId)
      void fetch(`/api/gallery?${params}`)
        .then((response) => response.json())
        .then((payload) => setItems(payload.items ?? []))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(timer)
  }, [refreshTick, search, userId])

  useEffect(() => {
    const refresh = () => setRefreshTick((value) => value + 1)
    window.addEventListener('company-gallery-updated', refresh)
    return () => window.removeEventListener('company-gallery-updated', refresh)
  }, [])

  useEffect(() => {
    void fetch('/api/users')
      .then((response) => response.json())
      .then((payload) => setUsers(payload.items ?? []))
  }, [])

  const reuse = async (item: CompanyGalleryItem) => {
    const state = useStore.getState()
    state.setPrompt(item.prompt_raw)
    state.clearInputImages()
    for (let index = 0; index < item.reference_images.length; index++) {
      const response = await fetch(item.reference_images[index])
      const blob = await response.blob()
      const image = await createInputImageFromFile(new File([blob], `reference-${index + 1}.webp`, { type: blob.type }))
      if (image) useStore.getState().addInputImage(image)
    }
    state.setAppMode('gallery')
    state.showToast('Prompt 和参考图已载入工作区', 'success')
    onReuse()
  }

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-[#f6f5f2] pb-20 dark:bg-gray-950">
      <div className="safe-area-x mx-auto max-w-7xl">
        <div className="flex flex-col gap-5 py-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 text-sm font-semibold text-violet-600">COMPANY CREATIVE MEMORY</div>
            <h2 className="text-3xl font-black tracking-tight text-gray-900 dark:text-white">公司画廊</h2>
            <p className="mt-2 text-gray-500 dark:text-gray-400">灵感不只被保存，也能被搜索、理解和复用。</p>
          </div>
          <div className="rounded-full border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-gray-300">
            {identity.avatar} {identity.nickname}
          </div>
        </div>
        <div className="mb-7 grid gap-3 rounded-2xl border border-gray-200/80 bg-white p-3 shadow-sm sm:grid-cols-[1fr_220px] dark:border-white/10 dark:bg-white/5">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索 Prompt、主题、风格或关键词…"
            className="rounded-xl bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-violet-500/40 dark:bg-gray-900 dark:text-white"
          />
          <select value={userId} onChange={(event) => setUserId(event.target.value)} className="rounded-xl bg-gray-50 px-4 py-3 outline-none dark:bg-gray-900 dark:text-white">
            <option value="">全部员工</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.avatar} {user.nickname} ({user.generation_count})</option>)}
          </select>
        </div>
        {loading ? (
          <div className="py-20 text-center text-gray-400">正在读取公司灵感库…</div>
        ) : items.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-gray-300 py-20 text-center text-gray-500 dark:border-white/15">还没有匹配的作品。去工作区生成第一张吧。</div>
        ) : (
          <div className="columns-1 gap-5 sm:columns-2 lg:columns-3 xl:columns-4">
            {items.map((item) => (
              <article key={item.id} className="group mb-5 break-inside-avoid overflow-hidden rounded-2xl border border-black/5 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-xl dark:border-white/10 dark:bg-white/5">
                <button type="button" onClick={() => setSelected(item)} className="block w-full overflow-hidden bg-gray-100">
                  <img src={item.thumbnail_url} alt={item.prompt_raw} loading="lazy" className="h-auto w-full transition duration-500 group-hover:scale-[1.02]" />
                </button>
                <div className="p-4">
                  <p className="line-clamp-3 text-sm leading-6 text-gray-700 dark:text-gray-200">{item.prompt_raw}</p>
                  <div className="mt-4 flex items-center justify-between text-xs text-gray-400">
                    <span>{item.avatar_snapshot} {item.nickname_snapshot}</span>
                    <span>{new Date(item.created_at).toLocaleDateString('zh-CN')}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      {selected && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-gray-950/80 p-4 backdrop-blur-sm" onClick={() => setSelected(null)}>
          <div className="grid max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-3xl bg-white shadow-2xl lg:grid-cols-[1.35fr_0.65fr] dark:bg-gray-900" onClick={(event) => event.stopPropagation()}>
            <div className="grid min-h-0 place-items-center bg-gray-950">
              <img src={selected.image_url} alt={selected.prompt_raw} className="max-h-[92vh] max-w-full object-contain" />
            </div>
            <div className="flex min-h-0 flex-col p-6">
              <div className="mb-5 flex items-center justify-between">
                <div className="font-semibold text-gray-800 dark:text-white">{selected.avatar_snapshot} {selected.nickname_snapshot}</div>
                <button type="button" onClick={() => setSelected(null)} className="rounded-full bg-gray-100 px-3 py-1.5 text-sm dark:bg-white/10 dark:text-white">关闭</button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="mb-2 text-xs font-bold uppercase tracking-wider text-gray-400">Prompt</div>
                <p className="whitespace-pre-wrap text-sm leading-7 text-gray-700 dark:text-gray-200">{selected.prompt_raw}</p>
                {selected.reference_images.length > 0 && (
                  <>
                    <div className="mb-3 mt-6 text-xs font-bold uppercase tracking-wider text-gray-400">参考图</div>
                    <div className="grid grid-cols-3 gap-2">
                      {selected.reference_images.map((url) => <img key={url} src={url} alt="参考图" className="aspect-square rounded-xl object-cover" />)}
                    </div>
                  </>
                )}
              </div>
              <div className="mt-6 grid grid-cols-2 gap-3">
                <button type="button" onClick={() => navigator.clipboard.writeText(selected.prompt_raw)} className="rounded-xl border border-gray-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:text-white">复制 Prompt</button>
                <button type="button" onClick={() => reuse(selected)} className="rounded-xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white">一键复用</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

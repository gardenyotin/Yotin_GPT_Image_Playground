interface Env {
  GARDEN_API_URL?: string
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api-proxy/')) return Response.json({ detail: '生图接口已迁移至 Garden /api/image-jobs' }, { status: 410 })
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    if (!env.GARDEN_API_URL) return Response.json({ detail: '请配置 GARDEN_API_URL' }, { status: 503 })
    const target = new URL(env.GARDEN_API_URL)
    target.pathname = url.pathname
    target.search = url.search
    try {
      return await fetch(new Request(target, request), { redirect: 'manual' })
    } catch (err) {
      console.warn('Garden 网关请求失败', err)
      return Response.json({ detail: 'Garden 服务暂时不可达，请稍后恢复查询' }, { status: 502 })
    }
  },
}

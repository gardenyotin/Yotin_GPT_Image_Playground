import { useEffect, useState } from 'react'
import { getCapabilities, type GardenCapabilities } from '../lib/gardenImageApi'

export default function GardenCapabilities() {
  const [caps, setCaps] = useState<GardenCapabilities | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    getCapabilities(controller.signal).then((value) => { setCaps(value); setError('') }).catch((err) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      else setError('Garden 服务连接超时')
    }).finally(() => clearTimeout(timer))
    return () => { clearTimeout(timer); controller.abort() }
  }, [revision])
  return (
    <div className="text-xs leading-relaxed text-gray-500 dark:text-gray-400" role="status">
      {error ? `Garden 能力查询失败：${error}` : caps
        ? `Garden · ${caps.provider} · 每次最多 ${caps.max_output_images_per_job} 张 · ${caps.supports_image_input ? `参考图最多 ${caps.supports_multi_image_input ? Math.min(caps.max_total_input_images, caps.max_input_images_per_job) : 1} 张` : '当前不支持参考图'}`
        : '正在查询 Garden 生图能力…'}
      {caps?.supported_params && <span> · 参数：{caps.supported_params.join('、')}</span>}
      <button type="button" className="ml-2 text-blue-600 dark:text-blue-400" onClick={() => setRevision((value) => value + 1)}>刷新能力</button>
    </div>
  )
}

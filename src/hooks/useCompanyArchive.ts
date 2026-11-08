import { useEffect, useRef, useState } from 'react'
import type { CompanyIdentity } from '../lib/companyGallery'
import { archiveTaskToCompanyGallery, getArchivedImageIds } from '../lib/companyGallery'
import { useStore } from '../store'

export function useCompanyArchive(identity: CompanyIdentity | null) {
  const tasks = useStore((state) => state.tasks)
  const running = useRef(new Set<string>())
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!identity) return
    const archived = getArchivedImageIds()
    const pending = tasks.filter((task) =>
      task.status === 'done' &&
      task.outputImages.some((id) => !archived.has(id)) &&
      !running.current.has(task.id),
    )
    for (const task of pending) {
      running.current.add(task.id)
      void archiveTaskToCompanyGallery(task, identity)
        .catch((error) => {
          console.error('archiveTaskToCompanyGallery failed', error)
          useStore.getState().showToast(error instanceof Error ? error.message : '公司画廊归档失败', 'error')
          window.setTimeout(() => setRetryTick((value) => value + 1), 5000)
        })
        .finally(() => running.current.delete(task.id))
    }
  }, [identity, retryTick, tasks])
}

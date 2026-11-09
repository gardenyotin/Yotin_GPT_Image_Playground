import { useEffect, useState } from 'react'
import { getApiErrorMessage } from '../../lib/imageApiShared'
import { readRuntimeEnv } from '../../lib/runtimeEnv'

const API_PREFIX = (readRuntimeEnv(import.meta.env.VITE_GARDEN_API_PREFIX) || '/api').replace(/\/$/, '')

export default function GardenAccount() {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API_PREFIX}/identity`, { credentials: 'include', signal: controller.signal }).then(async (res) => {
      if (!res.ok) return
      const value = await res.json()
      setUser(value.display_name || value.username || '')
    }).catch((err) => { if (!controller.signal.aborted) console.warn('查询 Garden 登录态失败', err) })
    return () => controller.abort()
  }, [])
  return (
    <form className="space-y-3" onSubmit={async (event) => {
      event.preventDefault()
      if (busy) return
      setBusy(true)
      setError('')
      try {
        const response = await fetch(`${API_PREFIX}/auth/${user ? 'logout' : 'login'}`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(user ? {} : { username: name, password }),
          signal: AbortSignal.timeout(15000),
        })
        if (!response.ok) throw new Error(await getApiErrorMessage(response))
        const value = await response.json()
        setUser(user ? '' : value.display_name || value.username || name)
        setPassword('')
      } catch (err) {
        console.warn('Garden 登录操作失败', err)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    }}>
      {user ? <p>已登录 Garden：{user}</p> : <>
        <label className="block">Garden 账号<input required autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-white/[0.06]" /></label>
        <label className="block">密码<input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 block w-full rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-white/[0.06]" /></label>
      </>}
      {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
      <button disabled={busy} type="submit" className="rounded-xl bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{busy ? '请稍候…' : user ? '退出 Garden' : '登录 Garden'}</button>
    </form>
  )
}

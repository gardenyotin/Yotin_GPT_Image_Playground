import { useState } from 'react'
import type { CompanyIdentity } from '../lib/companyGallery'
import { resolveCompanyIdentity, saveCompanyIdentity } from '../lib/companyGallery'

const AVATARS = ['🎨', '🐸', '🦊', '🐼', '🐯', '🐳', '🌻', '🚀', '🍀', '✨', '🧩', '🦄']

interface Props {
  onResolved: (identity: CompanyIdentity) => void
}

export default function CompanyIdentityModal({ onResolved }: Props) {
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState('🎨')
  const [candidates, setCandidates] = useState<CompanyIdentity[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (userId?: string) => {
    setBusy(true)
    setError('')
    try {
      const result = await resolveCompanyIdentity(nickname.trim(), avatar, userId)
      if (result.status === 'ambiguous') {
        setCandidates(result.candidates ?? [])
        return
      }
      if (!result.user) throw new Error('身份设置失败')
      saveCompanyIdentity(result.user)
      onResolved(result.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : '身份设置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-gray-950/55 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-3xl border border-white/20 bg-white p-7 shadow-2xl dark:bg-gray-900">
        <div className="mb-1 text-2xl font-black text-gray-900 dark:text-white">欢迎加入公司画廊</div>
        <p className="mb-6 text-sm leading-6 text-gray-500 dark:text-gray-400">设置一个同事能认出的昵称和 Emoji。无需密码，生成作品会自动署名归档。</p>
        <label className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300">昵称</label>
        <input
          value={nickname}
          onChange={(event) => {
            setNickname(event.target.value)
            setCandidates([])
          }}
          maxLength={32}
          autoFocus
          placeholder="喜欢大家怎么称呼你~"
          className="mb-5 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-gray-900 outline-none focus:border-violet-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
        />
        <div className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">Emoji 头像</div>
        <div className="mb-6 grid grid-cols-6 gap-2">
          {AVATARS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setAvatar(item)
                setCandidates([])
              }}
              className={`aspect-square rounded-xl text-2xl transition ${avatar === item ? 'bg-violet-600 ring-2 ring-violet-300' : 'bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10'}`}
            >
              {item}
            </button>
          ))}
        </div>
        {candidates.length > 0 && (
          <div className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <div className="mb-2 font-semibold">发现多个同名身份，请选择要恢复的记录：</div>
            {candidates.map((candidate, index) => (
              <button key={candidate.id} type="button" onClick={() => submit(candidate.id)} className="mr-2 mt-1 rounded-lg bg-white px-3 py-2 shadow-sm dark:bg-white/10">
                {candidate.avatar} {candidate.nickname} · 记录 {index + 1}
              </button>
            ))}
          </div>
        )}
        {error && <div className="mb-4 text-sm text-red-600">{error}</div>}
        <button
          type="button"
          disabled={busy || !nickname.trim()}
          onClick={() => submit()}
          className="w-full rounded-xl bg-violet-600 px-4 py-3 font-semibold text-white shadow-lg shadow-violet-600/20 transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? '正在设置…' : '进入工作区'}
        </button>
      </div>
    </div>
  )
}

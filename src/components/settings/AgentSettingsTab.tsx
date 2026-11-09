import { createDefaultOpenAIProfile, DEFAULT_RESPONSES_MODEL } from '../../lib/apiProfiles'
import {
  DEFAULT_AGENT_MAX_TOOL_ROUNDS,
  type AgentApiConfigMode,
  type ApiProfile,
  type AppSettings,
} from '../../types'
import { normalizeAgentMaxToolRounds } from '../../lib/apiProfiles'
import { isPresetAgentFieldLocked } from '../../lib/presetConfig'
import Select from '../Select'
import { createUuid } from '../../lib/uuid'

interface SelectOption {
  label: string
  value: string
}

interface AgentSettingsTabProps {
  draft: AppSettings
  agentMaxToolRoundsInput: string
  agentTextProfileOptions: SelectOption[]
  agentImageProfileOptions: SelectOption[]
  selectedAgentTextProfile: ApiProfile | null
  selectedAgentImageProfile: ApiProfile | null
  setAgentMaxToolRoundsInput: (value: string) => void
  updateAgentApiConfigMode: (mode: AgentApiConfigMode) => void
  commitSettings: (nextDraft: AppSettings) => void
  commitAgentMaxToolRounds: () => void
}

export default function AgentSettingsTab({
  draft,
  agentMaxToolRoundsInput,
  agentTextProfileOptions,
  agentImageProfileOptions,
  selectedAgentTextProfile,
  selectedAgentImageProfile,
  setAgentMaxToolRoundsInput,
  updateAgentApiConfigMode,
  commitSettings,
  commitAgentMaxToolRounds,
}: AgentSettingsTabProps) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">Agent 通过文本模型规划任务，所有单图和批量生图都由 Garden 执行。</p>
      <label className="block">
        <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">Agent 文本模型配置（Responses API）</span>
        <Select value={draft.agentTextProfileId ?? ''} onChange={(value) => commitSettings({ ...draft, agentApiConfigMode: 'native', agentTextProfileId: String(value) })} options={agentTextProfileOptions} className="w-full rounded-xl bg-black/[0.04] px-3 py-2.5 dark:bg-white/[0.06]" />
      </label>
      <button type="button" className="text-sm text-blue-600" onClick={() => {
        const profile = createDefaultOpenAIProfile({ id: createUuid(), name: 'Agent 文本对话', apiMode: 'responses', baseUrl: '', apiKey: '', model: DEFAULT_RESPONSES_MODEL, apiProxy: false })
        commitSettings({ ...draft, profiles: [...draft.profiles, profile], agentApiConfigMode: 'native', agentTextProfileId: profile.id })
      }}>添加文本配置</button>
      {selectedAgentTextProfile && (['baseUrl', 'apiKey', 'model'] as const).map((key) => (
        <label className="block" key={key}>
          <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">{key === 'baseUrl' ? '文本 API URL' : key === 'apiKey' ? '文本 API Key' : '文本模型 ID'}</span>
          <input value={selectedAgentTextProfile[key]} type={key === 'apiKey' ? 'password' : 'text'} autoComplete="off" onChange={(e) => commitSettings({ ...draft, profiles: draft.profiles.map((profile) => profile.id === selectedAgentTextProfile.id ? { ...profile, [key]: e.target.value } : profile) })} className="w-full rounded-xl bg-black/[0.04] px-3 py-2.5 dark:bg-white/[0.06]" />
        </label>
      ))}
      <label className="block">
        <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">最大工具调用轮数</span>
        <input
          value={agentMaxToolRoundsInput}
          onChange={(e) => setAgentMaxToolRoundsInput(e.target.value)}
          onBlur={commitAgentMaxToolRounds}
          type="number"
          min={1}
          max={50}
          className="w-full rounded-xl border border-transparent bg-black/[0.04] px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200 dark:focus:border-blue-500/50"
        />
        <div data-selectable-text className="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-500">
          默认 15。用于限制 Agent 连续调用工具时的最大轮数，防止无限循环。
        </div>
      </label>
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">网络搜索</span>
          <button
            type="button"
            onClick={() => {
              const agentMaxToolRounds = agentMaxToolRoundsInput.trim() === ''
                ? DEFAULT_AGENT_MAX_TOOL_ROUNDS
                : normalizeAgentMaxToolRounds(agentMaxToolRoundsInput, draft.agentMaxToolRounds)
              setAgentMaxToolRoundsInput(String(agentMaxToolRounds))
              commitSettings({ ...draft, agentMaxToolRounds, agentWebSearch: !draft.agentWebSearch })
            }}
            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${draft.agentWebSearch ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.agentWebSearch}
            aria-label="网络搜索"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.agentWebSearch ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          启用 Responses API 的 <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] dark:bg-white/[0.06]">web_search</code> 工具。模型每次调用此工具会产生少量固定价格的额外计费。
        </div>
      </div>
    </div>
  )
}

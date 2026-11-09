import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, normalizeSettings } from './apiProfiles'
import { callImageApi } from './api'
import { callGardenImageApi } from './gardenImageApi'

vi.mock('./gardenImageApi', () => ({ callGardenImageApi: vi.fn(async () => ({ images: ['garden'] })) }))
afterEach(() => vi.clearAllMocks())

describe('统一生图入口', () => {
  it.each(['garden', 'openai', 'google', 'xai', 'fal', 'custom-example'])('历史 %s 配置全部请求 Garden，原始提示词保持不变', async (provider) => {
    const profile = createDefaultOpenAIProfile({ provider, apiKey: '不应发送的旧密钥', baseUrl: 'https://unused.invalid', model: 'unused' })
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id, imagePromptHints: true })
    const prompt = '  原始提示词\n一只猫  '
    const result = await callImageApi({ settings, prompt, params: DEFAULT_PARAMS, inputImageDataUrls: [] })
    expect(result.images).toEqual(['garden'])
    expect(callGardenImageApi).toHaveBeenCalledOnce()
    expect(vi.mocked(callGardenImageApi).mock.calls[0][0].prompt).toBe(prompt)
  })
})

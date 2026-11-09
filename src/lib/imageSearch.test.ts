import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type CustomProviderDefinition } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { callImageApi } from './api'
import { getImageSearchSupport, getImageThinkingSupport, parseImageSearchGrounding } from './imageSearch'
import { normalizeParamsForSettings } from './paramCompatibility'

afterEach(() => vi.restoreAllMocks())

const provider: CustomProviderDefinition = {
  id: 'custom-example', name: 'Example',
  submit: { path: 'images/generations', body: { prompt: '$prompt', search: '$params.google_search', image_search: '$params.image_search' }, result: { b64JsonPaths: ['data.*.b64_json'] } },
  modelOverrides: [{ models: ['gemini-lite-*'], submit: { path: 'images/generations', body: { prompt: '$prompt' } } }],
}

describe('图像搜索', () => {
  it.each([
    ['gemini-3.1-flash-image', ['minimal', 'high']],
    ['gemini-3.1-flash-lite-image', ['minimal', 'high']],
    ['gemini-nano-banana-2.1', ['minimal', 'medium', 'high']],
    ['gemini-3-pro-image', []],
    ['gemini-2.5-flash-image', []],
  ])('按图像模型提供思考等级：%s', (model, levels) => {
    expect(getImageThinkingSupport(createDefaultOpenAIProfile({ provider: 'google', model })).levels).toEqual(levels)
  })

  it.each([
    ['gemini-3-pro-image', true, false],
    ['gemini-3.1-flash-image', true, true],
    ['gemini-3.1-flash-image-preview', true, true],
    ['gemini-nano-banana-2.1', true, true],
    ['gemini-3.1-flash-lite-image', false, false],
    ['gemini-2.5-flash-image', false, false],
  ])('按模型判断搜索能力：%s', (model, web, image) => {
    const support = getImageSearchSupport(createDefaultOpenAIProfile({ provider: 'google', model }))
    expect(!support.googleSearch).toBe(web)
    expect(!support.imageSearch).toBe(image)
  })

  it('兼容接口没有统一搜索字段，自定义接口按模型映射判断', () => {
    const profile = createDefaultOpenAIProfile({ model: 'gemini-3.1-flash-image' })
    expect(getImageSearchSupport(profile).googleSearch).toContain('映射')
    expect(getImageSearchSupport({ ...profile, provider: provider.id }, provider)).toEqual({ googleSearch: undefined, imageSearch: undefined })
    expect(getImageSearchSupport({ ...profile, provider: provider.id, model: 'gemini-lite-image' }, provider).imageSearch).toContain('未映射')
  })




  it('清洗搜索来源，忽略非网页链接并去重', () => {
    expect(parseImageSearchGrounding({ groundingChunks: [null, { web: { uri: 'javascript:alert(1)' } }, { web: { uri: 'https://example.com', title: 'Example' } }, { image: { sourceUri: 'https://example.com', title: 'Example' } }] })).toEqual({ sources: [{ uri: 'https://example.com', title: 'Example' }] })
    expect(parseImageSearchGrounding({ groundingChunks: [{ image: { sourceUri: 'https://example.com/a', imageUri: 'http://example.com/a.png', title: 'A', domain: 'example.com' } }] })).toEqual({ sources: [{ uri: 'https://example.com/a', title: 'A', domain: 'example.com' }] })
    expect(parseImageSearchGrounding(null)).toBeUndefined()
  })

  it('切换到不支持的模型时清除搜索参数', () => {
    const profile = createDefaultOpenAIProfile({ provider: 'google', model: 'gemini-3.1-flash-lite-image' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, google_search: true, image_search: true }, settings)).toMatchObject({ google_search: undefined, image_search: undefined })
  })

})

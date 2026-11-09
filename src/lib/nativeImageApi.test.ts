import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile, type CustomProviderDefinition } from '../types'
import { callImageApi } from './api'
import { createDefaultOpenAIProfile, createSettingsForApiProfile, DEFAULT_SETTINGS, getActiveApiProfile, importCustomProviderSettingsFromJson, normalizeSettings, resolveApiProfileModel, switchApiProfileProvider } from './apiProfiles'
import { OPENAI_IMAGE_TASK_PROVIDER } from './imageProviderMappings'
import { getImageModelFamily } from './imageModels'
import { getImageModelOptions } from './imageModelParams'
import { customProviderSupportsNativeTransparentBackground } from './customProviderCapabilities'
import { normalizeParamsForSettings } from './paramCompatibility'
import { prepareSettingsForCommit } from './settingsActions'

const EXAMPLE_PROVIDER: CustomProviderDefinition = {
  id: 'custom-example',
  name: 'Example',
  submit: {
    path: 'generateTask/{model}',
    body: { request_type: 'async', input: { mode: '$mode', prompt: '$prompt', aspect_ratio: '$params.aspect_ratio', resolution: '$resolution.lower', image_urls: '$inputImages.urls' } },
    taskIdPath: 'data.taskId',
  },
  poll: {
    path: 'statusTask/{model}', query: { taskId: '{task_id}' }, intervalSeconds: 5,
    statusPath: 'data.state', successValues: ['success'], failureValues: ['failed'], errorPath: 'data.failMsg',
    result: { imageUrlPaths: ['data.resultJson.resultUrls.*'] },
  },
  modelOverrides: [{
    models: ['grok-*'],
    submit: {
      path: 'generateTask/{model}',
      body: { request_type: 'async', input: { mode: '$mode', prompt: '$prompt', aspect_ratio: '$params.aspect_ratio', image_urls: '$inputImages.urls' } },
      taskIdPath: 'data.taskId',
    },
  }],
}

const EXAMPLE_CONFIG = {
  customProviders: [EXAMPLE_PROVIDER],
  profiles: [createDefaultOpenAIProfile({ provider: 'custom-example', baseUrl: 'https://api.example.com/api/v1', model: 'gemini-example-image, grok-imagine-image-2.0' })],
}

const PNG = 'data:image/png;base64,aW1hZ2U='

function settings(profile: Partial<ApiProfile>, customProviders: CustomProviderDefinition[] = []) {
  const item = createDefaultOpenAIProfile({ baseUrl: 'https://example.com/v1', apiKey: 'test-key', ...profile })
  return normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [item], activeProfileId: item.id, customProviders })
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('图像模型配置和参数', () => {
  it('临时复用其他配置中的模型时，按实际模型保留比例和分辨率', () => {
    const original = createDefaultOpenAIProfile({ id: 'original', model: 'gpt-image-2.6' })
    const mixed = createDefaultOpenAIProfile({ id: 'mixed', model: 'gpt-image-2.6, gemini-example-image', selectedModel: 'gpt-image-2.6', codexCli: true })
    const config = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [original, mixed], activeProfileId: original.id })
    const reused = resolveApiProfileModel(mixed, 'gemini-example-image')
    const effective = createSettingsForApiProfile(config, reused)
    expect(getActiveApiProfile(effective)).toMatchObject({ id: 'mixed', model: 'gemini-example-image', codexCli: false })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, aspect_ratio: '16:9', resolution: '4K' }, effective)).toMatchObject({ aspect_ratio: '16:9', resolution: '4K' })
    expect(config.activeProfileId).toBe('original')
    expect(config.profiles[1]).toMatchObject({ selectedModel: 'gpt-image-2.6', codexCli: true })
  })

  it.each([false, true])('混合模型的透明背景能力互不影响，GPT 映射位于覆盖项：%s', (override) => {
    const withBackground = { path: 'images/generations', body: { background: '$params.background' } }
    const withoutBackground = { path: 'images/generations', body: { prompt: '$prompt' } }
    const provider: CustomProviderDefinition = {
      id: 'custom-example', name: 'Example',
      submit: override ? withoutBackground : withBackground,
      modelOverrides: [{ models: override ? ['gpt-*'] : ['gemini-*', 'example-*'], submit: override ? withBackground : withoutBackground }],
    }
    const config = settings({ provider: provider.id, model: 'gpt-image-2.6, gemini-example-image, example-image', selectedModel: 'gemini-example-image', transparentBackgroundMethod: 'api' }, [provider])
    expect(customProviderSupportsNativeTransparentBackground(provider)).toBe(true)
    expect(customProviderSupportsNativeTransparentBackground(provider, 'gpt-image-2.6')).toBe(true)
    expect(customProviderSupportsNativeTransparentBackground(provider, 'example-image')).toBe(false)
    const restored = normalizeSettings(JSON.parse(JSON.stringify(config)))
    expect(restored.profiles[0].transparentBackgroundMethod).toBe('api')
    expect(getActiveApiProfile(restored).transparentBackgroundMethod).toBe('local')
    expect(resolveApiProfileModel(restored.profiles[0], undefined, provider).transparentBackgroundMethod).toBe('local')
    for (const [model, method] of [['gpt-image-2.6', 'api'], ['example-image', 'local']]) {
      const selected = normalizeSettings({ ...restored, profiles: [{ ...restored.profiles[0], selectedModel: model }] })
      expect(getActiveApiProfile(selected).transparentBackgroundMethod).toBe(method)
      expect(selected.profiles[0].transparentBackgroundMethod).toBe('api')
    }
  })

  it('Flash Lite 只提供 1K 和常规比例，Flash 保留 512 与扩展比例', () => {
    const lite = createDefaultOpenAIProfile({ provider: 'google', model: 'gemini-3.1-flash-lite-image' })
    const options = getImageModelOptions(lite)
    expect(options.resolutions).toEqual(['1K'])
    for (const ratio of ['1:4', '4:1', '1:8', '8:1']) expect(options.ratios).not.toContain(ratio)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, aspect_ratio: '1:8', resolution: '512' }, settings(lite))).toMatchObject({ aspect_ratio: 'auto', resolution: '1K' })
    const flash = getImageModelOptions({ ...lite, model: 'gemini-3.1-flash-image' })
    expect(flash.resolutions).toContain('512')
    expect(flash.ratios).toContain('1:8')
  })

  it.each(['google/gemini-3.1-flash-image-2K', 'gemini-nano-banana-example', 'nano-banana-2-1'])('识别 Gemini 模型 %s', (model) => {
    expect(getImageModelFamily(createDefaultOpenAIProfile({ model }))).toBe('gemini')
  })

  it.each(['grok-imagine-image-2.0', 'xai/grok-2-image', 'grok-imagine-1.5-example', 'grok-imagine-image'])('识别 Grok 模型 %s', (model) => {
    expect(getImageModelFamily(createDefaultOpenAIProfile({ model }))).toBe('grok')
  })

  it('不把文本和视频模型识别成图片模型', () => {
    for (const model of ['gemini-3-pro', 'grok-4', 'grok-imagine-video', 'gpt-image-2.6']) {
      expect(getImageModelFamily(createDefaultOpenAIProfile({ model }))).toBeNull()
    }
  })

  it('混合模型配置按选中的 ID 切换，恢复后保留选择', () => {
    const config = settings({ model: 'gpt-image-2.6, gemini-3.1-flash-image, grok-imagine-image-2.0', selectedModel: 'gemini-3.1-flash-image' })
    const restored = normalizeSettings(JSON.parse(JSON.stringify(config)))
    expect(getImageModelFamily(getActiveApiProfile(restored))).toBe('gemini')
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 4, quality: 'max', output_format: 'gif', aspect_ratio: '16:9', resolution: '4K' }, restored)
    expect(params).toMatchObject({ n: 4, quality: 'auto', output_format: 'png', aspect_ratio: '16:9', resolution: '4K' })
    const grok = settings({ model: 'grok-imagine-image-2.0' })
    expect(normalizeParamsForSettings(params, grok)).toMatchObject({ resolution: '1K', quality: 'auto' })
    const gpt = settings({ model: 'gpt-image-2.6' })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'max', n: 4 }, gpt)).toMatchObject({ quality: 'max', n: 4 })
  })

  it.each(['google', 'xai'])('官方服务商 %s 可以切换、导出和恢复', (provider) => {
    const profile = switchApiProfileProvider(createDefaultOpenAIProfile(), provider)
    const config = prepareSettingsForCommit(settings(profile))
    const restored = importCustomProviderSettingsFromJson(JSON.stringify({ profiles: config.profiles, customProviders: [] }))
    expect(restored.profiles[0]).toMatchObject({ provider, model: profile.model, baseUrl: profile.baseUrl, transparentBackgroundMethod: 'local', apiMode: 'images' })
  })

  it.each([
    ['https://example.com/v1beta', 'https://example.com/v1beta'],
    ['https://example.com/v1beta/models', 'https://example.com/v1beta'],
    ['https://example.com/proxy', 'https://example.com/proxy/v1beta'],
    ['https://example.com/proxy/', 'https://example.com/proxy/'],
  ])('Google 地址按 v1beta 补齐前缀：%s', (baseUrl, expected) => {
    const config = prepareSettingsForCommit(settings({ provider: 'google', baseUrl, model: 'gemini-3.1-flash-image' }))
    expect(config.baseUrl).toBe(expected)
  })

  it.each(['gemini-example-image', 'grok-imagine-image-2.0'])('混合模型配置中的 %s 忽略 Codex CLI 开关，切回 GPT 时保留', (model) => {
    const config = settings({ model: `gpt-image-2.6, ${model}`, selectedModel: model, codexCli: true })
    expect(getActiveApiProfile(config).codexCli).toBe(false)
    expect(config.profiles[0].codexCli).toBe(true)
    const restored = normalizeSettings({ ...config, profiles: [{ ...config.profiles[0], selectedModel: 'gpt-image-2.6' }] })
    expect(getActiveApiProfile(restored).codexCli).toBe(true)
  })

})
